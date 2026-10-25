"""Serialized, bounded image requests using a pinned packed checkpoint."""
import os
os.environ.update(MIOPEN_FIND_MODE="FAST",MIOPEN_DEBUG_CONV_GEMM="0",
                  MIOPEN_ENABLE_LOGGING="0",MIOPEN_LOG_LEVEL="2",
                  HF_HUB_OFFLINE="1",TRANSFORMERS_OFFLINE="1",TORCH_COMPILE_DISABLE="1",
                  PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True")
import fcntl
import io
import json
from pathlib import Path
import threading
import time

PROMPT_MAX_CHARS=4000

def validate_request(prompt, width=2048, height=2048, steps=40, guidance=1.0,
                     seed=42, mode="text-to-image", image=None):
    if not isinstance(prompt,str) or not prompt.strip() or len(prompt)>PROMPT_MAX_CHARS:
        raise ValueError(f"prompt must contain 1 to {PROMPT_MAX_CHARS} characters")
    if type(width) is not int or type(height) is not int or width!=height or width not in (1024,2048):
        raise ValueError("Qualified sizes are 1024x1024 and 2048x2048, batch one")
    if type(steps) is not int or steps!=40 or type(guidance) not in (int,float) or guidance!=1.0:
        raise ValueError("This profile requires 40 steps and guidance 1.0")
    if type(seed) is not int or not 0<=seed<2**63:
        raise ValueError("seed must be an integer in [0, 2**63)")
    if mode not in ("text-to-image","rgba","edit"):
        raise ValueError("mode must be text-to-image, rgba or edit")
    if mode=="edit":
        if image is None or width!=1024:
            raise ValueError("Editing requires 1–4 input images and 1024x1024 output")
        images=image if isinstance(image,list) else [image]
        if not 1<=len(images)<=4:
            raise ValueError("Edit requires 1–4 reference images")
        if sum(item.width*item.height for item in images)>2048*2048:
            raise ValueError("All edit references together are limited to 4,194,304 pixels")
    elif image is not None:
        raise ValueError("Input images are accepted only for edit requests")
    return dict(width=width,height=height,output_resolution=width,num_inference_steps=steps,
                true_cfg_scale=guidance,use_kv_cache=True)

class ImageEngine:
    PRECISION_PROFILES={
        # exact: every step bit-exact against the pinned BF16 framework arithmetic; the wave64 exact attention kernel
        # (bit-exact on the reference suite and end to end) serves the dense and cached-decode attention
        "exact":{"PAITON_IMAGE21_ATTENTION_W64":"1"},
        # exact with the v1.0.1 wave32 attention kernel (fallback / comparison)
        "exact-w32":{},
        # release candidate: cached text prefix + first 7 denoising steps exact; steps 8-40 with int8 activations
        # (per 256-block scales, exact-weight int8 reconstruction) through wave64 int8 GEMMs fed by the fused LayerNorm
        # quantizer, int8-QK + fp8-P/V attention on those steps, wave64 exact attention on the exact steps
        "schedule-int8":{"PAITON_IMAGE21_LP":"int8-256","PAITON_IMAGE21_LP_W64":"1","PAITON_IMAGE21_LP_FROM_STEP":"8",
                         "PAITON_IMAGE21_ATTENTION_QK8":"1","PAITON_IMAGE21_ATTENTION_FULL8":"1","PAITON_IMAGE21_ATTENTION_W64":"1"},
        # the same with ten exact denoising steps and int8-QK-only attention (more headroom, measured 112.7 s)
        "schedule-int8-11":{"PAITON_IMAGE21_LP":"int8-256","PAITON_IMAGE21_LP_W64":"1","PAITON_IMAGE21_LP_FROM_STEP":"11",
                            "PAITON_IMAGE21_ATTENTION_QK8":"1","PAITON_IMAGE21_ATTENTION_W64":"1"},
        # bit-exact fp8 weights with fp8 per-row activations on the eleven-forward schedule (slower GEMMs)
        "schedule-fp8":{"PAITON_IMAGE21_LP":"fp8-row","PAITON_IMAGE21_LP_FROM_STEP":"11","PAITON_IMAGE21_ATTENTION_W64":"1"},
    }
    def __init__(self,model_dir,backend="native",artifact_dir=None,verify=True,native_fusions=False,precision_profile=None):
        if native_fusions and backend != "native":
            raise ValueError("native_fusions requires the native backend")
        precision_profile=precision_profile or os.environ.get("PAITON_IMAGE21_PROFILE") or "exact"
        if precision_profile not in self.PRECISION_PROFILES:
            raise ValueError(f"unknown precision profile {precision_profile!r}")
        if precision_profile != "exact" and not native_fusions:
            raise ValueError("precision profiles other than exact require native fusions")
        for key,value in self.PRECISION_PROFILES[precision_profile].items():
            os.environ.setdefault(key,value)   # explicit environment switches still win (experiments)
        self.precision_profile=precision_profile
        import torch
        from .weights import load_pipeline,enable_native_unpack,sha256
        if backend not in ("native","reference"):
            raise ValueError("backend must be native or reference")
        if not torch.cuda.is_available() or not torch.version.hip:
            raise RuntimeError("This package requires the qualified ROCm environment")
        props=torch.cuda.get_device_properties(0)
        if not props.gcnArchName.startswith("gfx1201"):
            raise RuntimeError("Only Radeon AI PRO R9700 / gfx1201 is qualified")
        self._gpu_lock=open(os.environ.get("PAITON_GPU_LOCK", "/tmp/paiton-studio-gpu-1000.lock"),"a")
        fcntl.flock(self._gpu_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        free,total=torch.cuda.mem_get_info()
        if free<30*2**30:
            raise RuntimeError("The R9700 needs at least 30 GiB free before loading")
        # Leave measured headroom for driver/library allocations outside the allocator.
        torch.cuda.set_per_process_memory_fraction(26*2**30/total)
        torch.set_num_threads(4)
        self.busy=threading.Lock()
        self.model_dir=Path(model_dir).resolve()
        manifest=self.model_dir/"result.json"
        self.checkpoint_sha256=sha256(manifest)
        checkpoint_metadata=json.loads(manifest.read_text())
        self.model_id=checkpoint_metadata.get("model_id","paiton-image-2.1")
        self.model_variant=checkpoint_metadata.get("model_variant","original")
        self.backend=backend
        self.allocator_budget_gib=26
        self.allocator_config="expandable_segments:True"
        self.native_regions=None
        self.native_fusion_status="disabled"
        if backend=="native":
            artifacts=Path(artifact_dir) if artifact_dir else Path(__file__).resolve().parent.parent/"artifacts"
            contract=json.loads((artifacts/"manifest.json").read_text())
            library=artifacts/contract["file"]
            if contract["architecture"]!="gfx1201" or sha256(library)!=contract["sha256"]:
                raise RuntimeError("Native artifact identity mismatch")
            enable_native_unpack(library)
        begin=time.perf_counter()
        self.pipeline=load_pipeline(self.model_dir,self.model_dir,verify_hashes=verify)
        if native_fusions:
            from .native_regions import install
            companions={name:artifacts/name for name in ("attention","attention-w64","attention-qk8","attention-full8","normfuse","gemm-fp8","gemm-int8","gemm-w64","quantize","unpack-fp8") if (artifacts/name/"manifest.json").is_file()}
            if os.environ.get("PAITON_IMAGE21_ATTENTION_W64")=="1" and "attention-w64" in companions:   # wave64 exact attention (bit-exact; the exact profile)
                companions["attention"]=companions["attention-w64"]
            fp8_directories=None
            low_precision=os.environ.get("PAITON_IMAGE21_LP") or ("fp8-row" if os.environ.get("PAITON_IMAGE21_FP8")=="1" else None)
            if low_precision:   # low-precision GEMM path of the precision schedule (selected by the profile switches)
                fp8_directories=dict(gemm_directory=companions.get("gemm-fp8"),quantize_directory=companions["quantize"],
                                     unpack_directory=companions["unpack-fp8"],gemm_int8_directory=companions.get("gemm-int8"),
                                     gemm_w64_directory=companions.get("gemm-w64"),format=low_precision,
                                     wave64=os.environ.get("PAITON_IMAGE21_LP_W64")=="1",
                                     from_step=int(os.environ.get("PAITON_IMAGE21_LP_FROM_STEP","0")),
                                     exact_prefix=os.environ.get("PAITON_IMAGE21_LP_QUANTIZE_PREFIX")!="1")
            qk8_directory=None
            if low_precision and os.environ.get("PAITON_IMAGE21_ATTENTION_QK8")=="1":
                qk8_directory=companions.get("attention-full8" if os.environ.get("PAITON_IMAGE21_ATTENTION_FULL8")=="1" else "attention-qk8")
            self.native_regions=install(self.pipeline.transformer,artifacts/"bf16-regions",
                                        companions.get("attention"),companions.get("normfuse"),fp8_directories,qk8_directory)
            self.native_fusion_status="active" if self.native_regions is not None else "unsupported configuration; original regions retained"
            if self.native_regions is not None:
                active=["bf16-regions"]+[name for name,library in (("attention",self.native_regions.attention_library),
                                                                ("normfuse",self.native_regions.normfuse_library)) if library is not None]
                if self.native_regions.fp8 is not None:
                    active.append(f"low-precision {self.native_regions.fp8.format}{' wave64' if self.native_regions.fp8.wave64 else ''}")
                if getattr(self.native_regions,"qk8_library",None) is not None:
                    active.append(("int8-QK + fp8-PV" if os.environ.get("PAITON_IMAGE21_ATTENTION_FULL8")=="1" else "int8-QK")+" attention on low-precision forwards")
                self.native_fusion_status="active ("+", ".join(active)+")"
        torch.cuda.synchronize()
        self.load_seconds=time.perf_counter()-begin
        self.stream=torch.cuda.Stream()
        self.stream.wait_stream(torch.cuda.current_stream())
        def finite_hook(label):
            def hook(module,inputs,output):
                def tensors(value):
                    if isinstance(value,torch.Tensor):
                        if value.is_floating_point():yield value
                    elif isinstance(value,dict):
                        for item in value.values():yield from tensors(item)
                    elif isinstance(value,(tuple,list)):
                        for item in value:yield from tensors(item)
                for tensor in tensors(output):
                    if not torch.isfinite(tensor).all().item():
                        raise ValueError("NONFINITE_OUTPUT component="+label+" shape="+str(tuple(tensor.shape)))
            return hook
        for label,module in (("text_encoder",self.pipeline.text_encoder),("transformer",self.pipeline.transformer),("vae.decoder",self.pipeline.vae.decoder)):
            module.register_forward_hook(finite_hook(label))
        self.request_count=0
        self._prefix_caches=[]
        def remember_prefix(module,args,kwargs):
            cache=kwargs.get("kv_cache")
            if cache is not None and all(cache is not old for old in self._prefix_caches):
                self._prefix_caches.append(cache)
            fp8=getattr(self.native_regions,"fp8",None) if self.native_regions is not None else None
            if fp8 is not None:
                fp8.begin_transformer_forward()   # precision schedule counts transformer forwards, not block forwards
        self.pipeline.transformer.register_forward_pre_hook(remember_prefix,with_kwargs=True)

    def _release_prefix(self):
        for cache in self._prefix_caches:
            for layer in cache.layer_caches:
                layer.k=layer.v=None
        self._prefix_caches.clear()

    def _prompt_tokens(self,text):
        processor=getattr(self.pipeline,"processor",None)
        template=getattr(self.pipeline,"prompt_template_t2i",None)
        if processor is None or template is None:
            return 0
        ids=processor(text=[template.format(text)],padding=True,return_tensors="pt")["input_ids"]
        return int(ids.shape[1])-getattr(self.pipeline,"_drop_idx",0)

    def generate(self,prompt,width=2048,height=2048,steps=40,guidance=1.0,seed=42,
                 mode="text-to-image",image=None):
        import torch
        settings=validate_request(prompt,width,height,steps,guidance,seed,mode,image)
        actual_prompt=prompt
        if mode=="rgba":
            actual_prompt="This is an RGBA image with transparency. "+prompt+" The image has alpha channel and the background is transparent."
        prompt_tokens=self._prompt_tokens(actual_prompt)
        if not self.busy.acquire(blocking=False):
            raise RuntimeError("The single-request GPU worker is busy")
        started=time.perf_counter()
        if self.native_regions is not None and getattr(self.native_regions,"fp8",None) is not None:
            self.native_regions.fp8.forwards=0   # precision schedule counts transformer forwards per request
        stop=threading.Event()
        samples=[]
        def sample():
            while not stop.is_set():
                free,total=torch.cuda.mem_get_info()
                samples.append(total-free)
                stop.wait(.02)
        monitor=threading.Thread(target=sample,daemon=True)
        try:
            self._release_prefix()
            torch.cuda.reset_peak_memory_stats()
            monitor.start()
            def callback(pipe,step,timestep,values):
                if step==39:
                    self._release_prefix()
                return values
            kwargs={"image":[item.convert("RGBA") for item in image] if isinstance(image,list) else image.convert("RGBA")} if image is not None else {}
            with torch.cuda.stream(self.stream),torch.inference_mode():
                result=self.pipeline(prompt=actual_prompt,**settings,**kwargs,
                    generator=torch.Generator("cuda").manual_seed(seed),callback_on_step_end=callback).images[0]
            self.stream.synchronize()
            seconds=time.perf_counter()-started
            assert result.size==(width,height) and result.mode=="RGBA"
            buffer=io.BytesIO()
            result.save(buffer,format="PNG")
            row=dict(mode=mode,seed=seed,prompt_tokens=prompt_tokens,settings=settings,backend=self.backend,
                     checkpoint_sha256=self.checkpoint_sha256,request_index=self.request_count,
                     complete_request_to_pil_seconds=seconds,complete_request_to_png_seconds=time.perf_counter()-started,
                     peak_allocated_bytes=torch.cuda.max_memory_allocated(),peak_reserved_bytes=torch.cuda.max_memory_reserved(),
                     sampled_peak_device_bytes=max(samples,default=0),sampling_interval_seconds=.02,
                     stream="dedicated non-default HIP stream",alpha_extrema=list(result.getextrema()[3]))
            row["native_fusions"]=self.native_fusion_status
            row["precision_profile"]=self.precision_profile
            row["model"]=self.model_id
            row["model_variant"]=self.model_variant
            row["allocator_budget_gib"]=self.allocator_budget_gib
            row["allocator_config"]=self.allocator_config
            if self.native_regions is not None:
                row["native_fusions_sha256"]=self.native_regions.manifest["sha256"]
                for name,manifest in (("attention",self.native_regions.attention_manifest),("normfuse",self.native_regions.normfuse_manifest)):
                    if manifest is not None:
                        row[f"native_{name}_sha256"]=manifest["sha256"]
                row["native_counts"]=dict(self.native_regions.counts)
                fp8=self.native_regions.fp8
                if fp8 is not None:
                    inexact=fp8.check_exact()
                    row["fp8_gemm"]=dict(inexact_weight_values=inexact,**fp8.receipt())
                    if inexact and not fp8.int8:
                        raise RuntimeError(f"fp8 weight reconstruction was not exact: {inexact} values")
            self.request_count+=1
            return result,buffer.getvalue(),row
        finally:
            stop.set()
            if monitor.is_alive():
                monitor.join(timeout=1)
            self._release_prefix()
            self.busy.release()
