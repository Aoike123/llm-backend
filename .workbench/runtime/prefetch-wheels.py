#!/usr/bin/env python3
"""Fetch exact-version compatible wheels with curl, recording primary SHA256."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import subprocess
from pip._vendor.packaging.tags import sys_tags
from pip._vendor.packaging.utils import parse_wheel_filename

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--requirements',type=Path,required=True)
p.add_argument('--destination',type=Path,required=True)
p.add_argument('--workers',type=int,default=6)
a=p.parse_args();a.destination.mkdir(parents=True,exist_ok=True)
tags={tag:i for i,tag in enumerate(sys_tags())}
requirements=[line.strip().split('==') for line in a.requirements.read_text().splitlines() if line.strip() and not line.startswith('#')]
assert all(len(row)==2 for row in requirements),'Only exact versions are accepted'
def digest(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
def fetch(row):
    name,version=row
    metadata=subprocess.run(['curl','-fLsS','--retry','2','--max-time','60',f'https://pypi.org/pypi/{name}/{version}/json'],check=True,capture_output=True,text=True)
    info=json.loads(metadata.stdout);candidates=[]
    for file in info['urls']:
        if file['packagetype']!='bdist_wheel' or file.get('yanked'):continue
        _,_,_,wheel_tags=parse_wheel_filename(file['filename'])
        ranks=[tags[tag] for tag in wheel_tags if tag in tags]
        if ranks:candidates.append((min(ranks),file))
    if not candidates:raise RuntimeError('No compatible wheel: '+name+'=='+version)
    file=min(candidates,key=lambda row:row[0])[1];path=a.destination/file['filename'];sha=file['digests']['sha256']
    if not(path.is_file() and path.stat().st_size==file['size'] and digest(path)==sha):
        partial=path.with_name(path.name+'.partial')
        mirror=file['url'].replace('https://files.pythonhosted.org/packages/','https://mirrors.aliyun.com/pypi/packages/')
        for url in [mirror,file['url']]:
            result=subprocess.run(['curl','-fLsS','--retry','2','--max-time','300','--continue-at','-','-o',str(partial),url],capture_output=True,text=True)
            if result.returncode==0 and partial.stat().st_size==file['size'] and digest(partial)==sha:
                partial.replace(path);break
            if partial.exists() and partial.stat().st_size>=file['size']:partial.unlink()
        else:raise RuntimeError('Wheel download failed: '+file['filename'])
    print('Verified '+file['filename'],flush=True)
    return {'package':name,'version':version,'filename':file['filename'],'bytes':file['size'],'sha256':sha,'source':file['url']}
with ThreadPoolExecutor(max_workers=a.workers) as pool:rows=list(pool.map(fetch,requirements))
(a.destination/'wheels.lock.json').write_text(json.dumps({'requirements':str(a.requirements),'files':rows,'sha256_verified':True},indent=2)+'\n')
print('All wheels verified',flush=True)
