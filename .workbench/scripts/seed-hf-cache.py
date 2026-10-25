#!/usr/bin/env python3
"""Seed an offline HF snapshot from verified locked weights without extra copies."""
import argparse
import hashlib
import json
import os
from pathlib import Path

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--lock',type=Path,required=True)
p.add_argument('--data',type=Path,required=True)
a=p.parse_args();lock=json.loads(a.lock.read_text());root=a.data.resolve()
repo=root/'cache/hub'/('models--'+lock['repository'].replace('/','--'))
snapshot=repo/'snapshots'/lock['revision'];blobs=repo/'blobs';blobs.mkdir(parents=True,exist_ok=True)
for row in lock['files']:
    weight=root/'models'/row.get('destination',row['file'])
    assert weight.stat().st_size==row['bytes'],str(weight)
    with weight.open('rb') as stream:assert hashlib.file_digest(stream,'sha256').hexdigest()==row['sha256'],str(weight)
    blob=blobs/row['sha256']
    if not blob.exists():os.link(weight,blob)
    file=snapshot/row['file'];file.parent.mkdir(parents=True,exist_ok=True)
    if not file.exists():file.symlink_to(os.path.relpath(blob,file.parent))
    assert file.resolve()==blob.resolve(),str(file)
    temporary=weight.with_name(weight.name+'.cache-link')
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(os.path.relpath(file,weight.parent));temporary.replace(weight)
    print('Offline snapshot ready: '+row['file'],flush=True)
