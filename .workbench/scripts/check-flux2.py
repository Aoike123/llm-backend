#!/usr/bin/env python3
import argparse,base64,json,time
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from PIL import Image
ROOT=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--engine',choices=['paiton','stock'],default='paiton');a=p.parse_args()
base='http://127.0.0.1:'+('7861' if a.engine=='paiton' else '7862');other='http://127.0.0.1:'+('7862' if a.engine=='paiton' else '7861')
def call(url,payload):
 try:
  with urlopen(Request(url,data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'}),timeout=1200) as r:return json.load(r)
 except HTTPError as e:raise RuntimeError(e.read().decode(errors='replace')) from e
call(other+'/unload',{})
start=time.monotonic();r=call(base+'/generate',{'prompt':'A red ceramic teapot on a wooden table, soft daylight, clean composition','seed':42})
path=ROOT/f'workspace/outputs/image/flux2/rocm101-{a.engine}-1024.png';path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(base64.b64decode(r['image'],validate=True))
im=Image.open(path).convert('RGB');extrema=im.getextrema()
if all(lo==hi==0 for lo,hi in extrema):raise RuntimeError('All-zero image')
report={'elapsed_seconds':time.monotonic()-start,'output':str(path),'size':im.size,'extrema':extrema,'response':{k:v for k,v in r.items() if k!='image'}}
p=ROOT/f'workspace/reports/image/flux2/rocm101-{a.engine}-1024.json';p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2),flush=True)
