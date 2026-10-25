#!/usr/bin/env python3
"""Rebuild the four-dimension evaluator from SHA256 checked local wheels."""
import hashlib,json,os,shutil,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
data=ROOT/'workspace/data/runtime/rocm101'
wheels=data/'vbench-wheels'
lock=json.loads((wheels/'wheels.lock.json').read_text())
context=data/'assembly/vbench';context.mkdir(parents=True,exist_ok=True)
for row in lock['files']:
    source=wheels/row['filename']
    with source.open('rb') as stream:
        assert hashlib.file_digest(stream,'sha256').hexdigest()==row['sha256'],str(source)
    dest=context/'wheels'/source.name;dest.parent.mkdir(exist_ok=True)
    if not dest.exists():os.link(source,dest)
shutil.copytree(ROOT/'.workbench/vendor/vbench',context/'source',dirs_exist_ok=True,ignore=shutil.ignore_patterns('.git','__pycache__'))
for source,target in [('vbench-minimal.Dockerfile','Dockerfile'),('vbench-entry.py','vbench-entry.py'),('vbench-minimal.requirements.txt','requirements.txt')]:
    shutil.copy2(ROOT/'.workbench/docker'/source,context/target)
subprocess.run(['docker','build','-t','local-ai-vbench:rocm101',str(context)],check=True)
