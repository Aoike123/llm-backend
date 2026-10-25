#!/usr/bin/env python3
"""Run a bounded Wan API workflow and preserve the actual completion history."""
import argparse,json,time
from pathlib import Path
from urllib.request import Request,urlopen
ROOT=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--engine',choices=['stock','paiton'],default='paiton');a=p.parse_args()
base='http://127.0.0.1:8192'
for _ in range(180):
    try:
        with urlopen(base+'/system_stats',timeout=5) as r: json.load(r)
        break
    except OSError:time.sleep(1)
else:raise RuntimeError('Wan service did not become ready')
graph=json.loads((ROOT/'engines/shared/paiton/upstream/models/Wan2.2/comfyui/workflows/base.api.json').read_text())
graph['1']['inputs']['engine']=a.engine
graph['10']['inputs']['filename_prefix']='Wan/rocm101-'+a.engine
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
path=ROOT/f'workspace/reports/video/wan22/rocm101-{a.engine}-832x480.json';path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2),flush=True)
if entry.get('status',{}).get('status_str')!='success':raise RuntimeError('Wan workflow failed; see '+str(path))
if not entry.get('outputs'):raise RuntimeError('No video outputs')
