"""CPU-only encoder for the exact checkpoint used by the GPU language model."""
import hashlib
import json
import os
import threading
import time
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from telemetry import Telemetry

import torch
from safetensors import safe_open
from safetensors.torch import load, save
from transformers import AutoConfig
from transformers.models.qwen3_5.modeling_qwen3_5 import Qwen3_5VisionModel

torch.set_num_threads(int(os.getenv("VISION_THREADS", "43")))
torch.set_num_interop_threads(1)
root = Path(os.getenv("VISION_MODEL", "/models/target"))
config = AutoConfig.from_pretrained(root, local_files_only=True).vision_config
config._attn_implementation = "sdpa"
with torch.device("cpu"):
    model = Qwen3_5VisionModel(config).float().eval()
index = json.loads((root / "model.safetensors.index.json").read_text())["weight_map"]
state = {}
for shard in set(index.values()):
    names = [name for name, file in index.items() if file == shard and name.startswith("model.visual.")]
    if not names:
        continue
    with safe_open(root / shard, framework="pt", device="cpu") as weights:
        for name in names:
            state[name.removeprefix("model.visual.")] = weights.get_tensor(name)
model.load_state_dict(state, strict=True)
del state
assert all(p.device.type == "cpu" for p in model.parameters())
lock = threading.Lock()
cache = OrderedDict()
cache_bytes = 0
cache_limit = int(os.getenv("VISION_CACHE_BYTES", str(1024**3)))
calls = hits = 0
telemetry = Telemetry()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/metrics":
            self.respond(telemetry.prometheus(threads=torch.get_num_threads(), cache_bytes=cache_bytes,
                         cache_limit=cache_limit, cache_entries=len(cache)), "text/plain; version=0.0.4")
            return
        if self.path != "/health":
            self.send_error(404)
            return
        self.respond(json.dumps({"ready": True, "device": "cpu", "parameters": sum(p.numel() for p in model.parameters()),
                                 "threads": torch.get_num_threads(), "calls": calls, "hits": hits,
                                 "cache_bytes": cache_bytes}).encode(), "application/json")

    def respond(self, data, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        global cache_bytes, calls, hits
        if self.path != "/encode":
            self.send_error(404)
            return
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 < size <= 256 * 1024**2:
            self.send_error(413)
            return
        raw = self.rfile.read(size)
        key = hashlib.sha256(raw).hexdigest()
        queued_at = time.monotonic()
        telemetry.add(requests=1, inflight=1)
        try:
            with lock, torch.inference_mode():
                telemetry.add(active=1, queue_seconds=time.monotonic()-queued_at)
                try:
                    calls += 1
                    if key in cache:
                        hits += 1
                        telemetry.add(hits=1)
                        result = cache.pop(key)
                        cache[key] = result
                    else:
                        inputs = load(raw)
                        grid = inputs["grid"].to(dtype=torch.int64)
                        pixels = inputs["pixels"].float()
                        if grid.ndim != 2 or grid.shape[1] != 3 or (grid <= 0).any() or int(grid.prod(-1).sum()) != len(pixels):
                            raise ValueError("Invalid image grid")
                        start = time.monotonic()
                        embeddings = model(pixels, grid_thw=grid).pooler_output
                        result = save({"embeddings": embeddings.to(torch.bfloat16).contiguous()})
                        if len(result) <= cache_limit:
                            while cache and cache_bytes + len(result) > cache_limit:
                                _, removed = cache.popitem(last=False)
                                cache_bytes -= len(removed)
                            cache[key] = result
                            cache_bytes += len(result)
                        telemetry.encoded(time.monotonic()-start, len(embeddings))
                        print(json.dumps({"image_tokens": len(embeddings), "seconds": time.monotonic()-start,
                                          "device": "cpu", "cache_bytes": cache_bytes}), flush=True)
                finally:
                    telemetry.add(active=-1)
            self.respond(result, "application/octet-stream")
        except Exception as error:
            telemetry.add(failures=1)
            print(repr(error), flush=True)
            self.send_error(500, "CPU vision encoding failed")
        finally:
            telemetry.add(inflight=-1)


print("CPU vision encoder ready", flush=True)
ThreadingHTTPServer(("127.0.0.1", 18984), Handler).serve_forever()
