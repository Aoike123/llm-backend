#!/usr/bin/env python3
"""Build reproducible ROCm 10.1 derivatives of pinned engine images."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
DATA=ROOT/'workspace/data/runtime/rocm101'
REPORT=ROOT/'workspace/reports/runtime/rocm101'
IMAGES=json.loads((HERE/'images.json').read_text())

def run(*args,capture=False):
    return subprocess.run(list(map(str,args)),check=True,text=True,capture_output=capture)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['build','finalize','torch-upgrade','activate','status','check'])
    parser.add_argument('--engine',choices=IMAGES,default='qwen-image21')
    args=parser.parse_args();entry=IMAGES[args.engine]
    REPORT.mkdir(parents=True,exist_ok=True)
    if args.command=='status':
        for name,row in IMAGES.items():
            result=subprocess.run(['docker','image','inspect',row['target'],'--format','{{.Id}}'],text=True,capture_output=True)
            print(name, result.stdout.strip() if result.returncode==0 else '尚未构建')
        return 0
    if args.command=='build':
        package_dir=DATA/'packages'
        if not (package_dir/'SHA256SUMS').exists():raise RuntimeError('SDK 下载及校验尚未完成')
        rows=json.loads((HERE/'packages.lock.json').read_text())
        for row in rows:
            file=package_dir/row['filename'];h=hashlib.sha256()
            with file.open('rb') as handle:
                for block in iter(lambda:handle.read(8388608),b''):h.update(block)
            if h.hexdigest()!=row['sha256']:raise RuntimeError('SDK 包校验失败：'+row['filename'])
        try:run('docker','image','inspect',entry['base'],capture=True)
        except subprocess.CalledProcessError:run('docker','pull',entry['base'])
        digest=json.loads(run('docker','image','inspect',entry['base'],capture=True).stdout)[0]['RepoDigests']
        if digest:
            entry['base']=digest[0]
            with (HERE/'images.lock').open('w') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX)
                images=json.loads((HERE/'images.json').read_text())
                images[args.engine]=entry
                (HERE/'images.json').write_text(json.dumps(images,indent=2)+'\n')
        context=DATA/'build'/args.engine;context.mkdir(parents=True,exist_ok=True)
        target=context/'packages';target.mkdir(exist_ok=True)
        for file in package_dir.iterdir():
            if file.name.endswith('.partial'):continue
            output=target/file.name
            if not output.exists():os.link(file,output)
        for name in ['Dockerfile','upgrade-sdk.py','patch-torch-init.py']:shutil.copy2(HERE/name,context/name)
        run('docker','build','--build-arg','BASE_IMAGE='+entry['base'],'-t',entry['target'],context)
        inspect=json.loads(run('docker','image','inspect',entry['target'],capture=True).stdout)[0]
        (REPORT/(args.engine+'-image.json')).write_text(json.dumps({'base':entry['base'],'target':entry['target'],'id':inspect['Id'],'sdk_packages':rows,'gpu_qualified':False},indent=2)+'\n')
        if args.engine in ['flux2','flux2-tools','flux2-comfyui','minimax-h3']:
            run(sys.executable,HERE/'controller.py','torch-upgrade','--engine',args.engine)
    elif args.command in ('finalize','torch-upgrade'):
        # Finish SDK-only images built before explicit library-path setup.
        before=json.loads(run('docker','image','inspect',entry['target'],capture=True).stdout)[0]
        context=DATA/'finalize'/args.engine;context.mkdir(parents=True,exist_ok=True)
        recipe='torch-sdk.Dockerfile' if args.command=='torch-upgrade' else 'finalize.Dockerfile'
        shutil.copy2(HERE/recipe,context/'Dockerfile')
        shutil.copy2(HERE/'patch-torch-init.py',context/'patch-torch-init.py')
        shutil.copy2(HERE/'init-sdk.py',context/'init-sdk.py')
        options=['--build-arg','BASE_IMAGE='+before['Id']]
        if args.command=='torch-upgrade':
            assert args.engine in ['flux2','flux2-tools','flux2-comfyui','minimax-h3']
            torch_image=json.loads(run('docker','image','inspect',IMAGES['llm']['target'],capture=True).stdout)[0]['Id']
            options+=['--build-arg','TORCH_IMAGE='+torch_image]
        run('docker','build',*options,'-t',entry['target'],context)
        image=json.loads(run('docker','image','inspect',entry['target'],capture=True).stdout)[0]
        receipt=REPORT/(args.engine+'-image.json')
        data=json.loads(receipt.read_text()) if receipt.exists() else {'base':entry['base'],'target':entry['target']}
        data.update(id=image['Id'],gpu_qualified=False)
        if args.command=='torch-upgrade':data['torch_source']=torch_image
        receipt.write_text(json.dumps(data,indent=2)+'\n')
        if args.command=='torch-upgrade' and args.engine in ['flux2','flux2-tools']:
            run(sys.executable,HERE/'build-flux-sdpa.py','--engine',args.engine,'--build-only')
    else:
        result=run('docker','run','--rm','--entrypoint','python','-v',str(HERE/'check-runtime.py')+':/tmp/check-runtime.py:ro',entry['target'],'/tmp/check-runtime.py',capture=True)
        print(result.stdout)
        (REPORT/(args.engine+'-cpu-check.json')).write_text(result.stdout)
        if args.command=='activate':
            path=HERE/'active.json'
            with (HERE/'active.lock').open('w') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX)
                active=json.loads(path.read_text()) if path.exists() else {}
                active[args.engine]=entry
                path.write_text(json.dumps(active,indent=2)+'\n')
            print('已配置 ROCm 10.1 镜像；GPU 推理仍待宿主升级后验证。')
    return 0

if __name__=='__main__':
    try:sys.exit(main())
    except (OSError,ValueError,RuntimeError,subprocess.CalledProcessError) as error:
        print('ERROR:',error,file=sys.stderr);sys.exit(1)
