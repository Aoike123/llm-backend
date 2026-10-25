#!/usr/bin/env python3
"""Run the cataloged Anima graphs under one GPU lease and keep their history."""
import io
import json
from pathlib import Path
import sys
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import uuid
from PIL import Image

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'platforms/comfyui/custom_nodes'))
from pation_scheduler.client import lease
WORKFLOWS=ROOT/'platforms/comfyui/workflows'
BASE='http://127.0.0.1:'+str(json.loads((ROOT/'platforms/runtime-topology.json').read_text())['runtimes']['comfy']['port'])
REPORTS=ROOT/'workspace/reports/image/anima'
OUTPUTS=ROOT/'workspace/outputs/image/anima'


def post(path,body,content_type='application/json'):
    request=Request(BASE+path,data=body,headers={'Content-Type':content_type})
    with urlopen(request,timeout=30) as response:return json.load(response)


def upload(name,data):
    """Multipart upload into ComfyUI input/ so the image graph has its LoadImage source."""
    boundary=uuid.uuid4().hex
    body=(f'--{boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n'
          f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{name}"\r\nContent-Type: image/png\r\n\r\n').encode()+data+f'\r\n--{boundary}--\r\n'.encode()
    return post('/upload/image',body,'multipart/form-data; boundary='+boundary)


def run(entry,timeout=900):
    graph=json.loads((WORKFLOWS/entry['api']).read_text())
    start=time.monotonic();prompt_id=post('/prompt',json.dumps({'prompt':graph}).encode())['prompt_id']
    while time.monotonic()-start<timeout:
        with urlopen(BASE+'/history/'+prompt_id,timeout=10) as response:history=json.load(response)
        if prompt_id in history:break
        time.sleep(1)
    else:raise RuntimeError(entry['id']+': ComfyUI workflow timed out')
    record=history[prompt_id];elapsed=time.monotonic()-start
    REPORTS.mkdir(parents=True,exist_ok=True)
    (REPORTS/f"comfy-{entry['id']}.json").write_text(json.dumps({'elapsed_seconds':elapsed,'history':record},ensure_ascii=False,indent=2))
    if record.get('status',{}).get('status_str')!='success':raise RuntimeError(entry['id']+': '+json.dumps(record.get('status'),ensure_ascii=False)[:2000])
    images=[]
    for node in record['outputs'].values():
        for row in node.get('images',[]):
            with urlopen(BASE+'/view?'+urlencode({k:row.get(k,'') for k in ('filename','subfolder','type')}),timeout=30) as response:data=response.read()
            picture=Image.open(io.BytesIO(data)).convert('RGB')
            if max(hi-lo for lo,hi in picture.getextrema())<8:raise RuntimeError(entry['id']+': flat output image')
            OUTPUTS.mkdir(parents=True,exist_ok=True);path=OUTPUTS/f"{entry['id']}.png";path.write_bytes(data)
            images.append({'path':str(path.relative_to(ROOT)),'size':picture.size,'bytes':data})
    if not images:raise RuntimeError(entry['id']+': workflow produced no image')
    return elapsed,images


def main():
    entries=[e for e in json.loads((WORKFLOWS/'catalog.json').read_text())['workflows'] if e.get('execution')=='anima']
    # Text graphs first: the first Turbo image becomes the image-to-image source.
    entries.sort(key=lambda e:e['id'].endswith('image'))
    summary=[];source=None
    with lease('h3'):
        for entry in entries:
            if entry['id'].endswith('image'):
                if source is None:raise RuntimeError('No text-to-image result to use as the image-to-image source')
                upload('anima-input.png',source)
            elapsed,images=run(entry)
            if source is None:source=images[0]['bytes']
            row={'id':entry['id'],'elapsed_seconds':round(elapsed,2),'images':[{k:v for k,v in i.items() if k!='bytes'} for i in images]}
            summary.append(row);print(json.dumps(row,ensure_ascii=False),flush=True)
    (REPORTS/'comfy-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
    return 0


if __name__=='__main__':sys.exit(main())
