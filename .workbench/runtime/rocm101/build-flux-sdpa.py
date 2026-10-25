#!/usr/bin/env python3
import argparse,json,shutil,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];HERE=Path(__file__).resolve().parent
images=json.loads((HERE/'images.json').read_text())
p=argparse.ArgumentParser();p.add_argument('--engine',choices=['flux2','flux2-tools']);p.add_argument('--build-only',action='store_true');args=p.parse_args()
for engine in ([args.engine] if args.engine else ['flux2','flux2-tools']):
    tag=images[engine]['target'];base=json.loads(subprocess.check_output(['docker','image','inspect',tag],text=True))[0]['Id']
    context=ROOT/'workspace/data/runtime/rocm101/flux-sdpa'/engine;context.mkdir(parents=True,exist_ok=True)
    shutil.copy2(HERE/'flux-sdpa.Dockerfile',context/'Dockerfile');shutil.copy2(HERE/'patch-flux-sdpa.py',context/'patch-flux-sdpa.py')
    subprocess.run(['docker','build','--build-arg','BASE_IMAGE='+base,'-t',tag,str(context)],check=True)
    image=json.loads(subprocess.check_output(['docker','image','inspect',tag],text=True))[0]
    report=ROOT/'workspace/reports/runtime/rocm101'/f'{engine}-image.json';row=json.loads(report.read_text());row.update(id=image['Id'],sdpa_backend='math',sdpa_base=base,gpu_qualified=False);report.write_text(json.dumps(row,indent=2)+'\n')
    if args.build_only:continue
    subprocess.run([str(ROOT/'lab'),'runtime','check','--engine',engine],check=True)
    subprocess.run([str(ROOT/'lab'),'runtime','activate','--engine',engine],check=True)
