"""Compare the CPU service with native checkpoint vision on the GPU."""
import json
import urllib.request
from pathlib import Path
import torch
from PIL import Image
from safetensors import safe_open
from safetensors.torch import load, save
from transformers import AutoConfig, AutoProcessor
from transformers.models.qwen3_5.modeling_qwen3_5 import Qwen3_5VisionModel

root = Path('/models/target')
config = AutoConfig.from_pretrained(root, local_files_only=True).vision_config
config._attn_implementation = 'eager'
model = Qwen3_5VisionModel(config).to(device='cuda',dtype=torch.bfloat16).eval()
index=json.loads((root/'model.safetensors.index.json').read_text())['weight_map']
state={}
for shard in set(index.values()):
    keys=[n for n,f in index.items() if f==shard and n.startswith('model.visual.')]
    if keys:
        with safe_open(root/shard,framework='pt',device='cpu') as weights:
            for key in keys:state[key.removeprefix('model.visual.')]=weights.get_tensor(key)
model.load_state_dict(state,strict=True)
del state
processor=AutoProcessor.from_pretrained(root,local_files_only=True)
inputs=processor.image_processor(images=[Image.open('/cpu-vision/fixture.png')],return_tensors='pt')
pixels=inputs['pixel_values'].to(torch.bfloat16)
grid=inputs['image_grid_thw']
with torch.inference_mode():
    gpu=model(pixels.to('cuda'),grid_thw=grid.to('cuda')).pooler_output.float().cpu()
    request=urllib.request.Request('http://127.0.0.1:18984/encode',save({'pixels':pixels.contiguous(),'grid':grid.contiguous()}),{'Content-Type':'application/octet-stream'})
    with urllib.request.urlopen(request,timeout=1800) as response:cpu=load(response.read())['embeddings'].float()
    assert cpu.shape==gpu.shape and torch.isfinite(cpu).all()
    cosine=torch.nn.functional.cosine_similarity(cpu,gpu,dim=-1)
    relative=(cpu-gpu).norm()/gpu.norm()
    report={'shape':list(cpu.shape),'mean_cosine':cosine.mean().item(),'min_cosine':cosine.min().item(),'relative_l2':relative.item()}
    print(json.dumps(report),flush=True)
    assert report['mean_cosine']>0.99 and report['relative_l2']<0.1,report
