#!/usr/bin/env python3
import json,sys,time
from pathlib import Path
from urllib.request import Request,urlopen
ROOT=Path(__file__).resolve().parents[2];name=sys.argv[1];base='http://127.0.0.1:8188';start=time.monotonic()
graph=json.loads((ROOT/f'platforms/comfyui/workflows/{name}.api.json').read_text())
with urlopen(Request(base+'/prompt',data=json.dumps({'prompt':graph}).encode(),headers={'Content-Type':'application/json'}),timeout=30) as r:sub=json.load(r)
print(json.dumps(sub),flush=True)
if 'prompt_id' not in sub:raise RuntimeError(str(sub))
for _ in range(1100):
    with urlopen(base+'/history/'+sub['prompt_id'],timeout=15) as r:history=json.load(r)
    if sub['prompt_id'] in history:break
    time.sleep(1)
else:raise RuntimeError('Workflow timed out')
entry=history[sub['prompt_id']];result={'elapsed_seconds':time.monotonic()-start,'history':entry};p=ROOT/f'workspace/reports/video/rocm101-comfy-{name}.json';p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2),flush=True)
if entry.get('status',{}).get('status_str')!='success':raise RuntimeError('Workflow failed')
if not entry.get('outputs'):raise RuntimeError('No video output')
