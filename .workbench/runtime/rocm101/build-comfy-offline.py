#!/usr/bin/env python3
"""Assemble local video ComfyUI images from checked source and wheel caches."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT=Path(__file__).resolve().parents[3]
HERE=Path(__file__).resolve().parent
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--engine',choices=['minimax-h3'],required=True)
a=p.parse_args();engine=a.engine
model,node,deps='MiniMax-H3','paiton_h3','/opt/h3-deps'
package=ROOT/'engines/shared/paiton/upstream/models'/model
data=ROOT/'workspace/data/runtime/rocm101'
wheels=data/('h3-wheels' if engine=='minimax-h3' else 'wan-wheels')
lock=json.loads((wheels/'wheels.lock.json').read_text())
requirements=[line for line in (package/'requirements.lock.txt').read_text().splitlines() if line and not line.startswith('#')]
assert set(requirements)=={row['package']+'=='+row['version'] for row in lock['files']}
for row in lock['files']:
    path=wheels/row['filename']
    with path.open('rb') as stream:assert hashlib.file_digest(stream,'sha256').hexdigest()==row['sha256'],str(path)
sources=[(ROOT/'.workbench/vendor/comfyui','efa6c8f804bff78b46a0fd458ebd2e47bba07a30'),(data/'comfyui-frontend-source','e7d1c7fc6823e330fdab524610b0000394cb1dbc')]
for path,sha in sources:
    assert subprocess.check_output(['git','-C',str(path),'rev-parse','HEAD'],text=True).strip()==sha
context=data/'assembly'/engine;context.mkdir(parents=True,exist_ok=True)
for src,name in [(sources[0][0],'comfyui'),(sources[1][0],'frontend')]:
    shutil.copytree(src,context/name,dirs_exist_ok=True,ignore=shutil.ignore_patterns('.git','__pycache__','node_modules'))
target=context/'wheels';target.mkdir(exist_ok=True)
for row in lock['files']:
    dest=target/row['filename']
    if not dest.exists():os.link(wheels/row['filename'],dest)
shutil.copy2(package/'requirements.lock.txt',context/'requirements.lock.txt')
shutil.copytree(package/'comfyui'/node,context/'custom_nodes'/node,dirs_exist_ok=True)
shutil.copytree(package/'comfyui/workflows',context/'custom_nodes'/node/'example_workflows',dirs_exist_ok=True)
shutil.copy2(HERE/'comfy-offline.Dockerfile',context/'Dockerfile')
runtime=json.loads((HERE/'active.json').read_text())[engine]['target']
base=json.loads(subprocess.check_output(['docker','image','inspect',runtime],text=True))[0]['Id']
tag='local-ai/pation-'+engine+'-comfyui-rocm101:20261011'
subprocess.run(['docker','build','--build-arg','BASE_IMAGE='+base,'--build-arg','DEPS_PATH='+deps,'-t',tag,str(context)],check=True)
image=json.loads(subprocess.check_output(['docker','image','inspect',tag],text=True))[0]
report=ROOT/'workspace/reports/runtime/rocm101'/f'{engine}-comfy-assembly.json'
report.write_text(json.dumps({'target':tag,'id':image['Id'],'base':base,'wheel_sha256_verified':True,'sources':[{'path':str(path),'commit':sha} for path,sha in sources],'gpu_qualified':False},indent=2)+'\n')
