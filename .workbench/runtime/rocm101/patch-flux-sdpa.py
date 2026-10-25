"""Disable the failing vendor Torch Flash SDPA path for local gfx1201/SDK 10.1."""
import hashlib,json
from pathlib import Path
paths=[Path('/opt/paiton/image/paiton_image/pipeline.py'),Path('/opt/flux2-tools/sdnq_tool/pipeline.py')]
marker='    torch.set_num_threads(4)\n'
patch='''    # Qualified local ROCm 10.1 fallback: Flash SDPA fails for gfx1201 GQA.
    # Compiled Paiton diffusion attention/decoder artifacts remain enabled.
    torch.backends.cuda.enable_flash_sdp(False)
    torch.backends.cuda.enable_mem_efficient_sdp(False)
    torch.backends.cuda.enable_cudnn_sdp(False)
    torch.backends.cuda.enable_math_sdp(True)
'''
rows=[]
for path in paths:
    if not path.exists():continue
    text=path.read_text();before=hashlib.sha256(text.encode()).hexdigest()
    if patch not in text:
        assert text.count(marker)==1,str(path)
        path.write_text(text.replace(marker,marker+patch))
    rows.append({'path':str(path),'before_sha256':before,'after_sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
assert rows,'No FLUX pipeline found'
Path('/opt/paiton/rocm101-flux-sdpa.json').write_text(json.dumps({'scope':'local gfx1201 SDK10.1','backend':'math','pipelines':rows},indent=2)+'\n')
print(json.dumps(rows),flush=True)
