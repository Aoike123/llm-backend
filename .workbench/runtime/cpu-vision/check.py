import json
import time
import urllib.request
from pathlib import Path
import torch
from PIL import Image
from safetensors.torch import load, save
from transformers import AutoProcessor
from proxy import CPUVisionProxy, profile_mode
from types import SimpleNamespace

def health():
    with urllib.request.urlopen('http://127.0.0.1:18984/health') as response:
        return json.load(response)

before = health()['calls']
proxy = CPUVisionProxy(SimpleNamespace(spatial_merge_size=2,out_hidden_size=5120))
assert list(proxy.parameters()) == []
with profile_mode():
    dummy = proxy(torch.empty((0,1536)), torch.tensor([[1,180,180]]))
    assert dummy.shape == (8100,5120)
assert health()['calls'] == before, 'Synthetic profiling must not call the CPU encoder'
del dummy

processor = AutoProcessor.from_pretrained('/models/target', local_files_only=True)
inputs = processor.image_processor(images=[Image.open('/cpu-vision/fixture.png')], return_tensors='pt')
raw = save({'pixels': inputs['pixel_values'].to(torch.bfloat16).contiguous(), 'grid': inputs['image_grid_thw'].contiguous()})
results = []
for _ in range(2):
    start = time.monotonic()
    request = urllib.request.Request('http://127.0.0.1:18984/encode', raw, {'Content-Type':'application/octet-stream'})
    with urllib.request.urlopen(request, timeout=1800) as response:
        encoded = load(response.read())['embeddings']
    assert torch.isfinite(encoded).all()
    results.append({'shape':list(encoded.shape), 'seconds':time.monotonic()-start})
print(json.dumps({'cpu_encoding':results}))
