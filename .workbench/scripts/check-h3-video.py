#!/usr/bin/env python3
"""Run a bounded H3 API workflow and preserve the actual completion history."""
import argparse,json,time
from pathlib import Path
from urllib.request import Request,urlopen
ROOT=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--preset',choices=['turbo8','turbo4'],default='turbo8');p.add_argument('--width',type=int,default=576);p.add_argument('--height',type=int,default=320);a=p.parse_args()
base='http://127.0.0.1:8190'
for _ in range(180):
    try:
        with urlopen(base+'/system_stats',timeout=5) as r: json.load(r)
        break
    except OSError:time.sleep(1)
else:raise RuntimeError('H3 service did not become ready')
graph=json.loads((ROOT/f'engines/shared/paiton/upstream/models/MiniMax-H3/comfyui/workflows/{a.preset}.api.json').read_text())
graph['5']['inputs'].update(width=a.width,height=a.height,length=124)
graph['17']['inputs']['filename_prefix']=f'MiniMax-H3/rocm101-{a.preset}-{a.width}x{a.height}'
start=time.monotonic()
with urlopen(Request(base+'/prompt',data=json.dumps({'prompt':graph}).encode(),headers={'Content-Type':'application/json'}),timeout=30) as r: submitted=json.load(r)
print('Submitted '+json.dumps(submitted),flush=True)
if 'prompt_id' not in submitted:raise RuntimeError(str(submitted))
for _ in range(1100):
    with urlopen(base+'/history/'+submitted['prompt_id'],timeout=15) as r:history=json.load(r)
    if submitted['prompt_id'] in history:break
    time.sleep(1)
else:raise RuntimeError('Video workflow timed out')
entry=history[submitted['prompt_id']]
report={'elapsed_seconds':time.monotonic()-start,'workflow':graph,'history':entry}
path=ROOT/f'workspace/reports/video/minimax-h3/rocm101-{a.preset}-{a.width}x{a.height}.json';path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2),flush=True)
if entry.get('status',{}).get('status_str')!='success':raise RuntimeError('H3 workflow failed; see '+str(path))
if not entry.get('outputs'):raise RuntimeError('No video outputs')
