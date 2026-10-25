#!/usr/bin/env python3
"""Local AMD AI lab. Host-side orchestration uses Python's standard library."""
import argparse
import datetime
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[3]
ENGINE_ROOT = Path(__file__).resolve().parent
PAITON = ENGINE_ROOT / "upstream"
PROFILES = json.loads((ENGINE_ROOT / "config/profiles.json").read_text())
ENV = dict(os.environ)
ENV.update({
    "HF_HOME": str(ROOT / "workspace/data/huggingface"),
    "PAITON_TARGET_DIR": str(ROOT / "workspace/data/llm/paiton/models/qwen38-nvfp4"),
    "PAITON_DRAFT_DIR": str(ROOT / "workspace/data/llm/paiton/models/qwen38-dflash2"),
    "PAITON_W3ROT_DIR": str(ROOT / "workspace/data/llm/paiton/models/qwen38-w3rot"),
    "PAITON_CACHE_DIR": str(ROOT / "workspace/data/llm/paiton/runtime/qwen38"),
    "PAITON_OUTPUTS": str(ROOT / "workspace/outputs/image/flux2"),
    "PAITON_H3_REFERENCE_NODES": str(ROOT / "platforms/comfyui/worker_nodes/h3_references"),
    "PAITON_H3_NODES": str(ROOT / "platforms/comfyui/worker_nodes/h3_packs"),
    "PAITON_H3_DATA": str(ROOT / "workspace/data/video/minimax-h3"),
    "PAITON_H3_OUTPUTS": str(ROOT / "workspace/outputs/video/minimax-h3"),
    "PAITON_COMFY_NODES": str(ROOT / "platforms/comfyui/custom_nodes"),
    "HF_HUB_DISABLE_TELEMETRY": "1",
})
LOCAL_MODELS_PATH = ROOT / "engines/llm/pation-model-qwen38-27b-w3a4/config/local-models.json"
LOCAL_MODELS = json.loads(LOCAL_MODELS_PATH.read_text()) if LOCAL_MODELS_PATH.exists() else {}
MODEL_VARIABLES = {"PAITON_TARGET_DIR", "PAITON_DRAFT_DIR", "PAITON_W3ROT_DIR"}
if set(LOCAL_MODELS) - MODEL_VARIABLES:
    raise RuntimeError("engines/llm/pation-model-qwen38-27b-w3a4/config/local-models.json 包含不支持的模型路径变量")
ENV.update(LOCAL_MODELS)
RUNTIME_CONFIG=ROOT/'.workbench/runtime/rocm101/active.json'
RUNTIMES=json.loads(RUNTIME_CONFIG.read_text()) if RUNTIME_CONFIG.exists() else {}


def check_local_model(variable):
    path = Path(ENV[variable])
    if not path.is_absolute() or not path.is_dir():
        raise RuntimeError(f"本地模型目录不可用：{path}。请挂载资源盘或更新 engines/llm/pation-model-qwen38-27b-w3a4/config/local-models.json。")
    required = ["config.json"]
    if variable == "PAITON_TARGET_DIR":
        required += ["tokenizer.json", "model.safetensors.index.json"]
    elif variable == "PAITON_W3ROT_DIR":
        required += ["w3rot-index.json", "w3rot-manifest.json", "SHA256SUMS"]
    if any(not (path / name).is_file() for name in required) or not any(path.glob("*.safetensors")):
        raise RuntimeError(f"本地模型文件不完整：{path}")
    index_name = "w3rot-index.json" if variable == "PAITON_W3ROT_DIR" else "model.safetensors.index.json"
    if (path / index_name).is_file():
        index = json.loads((path / index_name).read_text())
        for filename in set(index.get("weight_map", {}).values()):
            file = path / filename
            if not file.is_file() or file.stat().st_size == 0:
                raise RuntimeError(f"本地模型索引引用的权重缺失：{file}")
    return path


def run(command, **kwargs):
    print("+", " ".join(map(str, command)), flush=True)
    cwd = kwargs.pop("cwd", ROOT)
    return subprocess.run(list(map(str, command)), check=True, cwd=cwd, env=ENV, **kwargs)


def require_docker():
    if not shutil.which("docker"):
        raise RuntimeError("缺少 Docker：先执行 ./lab install-host 并重新登录。")
    run(["docker", "info"], stdout=subprocess.DEVNULL)
    if not Path("/dev/kfd").exists():
        raise RuntimeError("当前环境缺少 /dev/kfd；请在宿主机终端运行。")


def model_env(profile):
    if profile in ("llm", "llm-fast", "llm-throughput"):
        ENV["PAITON_SERVED_MODEL_NAME"] = PROFILES[profile].get("served_model_name", "Qwen3.8")
        if 'llm' in RUNTIMES:
            ENV['PAITON_FEATURE_IMAGE']=RUNTIMES['llm']['target']
            ENV['PAITON_FEATURE_BASE_IMAGE']='ghcr.io/eliovp/paiton-vllm-plugin:qwen38-rocm10-vllm029-20261005-r1@sha256:245c71d54f046f89b74dbfbd4c894003754561e55c9d215a8d3ce65364fb0f80'
    if profile=='image' and all(name in RUNTIMES for name in ['flux2','flux2-tools','flux2-comfyui']):
        for key,name in [('PAITON_IMAGE','flux2'),('PAITON_TOOLS_IMAGE','flux2-tools'),('PAITON_COMFYUI_IMAGE','flux2-comfyui')]:
            ENV[key]=RUNTIMES[name]['target']
        ENV['PAITON_SKIP_PULL']='1'
    if profile=='video-audio' and 'minimax-h3' in RUNTIMES:
        ENV['PAITON_H3_BASE_IMAGE']=RUNTIMES['minimax-h3']['target']
        ENV['PAITON_H3_IMAGE']='local-ai/pation-minimax-h3-comfyui-rocm101:20261011'
    if profile == "image":
        ENV["PAITON_CACHE"] = str(ROOT / "workspace/data/image/flux2")
        ENV["PAITON_UI_PORT"] = "8189"
    elif profile == "image-hq":
        ENV["PAITON_CACHE"] = str(ROOT / "workspace/data/image/qwen-image")
        ENV["PAITON_OUTPUTS"] = str(ROOT / "workspace/outputs/image/qwen-image")
    for key, value in ENV.items():
        if key.startswith("PAITON_") and (key.endswith("DIR") or key.endswith("DATA") or key.endswith("OUTPUTS") or key == "PAITON_CACHE"):
            if key in LOCAL_MODELS:
                continue
            Path(value).mkdir(parents=True, exist_ok=True)


def active_containers(profiles=None):
    result = run(["docker", "ps", "--format", "{{.Names}}|{{.Label \"com.docker.compose.project\"}}"], capture_output=True, text=True)
    selected = PROFILES.values() if profiles is None else [PROFILES[name] for name in profiles]
    selected = list(selected)
    names = {p.get("container") for p in selected}
    if profiles is None:
        names.update({"ai-vbench"})
    projects = {p.get("compose") for p in selected}
    return [line.split("|")[0] for line in result.stdout.splitlines()
            if line.split("|")[0] in names or line.split("|")[1] in projects]


def require_idle():
    active = active_containers()
    if 'paiton-qwen38' in active:
        sys.path.insert(0,str(ROOT/'platforms/scheduler'))
        import residency
        if residency.sleeping():active.remove('paiton-qwen38')
    if active:
        raise RuntimeError("单卡服务正在运行：" + ", ".join(active) + "。先执行 ./lab stop，再切换或做离线测速。")


def current_model():
    with urlopen("http://127.0.0.1:18982/v1/models", timeout=10) as response:
        return json.load(response)["data"][0]["id"]


def tools_python():
    path = ROOT / ".workbench/envs/tools/bin/python"
    if not (ROOT / ".workbench/envs/tools/bin/hf").exists():
        raise RuntimeError("先运行 ./lab setup-tools。")
    return path


def snapshot(folder):
    folder.mkdir(parents=True, exist_ok=True)
    info = {"created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "platform": platform.platform(), "sources": json.loads((ROOT / ".workbench/sources.lock.json").read_text())}
    run(["docker", "version"], stdout=(folder / "docker-version.txt").open("w"))
    run(["docker", "ps", "--no-trunc"], stdout=(folder / "containers.txt").open("w"))
    gpu = {}
    for device in Path("/sys/class/drm").glob("card*/device"):
        for name in ("device", "mem_info_vram_total", "mem_info_vram_used", "gpu_busy_percent", "power_dpm_force_performance_level"):
            try:
                gpu[str(device / name)] = (device / name).read_text().strip()
            except OSError:
                pass
    info["gpu"] = gpu
    (folder / "manifest.json").write_text(json.dumps(info, indent=2))


def main():
    parser = argparse.ArgumentParser(description="本地推理 / 图像 / 视频 / 评测工作台")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("doctor")
    sub.add_parser("bootstrap", help="恢复已锁定的官方源码，保留已有修改")
    sub.add_parser("setup-tools", help="安装独立的 HF 下载及 EleutherAI API 评测环境")
    fetch = sub.add_parser("fetch", help="下载锁定版本的 Qwen 文本模型")
    fetch.add_argument("--fast", action="store_true", help="同时下载可选 3-bit 权重")
    start = sub.add_parser("start")
    start.add_argument("profile", choices=PROFILES)
    start.add_argument("extra", nargs=argparse.REMAINDER, help="附加上游启动参数")
    stop = sub.add_parser("stop", help="停止本项目的模型容器，保留缓存")
    stop.add_argument("--profile", choices=PROFILES)
    status = sub.add_parser("status")
    status.add_argument("--profile", choices=PROFILES)
    bench = sub.add_parser("bench")
    bench.add_argument("kind", choices=["llm", "image", "video-audio"])
    bench.add_argument("--engine", choices=["stock", "paiton"], default="paiton")
    bench.add_argument("--num-prompts", type=int, default=32)
    quality = sub.add_parser("eval-llm")
    quality.add_argument("--tasks", default="gsm8k_cot")
    quality.add_argument("--limit", type=int, help="仅冒烟检查；省略时跑完整数据集")
    quality.add_argument("--concurrency", type=int, default=1)
    gen = sub.add_parser("geneval-export", help="用 Qwen-Image API 按 GenEval 官方格式生成评测样本")
    gen.add_argument("--limit", type=int)
    gen.add_argument("--samples", type=int, default=4)
    gen.add_argument("--size", choices=[1024, 2048], type=int, default=1024)
    args = parser.parse_args()

    if args.command == "bootstrap":
        run([sys.executable, ROOT / ".workbench/scripts/bootstrap.py"])
    elif args.command == "doctor":
        checks = {"Docker executable": bool(shutil.which("docker")),
                  "GPU /dev/kfd": Path("/dev/kfd").exists(), "GPU /dev/dri": Path("/dev/dri").is_dir(),
                  "official sources": all((ROOT / info.get("path", ".workbench/vendor/" + name) / ".git").exists() for name, info in json.loads((ROOT / ".workbench/sources.lock.json").read_text()).items()),
                  "HF / evaluation environment": (ROOT / ".workbench/envs/tools/bin/hf").exists()}
        if checks["Docker executable"]:
            checks["Docker daemon / permission"] = subprocess.run(["docker", "info"], capture_output=True).returncode == 0
            checks["Compose v2"] = subprocess.run(["docker", "compose", "version"], capture_output=True).returncode == 0
        for name, value in checks.items():
            print(f'{"OK" if value else "MISSING"}: {name}')
        for variable in LOCAL_MODELS:
            try:
                print(f"LOCAL: {variable}={check_local_model(variable)}")
            except RuntimeError as error:
                checks[variable] = False
                print(f"MISSING: {error}")
        print(f"项目磁盘可用：{shutil.disk_usage(ROOT).free / 2**30:.1f} GiB")
        return 0 if all(checks.values()) else 1
    elif args.command == "setup-tools":
        run([sys.executable, "-m", "venv", ROOT / ".workbench/envs/tools"])
        py = ROOT / ".workbench/envs/tools/bin/python"
        run([py, "-m", "pip", "install", "huggingface_hub==0.35.3", str(ROOT / ".workbench/vendor/lm-evaluation-harness") + "[api]"])
        with (ROOT / ".workbench/tools.resolved.txt").open("w") as out:
            run([py, "-m", "pip", "freeze"], stdout=out)
    elif args.command == "fetch":
        downloads = [("unsloth/Qwen3.8-27B-NVFP4", "f0b7c9e722f5565102fff8481c99e4d86ae099c7", "PAITON_TARGET_DIR"),
                     ("tcclaviger/Qwen3.8-27B-DFlash2-FP8", "ee0cb26a8279b7910cc28d82a8a3e15e4728d56f", "PAITON_DRAFT_DIR")]
        if args.fast:
            downloads.append(("EliovpAI/Qwen3.8-27B-W3Rot-INT3-Paiton-RDNA4", "7a2e3d702144f744c1c5a46eaa42c7a2309d5cf7", "PAITON_W3ROT_DIR"))
        for repo, revision, variable in downloads:
            if variable in LOCAL_MODELS:
                print(f"复用本地模型：{check_local_model(variable)}（跳过下载）")
                continue
            tools_python()
            run([ROOT / ".workbench/envs/tools/bin/hf", "download", repo, "--revision", revision, "--local-dir", ENV[variable]])
        if args.fast:
            run(["sha256sum", "-c", "SHA256SUMS"], cwd=ENV["PAITON_W3ROT_DIR"])
    elif args.command in ("start", "stop", "status", "bench"):
        require_docker()
        if args.command == "stop":
            active = active_containers([args.profile] if args.profile else None)
            if active:
                run(["docker", "stop", *active])
            if args.profile in (None, 'llm', 'llm-fast', 'llm-throughput'):
                # Sleep-enabled workers retain failed logs instead of using --rm.
                retained=run(['docker','ps','-a','--filter','name=^/paiton-qwen38$','--filter','label=ai.workbench.resident=true','--format','{{.Names}}'],capture_output=True,text=True).stdout.splitlines()
                if retained:run(['docker','rm',*retained])
        elif args.command == "status":
            print("\n".join(active_containers([args.profile] if args.profile else None)) or "没有本项目的服务在运行")
        elif args.command == "start":
            if args.profile in ("llm", "llm-fast", "llm-throughput"):
                comfy = active_containers(['video-audio'])
                if comfy:
                    try:
                        with urlopen('http://127.0.0.1:8188/queue', timeout=5) as response:
                            queue = json.load(response)
                    except Exception:
                        queue = {}
                    if queue.get('queue_running') or queue.get('queue_pending'):
                        raise RuntimeError('ComfyUI 还有任务在跑，等它结束后再启动 LLM')
                    run(['docker', 'stop', *comfy])
                    print('已停止 ComfyUI，让出 GPU 给 LLM：' + ', '.join(comfy), flush=True)
            require_idle()
            if args.profile=='image-hq':
                extra=args.extra[1:] if args.extra[:1]==['--'] else args.extra
                run([sys.executable,ROOT/'engines/image/pation-model-qwen-image-21/controller.py','start',*extra])
                return 0
            if args.profile in ("llm", "llm-fast", "llm-throughput"):
                variables = ["PAITON_TARGET_DIR", "PAITON_DRAFT_DIR"]
                if args.profile in ("llm-fast", "llm-throughput"):
                    variables.append("PAITON_W3ROT_DIR")
                for variable in variables:
                    if variable in LOCAL_MODELS:
                        check_local_model(variable)
            p = PROFILES[args.profile]
            model_env(args.profile)
            if args.profile == 'image':
                # Only API workers; the public ComfyUI is the sole user workspace.
                cache = Path(ENV['PAITON_CACHE'])
                ENV['PAITON_CACHE_BIND'] = str(cache)
                ENV['PAITON_CACHE_VOLUME'] = 'paiton-flux2-cache'
                ENV['PAITON_RUNTIME_CACHE_BIND'] = str(cache/'cache')
                ENV['PAITON_RUNTIME_CACHE_VOLUME'] = 'paiton-flux2-cache-runtime'
                ENV['PAITON_RENDER_GID'] = str(Path('/dev/kfd').stat().st_gid)
                (cache/'cache').mkdir(parents=True,exist_ok=True)
                package = PAITON/'models'/p['directory']
                run(['bash',package/'run.sh','download'])
                run(['docker','compose','-f',package/'compose.yaml','up','-d','--no-build','paiton','stock'])
                print('FLUX API: 7861/7862; public ComfyUI: 8188')
                return 0
            print("服务地址：", p["url"], flush=True)
            extra = args.extra[1:] if args.extra[:1] == ["--"] else args.extra
            launch_args=list(p['args'])
            if args.profile in ('llm-fast','llm-throughput'):
                policy_file=ROOT/'workspace/data/scheduler/llm-mode.json'
                if policy_file.exists():
                    policy=json.loads(policy_file.read_text()).get('policy',{})
                    context=policy.get('context_tokens');sequences=policy.get('concurrency')
                    if not isinstance(context,int) or not 1024<=context<=262144 or not isinstance(sequences,int) or not 1<=sequences<=8:
                        raise RuntimeError('已保存的上下文或并发配置无效')
                    launch_args+=['--context',str(context),'--max-num-seqs',str(sequences),
                                  '--eager-mode','on' if policy.get('eager',False) else 'off',
                                  '--kv-cache-memory-bytes',str(policy.get('kv_budget_bytes',8859648000 if context<=65536 else 8589934592))]
            if args.profile in ('llm','llm-fast','llm-throughput') and 'llm' in RUNTIMES:
                if '--image' in launch_args:
                    index=launch_args.index('--image');del launch_args[index:index+2]
                launch_args+=['--image',RUNTIMES['llm']['target']]
                if RUNTIMES['llm'].get('cpu_vision'):
                    if '--vision' not in launch_args:
                        launch_args.append('--vision')
                    if args.profile == 'llm-throughput' and '--kv-cache-memory-bytes' not in launch_args:
                        launch_args += ['--kv-cache-memory-bytes', '8859648000']
                    if '--dry-run' not in extra:
                        run([sys.executable, ROOT/'.workbench/runtime/cpu-vision/controller.py', RUNTIMES['llm']['target']])
            residency_file=ROOT/'platforms/scheduler/residency.json'
            residency=json.loads(residency_file.read_text()) if residency_file.exists() else {}
            resident=(args.profile=='llm-fast' and ENV.get('LAB_LLM_RESIDENCY_DISABLE')!='1' and (ENV.get('LAB_LLM_RESIDENCY_TEST')=='1' or residency.get('enabled',False)))
            if resident:
                run([sys.executable,ROOT/'.workbench/scripts/launch-resident-llm.py',
                     PAITON/'models'/p['directory']/'launch-rocm10.py',*launch_args,*extra])
            elif args.profile in ('llm-fast','llm-throughput'):
                run([sys.executable,ROOT/'.workbench/scripts/launch-configured-llm.py',
                     PAITON/'models'/p['directory']/'launch-rocm10.py',*launch_args,*extra])
            else:
                run(["bash", PAITON / "models" / p["directory"] / p["launcher"], *launch_args, *extra])
        else:
            if args.num_prompts <= 0:
                raise RuntimeError("--num-prompts 必须大于零")
            stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            category = "llm" if args.kind == "llm" else ("image" if args.kind == "image" else "video")
            engine_name = {"llm": "paiton", "image": "flux", "video-audio": "minimax-h3"}[args.kind]
            folder = ROOT / "workspace/reports" / category / engine_name / stamp
            snapshot(folder)
            if args.kind == "llm":
                with urlopen("http://127.0.0.1:18982/health", timeout=10) as response:
                    assert response.status == 200
                for concurrency in (1, 2, 4, 8):
                    run(["docker", "exec", "-e", "VLLM_PLUGINS=", "-e", "PAITON_PLUGIN_MODE=off", "-e", "PAITON_W3_A4=0", "paiton-qwen38", "vllm", "bench", "serve",
                         "--backend", "openai-chat", "--base-url", "http://127.0.0.1:18982",
                         "--endpoint", "/v1/chat/completions", "--model", "/models/target", "--served-model-name", current_model(),
                         "--tokenizer", "/models/target", "--dataset-name", "random", "--random-input-len", "1024",
                         "--random-output-len", "256", "--num-prompts", str(args.num_prompts), "--seed", "42",
                         "--request-rate", "inf", "--max-concurrency", str(concurrency),
                         "--extra-body", '{"chat_template_kwargs":{"enable_thinking":false}}',
                         "--save-result", "--result-dir", "/cache/benchmarks/" + stamp,
                         "--result-filename", f"concurrency-{concurrency}.json"])
                shutil.copytree(ROOT / "workspace/data/llm/paiton/runtime/qwen38/benchmarks" / stamp, folder / "results")
            else:
                require_idle()
                model_env({"image": "image", "video-audio": "video-audio"}[args.kind])
                output = f"/outputs/benchmarks/{stamp}-{args.engine}"
                package = {"image": "FLUX.2-klein", "video-audio": "MiniMax-H3"}[args.kind]
                run(["bash", PAITON / "models" / package / "run.sh", "download", "--profile", "turbo8"])
                cmd = ["bash", PAITON / "models" / package / "run.sh", "benchmark"]
                cmd += ["--backend" if args.kind == "image" else "--engine", args.engine, "--output", output]
                if args.kind == "image":
                    cmd += ["--suite"]
                else:
                    cmd += ["--preset", "turbo8", "--frames", "124"]
                run(cmd)
            print("评测元数据：", folder)
    elif args.command == "eval-llm":
        tools_python()
        folder = ROOT / "workspace/reports/evaluation" / ("quality-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ"))
        folder.mkdir(parents=True)
        cmd = [ROOT / ".workbench/envs/tools/bin/lm-eval", "run", "--model", "local-chat-completions",
               "--model_args", f"model={current_model()},base_url=http://127.0.0.1:18982/v1/chat/completions,num_concurrent={args.concurrency},max_retries=3,tokenized_requests=False,tokenizer_backend=None,timeout=600,max_length=65536",
               "--tasks", args.tasks, "--apply_chat_template", "--seed", "42",
               "--gen_kwargs", "temperature=0", "max_gen_toks=4096", "chat_template_kwargs={'enable_thinking':False}",
               "--log_samples", "--output_path", folder]
        if args.limit:
            cmd += ["--limit", str(args.limit)]
        (folder / "protocol.json").write_text(json.dumps(vars(args), indent=2))
        run(cmd)
    else:
        cmd = [sys.executable, ROOT / ".workbench/scripts/geneval_export.py", "--samples", str(args.samples), "--size", str(args.size)]
        if args.limit:
            cmd += ["--limit", str(args.limit)]
        run(cmd)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
