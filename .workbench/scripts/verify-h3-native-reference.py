import json,time,urllib.request
from pathlib import Path
root=Path(__file__).resolve().parents[2];report=root/'workspace/reports/h3-reference-20261019';base='http://127.0.0.1:8188'
graph=json.loads((root/'platforms/comfyui/workflows/api/02-video/minimax-h3-multireference-mixed.api.json').read_text());graph['5']['inputs'].update(width=576,height=320,length=124);graph['17']['inputs']['filename_prefix']='H3/Ref2VA-native-mixed'
start=time.monotonic()
with urllib.request.urlopen(urllib.request.Request(base+'/prompt',data=json.dumps({'prompt':graph}).encode(),headers={'Content-Type':'application/json'}),timeout=30) as r:submission=json.load(r)
print('Native mixed reference submitted',submission,flush=True);pid=submission['prompt_id']
for _ in range(1800):
 with urllib.request.urlopen(base+'/history/'+pid,timeout=20) as r:history=json.load(r)
 if pid in history:break
 time.sleep(1)
else:raise RuntimeError('Native reference timeout')
entry=history[pid];(report/'native-mixed-result.json').write_text(json.dumps({'wall_seconds':time.monotonic()-start,'history':entry},indent=2));assert entry['status']['status_str']=='success',entry['status']
from urllib.parse import urlencode
files=[f for node in entry['outputs'].values() for rows in node.values() if isinstance(rows,list) for f in rows if isinstance(f,dict) and f.get('type')=='output' and f.get('filename','').endswith('.mp4')]
assert files
f=files[0]
with urllib.request.urlopen(base+'/view?'+urlencode({k:f[k] for k in ['filename','subfolder','type'] if k in f}),timeout=90) as r:(report/'native-mixed.mp4').write_bytes(r.read())
print('Native mixed reference success:',round(time.monotonic()-start,2),'seconds',flush=True)
