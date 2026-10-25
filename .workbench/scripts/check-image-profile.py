#!/usr/bin/env python3
"""Qualify two sequential requests before changing the image default profile."""
import argparse
import json
import math
from pathlib import Path
import subprocess
import time
from urllib.request import urlopen
from PIL import Image, ImageChops, ImageStat

ROOT=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--profile',choices=['exact','schedule-int8'],default='exact')
p.add_argument('--size',type=int,choices=[1024,2048],default=1024)
p.add_argument('--fusions',choices=['on','off'],default='on')
p.add_argument('--reuse',action='store_true',help='复用已加载的匹配服务，不重启')
a=p.parse_args();label=f'rocm101-{a.profile}-fusions-{a.fusions}-{a.size}'
run=lambda *args:subprocess.run([str(ROOT/'lab'),'pation-model-qwen-image-21',*args],check=True)
if not a.reuse:
    run('stop');run('start','--precision-profile',a.profile,'--native-fusions' if a.fusions=='on' else '--no-native-fusions')
for _ in range(120):
    try:
        with urlopen('http://127.0.0.1:8191/health',timeout=3) as response: health=json.load(response)
        if health.get('status')=='ready':break
    except OSError:pass
    time.sleep(1)
else:raise RuntimeError('Image worker not ready')
results=[]
for seed in [42,43]:
    path=ROOT/f'workspace/outputs/image/qwen-image/{label}-seed{seed}.png'
    run('generate','--size',str(a.size),'--seed',str(seed),'--output',str(path))
    image=Image.open(path).convert('RGB')
    if all(lo==hi==0 for lo,hi in image.getextrema()):raise RuntimeError('All-zero RGB output')
    metrics=json.loads((ROOT/f'workspace/reports/image/qwen-image21/{path.stem}.json').read_text())
    assert metrics['metrics']['precision_profile']==a.profile,metrics
    assert ('active' in metrics['metrics']['native_fusions'])==(a.fusions=='on'),metrics
    results.append(metrics)
baseline=ROOT/'workspace/outputs/image/qwen-image/rocm101-exact-no-fusions-text.png'
psnr=None
if a.size==1024:
    image=Image.open(results[0]['output']).convert('RGB');reference=Image.open(baseline).convert('RGB')
    mse=sum(ImageStat.Stat(ImageChops.difference(image,reference)).sum2)/(1024*1024*3)
    psnr=999 if mse==0 else 10*math.log10(255**2/mse)
report={'health':health,'requests':results,'seed42_psnr_vs_no_fusions':psnr,'scope':'Two requests and pixel checks; not a long-term stability qualification'}
(ROOT/f'workspace/reports/image/qwen-image21/{label}.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'health':health,'warm_seconds':results[1]['metrics']['complete_request_to_png_seconds'],'seed42_psnr_vs_no_fusions':psnr},indent=2),flush=True)
