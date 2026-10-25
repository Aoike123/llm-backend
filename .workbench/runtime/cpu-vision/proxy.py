"""A weightless vLLM tower; only the final features travel back to the GPU."""
import urllib.request
from contextlib import contextmanager
from contextvars import ContextVar
import torch
from torch import nn
from safetensors.torch import load, save

_profiling = ContextVar('cpu_vision_profiling', default=False)

@contextmanager
def profile_mode():
    token = _profiling.set(True)
    try:
        yield
    finally:
        _profiling.reset(token)


class CPUVisionProxy(nn.Module):
    def __init__(self, config, **kwargs):
        super().__init__()
        self.spatial_merge_size = config.spatial_merge_size
        self.dtype = torch.bfloat16
        self.config = config
        print('[cpu.vision] external CPU tower; no GPU vision parameters', flush=True)

    def forward(self, pixel_values, grid_thw, **kwargs):
        if _profiling.get():
            # Only vLLM's synthetic startup memory probe sets this context.
            tokens = int(grid_thw.prod(-1).sum()) // self.spatial_merge_size**2
            return torch.zeros((tokens, self.config.out_hidden_size), device=pixel_values.device, dtype=self.dtype)
        raw = save({"pixels": pixel_values.detach().cpu().contiguous(),
                    "grid": grid_thw.detach().cpu().to(torch.int64).contiguous()})
        request = urllib.request.Request("http://127.0.0.1:18984/encode", raw,
                                         {"Content-Type": "application/octet-stream"})
        with urllib.request.urlopen(request, timeout=1800) as response:
            features = load(response.read())["embeddings"]
        return features.to(device=pixel_values.device, dtype=self.dtype)
