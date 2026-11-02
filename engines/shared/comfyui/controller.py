#!/usr/bin/env python3
"""The shared native ComfyUI runtime: on-demand start through the scheduler, checks and template sync."""
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

ROOT=Path(__file__).resolve().parents[3]
HERE=Path(__file__).resolve().parent
# The runtime's /data: weights shared by H3 and Anima, the canvas user directory and caches.
RUNTIME_DATA=ROOT/'workspace/data/comfy'
DATA=RUNTIME_DATA/'sync'
sys.path.insert(0,str(ROOT/'.workbench'))
import registry  # noqa: E402
RUNTIME=registry.native_runtime()
# The ComfyUI container is the Paiton H3 image; its compose project starts it.
LAUNCH=['pation-model-minimax-h3','start']
NAME=RUNTIME['container']
WORKFLOWS=RUNTIME_DATA/'user/default/workflows'


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
    parser.add_argument('command',choices=['launch','start','stop','status','logs','check','sync'])
    args=parser.parse_args()
    if args.command=='sync':sync_workflows();return 0
    if args.command=='launch':
        # The scheduler's launch step for every engine on this runtime; callers hold the GPU lease.
        return subprocess.run([str(ROOT/'lab'),*LAUNCH]).returncode
    if args.command=='start':
        # Opening the canvas goes through the gateway lease like any request; nothing starts at boot.
        subprocess.run([str(ROOT/'lab'),'scheduler','switch',RUNTIME['engines'][0]],check=True)
        print(f"ComfyUI：http://127.0.0.1:{RUNTIME['port']}（{'、'.join(RUNTIME['engines'])} 共用）；切到其他 GPU 引擎时按需停止。")
    elif args.command=='stop':docker('stop',NAME)
    elif args.command=='logs':docker('logs','--tail','60',NAME)
    elif args.command=='status':docker('ps','-a','--filter','name=^/'+NAME+'$')
    elif args.command=='check':
        with urlopen(f"http://127.0.0.1:{RUNTIME['port']}/system_stats",timeout=5) as response:stats=json.load(response)
        with urlopen(f"http://127.0.0.1:{RUNTIME['port']}/object_info",timeout=5) as response:classes=json.load(response)
        required={'LoadImage','SaveImage','UNETLoader','KSampler','PaitonH3Optimize','MiniMaxH3ImageToVideo','SaveVideo'}
        missing=required-classes.keys()
        print('节点检查：'+('缺少 '+', '.join(sorted(missing)) if missing else '全部已注册'))
        print('运行设备：'+', '.join(row['name'] for row in stats.get('devices',[])))
        return 1 if missing else 0
    return 0

if __name__=='__main__':
    try:sys.exit(main())
    except (OSError,ValueError,subprocess.CalledProcessError) as error:
        print('ERROR: '+str(error),file=sys.stderr);sys.exit(1)
