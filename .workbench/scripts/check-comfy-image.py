#!/usr/bin/env python3
"""Submit one checked image workflow and preserve its actual history."""
import json
from pathlib import Path
import sys
import time
from urllib.request import Request, urlopen
from PIL import Image

ROOT=Path(__file__).resolve().parents[2]
mode=sys.argv[1]
stem='qwen-image21-'+mode if mode in {'text','rgba','edit'} else mode
workflow=ROOT/f'platforms/comfyui/workflows/{stem}.api.json'
base='http://127.0.0.1:8188'
start=time.monotonic()
request=Request(base+'/prompt',data=json.dumps({'prompt':json.loads(workflow.read_text())}).encode(),headers={'Content-Type':'application/json'})
with urlopen(request,timeout=20) as response: submission=json.load(response)
prompt_id=submission['prompt_id']
for _ in range(300):
    with urlopen(base+'/history/'+prompt_id,timeout=10) as response: history=json.load(response)
    if prompt_id in history: break
    time.sleep(1)
else: raise RuntimeError('ComfyUI workflow timed out')
entry=history[prompt_id]
engine='flux2' if stem.startswith('flux2') else 'qwen-image21'
report=ROOT/f'workspace/reports/image/{engine}/rocm101-comfy-{mode}.json'
report.parent.mkdir(parents=True,exist_ok=True)
report.write_text(json.dumps({'elapsed_seconds':time.monotonic()-start,'history':entry},indent=2))
if entry.get('status',{}).get('status_str')!='success': raise RuntimeError(str(entry.get('status')))
outputs=[]
for node in entry['outputs'].values():
    for row in node.get('images',[]):
        path=ROOT/'workspace/outputs/comfyui'/row.get('subfolder','')/row['filename']
        picture=Image.open(path)
        extrema=picture.getextrema()
        if all(lo==hi==0 for lo,hi in picture.convert('RGB').getextrema()): raise RuntimeError('All-zero output '+str(path))
        outputs.append({'path':str(path),'size':picture.size,'mode':picture.mode,'extrema':extrema})
if not outputs: raise RuntimeError('Workflow produced no image')
print(json.dumps({'elapsed_seconds':time.monotonic()-start,'images':outputs},indent=2),flush=True)
