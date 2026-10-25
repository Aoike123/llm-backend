#!/usr/bin/env python3
"""Public ComfyUI: native GPU graph dispatch and API workflow orchestration."""
import argparse
import hashlib
import shutil
from datetime import datetime
from zoneinfo import ZoneInfo
import json
from pathlib import Path
import subprocess
import sys
from urllib.request import urlopen

ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent
DATA=ROOT/'workspace/data/comfyui'
OUTPUT=ROOT/'workspace/outputs/comfyui'
RUNTIME=json.loads((ROOT/'platforms/runtime-topology.json').read_text())['runtimes']['comfy']
NAME=RUNTIME['container']
WORKFLOWS=ROOT/'workspace/data/video/minimax-h3/user/default/workflows'


def docker(*args,capture=False):
    return subprocess.run(['docker',*map(str,args)],check=True,text=True,capture_output=capture)


def sync_workflows():
    """Keep category/workflow at the root; archive migration copies outside the UI."""
    catalog=json.loads((HERE/'workflows/catalog.json').read_text())['workflows']
    destination=WORKFLOWS
    destination.mkdir(parents=True,exist_ok=True)
    manifest_path=DATA/'workflow-template-manifest.json'
    previous=json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    stamp=datetime.now(ZoneInfo('Asia/Shanghai')).strftime('%Y%m%d-%H%M%S')
    archive=DATA/'workflow-backups'/stamp
    preserved=0;updated=0;manifest={}
    def preserve(source,relative):
        nonlocal preserved
        target=archive/relative
        target.parent.mkdir(parents=True,exist_ok=True)
        if target.exists():target=target.with_name(str(preserved)+'-'+target.name)
        shutil.move(str(source),str(target));preserved+=1
    # Managed old template trees and old migration archives are recoverable on disk.
    for name in ('工作台模板',):
        old=destination/name
        if old.exists():preserve(old,Path(name))
    old=destination/'我的工作流/迁移前'
    if old.exists():preserve(old,Path('迁移前'))
    # Remove archived template duplicates, leaving unrelated user work in place.
    for old in sorted((destination/'我的工作流').glob('*')):
        managed=old/'工作台模板'
        if old.is_dir() and old.name.replace('-','').isdigit() and managed.is_dir():
            preserve(managed,Path('历史模板')/old.name)
    for entry in catalog:
        for suffix in ('.json','.api.json'):
            old=destination/(entry['id']+suffix)
            if old.exists():preserve(old,Path('旧版')/old.name)
        source=HERE/'workflows'/entry['ui']
        relative=Path(entry['category'])/(entry['title']+'.json')
        target=destination/relative;new=source.read_bytes();digest=hashlib.sha256(new).hexdigest()
        if target.exists() and target.read_bytes()!=new:
            existing=hashlib.sha256(target.read_bytes()).hexdigest()
            if existing!=previous.get(str(relative)):preserve(target,Path('已修改模板')/relative)
        if not target.exists() or target.read_bytes()!=new:
            target.parent.mkdir(parents=True,exist_ok=True)
            temporary=target.with_suffix('.tmp');temporary.write_bytes(new);temporary.replace(target);updated+=1
        manifest[str(relative)]=digest
    for folder in sorted(destination.rglob('*'),reverse=True):
        if folder.is_dir() and not any(folder.iterdir()):folder.rmdir()
    manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    print(f'工作流同步：{len(catalog)}个模板，更新{updated}个，归档{preserved}项；目录为“分类/工作流”。')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['build','start','stop','status','logs','check','sync'])
    args=parser.parse_args()
    if args.command=='sync':sync_workflows();return 0
    if args.command=='build':
        raise ValueError('CPU ComfyUI 镜像已停用；统一 GPU 镜像由 ./lab runtime 管理，先查看 ./lab runtime --help。')
    elif args.command=='start':
        # Use the gateway lease path even for an explicit UI startup.
        subprocess.run([str(ROOT/'lab'),'scheduler','switch',RUNTIME['engines'][0]],check=True)
        print(f"统一 GPU ComfyUI：http://127.0.0.1:{RUNTIME['port']}（H3 原生工作流）；不创建额外实例。")
    elif args.command=='stop':docker('stop',NAME)
    elif args.command=='logs':docker('logs','--tail','60',NAME)
    elif args.command=='status':docker('ps','-a','--filter','name=^/'+NAME+'$')
    elif args.command=='check':
        with urlopen('http://127.0.0.1:8188/system_stats',timeout=5) as response:stats=json.load(response)
        with urlopen('http://127.0.0.1:8188/object_info',timeout=5) as response:classes=json.load(response)
        required={'LoadImage','SaveImage','PaitonH3Optimize','MiniMaxH3ImageToVideo','SaveVideo'}
        missing=required-classes.keys()
        print('节点检查：'+('缺少 '+', '.join(sorted(missing)) if missing else '全部已注册'))
        print('运行设备：'+', '.join(row['name'] for row in stats.get('devices',[])))
        return 1 if missing else 0
    return 0


if __name__=='__main__':
    try:sys.exit(main())
    except (OSError,ValueError,subprocess.CalledProcessError) as error:
        print('ERROR: '+str(error),file=sys.stderr);sys.exit(1)
