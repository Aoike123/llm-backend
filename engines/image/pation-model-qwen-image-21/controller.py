#!/usr/bin/env python3
"""Independent pinned Qwen-Image worker lifecycle and image API client."""
import argparse
import base64
import datetime
import json
from pathlib import Path
import subprocess
import sys
from urllib.request import Request,urlopen
from urllib.error import HTTPError

ROOT=Path(__file__).resolve().parents[3]
DATA=ROOT/'workspace/data/image/qwen-image'
MODELS=DATA/'models/qwen-image21-mxfp4-rdna4'
REPORTS=ROOT/'workspace/reports/image/qwen-image21'
OUTPUTS=ROOT/'workspace/outputs/image/qwen-image'
UPSTREAM=ROOT/'engines/shared/paiton/upstream/models/Qwen-Image-2.1'
IMAGE='ghcr.nju.edu.cn/eliovp/paiton-vllm-plugin@sha256:64f6a6154b93f39b34f272fc66110ce17f72cca3ec31284ab57056ca5cdc2677'
RUNTIME_CONFIG=ROOT/'.workbench/runtime/rocm101/active.json'
if RUNTIME_CONFIG.exists():
    IMAGE=json.loads(RUNTIME_CONFIG.read_text()).get('qwen-image21',{}).get('target',IMAGE)
NAME='paiton-qwen-image21'
API='http://127.0.0.1:8191'
GPU_NAMES={'paiton-qwen38',NAME,'paiton-flux2','paiton-h3','ai-vbench'}


def docker(*args,capture=False):
    return subprocess.run(['docker',*map(str,args)],check=True,text=True,capture_output=capture)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['prepare','start','stop','status','logs','check','generate'])
    parser.add_argument('--prompt',default='A red ceramic teapot on a wooden table, soft daylight, clean composition')
    parser.add_argument('--mode',choices=['text-to-image','rgba','edit'],default='text-to-image')
    parser.add_argument('--size',type=int,choices=[1024,2048],default=1024)
    parser.add_argument('--seed',type=int,default=42)
    parser.add_argument('--image',type=Path)
    parser.add_argument('--output',type=Path)
    parser.add_argument('--precision-profile',choices=['exact','exact-w32','schedule-int8','schedule-int8-11','schedule-fp8'],default='schedule-int8')
    parser.add_argument('--sdma',choices=['on','off'],default='off',help='本机地址映射兼容配置，默认禁用 SDMA')
    fusions=parser.add_mutually_exclusive_group()
    fusions.add_argument('--no-native-fusions',dest='no_native_fusions',action='store_true',help='关闭融合内核，保留兼容回退路径')
    fusions.add_argument('--native-fusions',dest='no_native_fusions',action='store_false',help='启用已通过本机短测的融合内核（默认）')
    parser.set_defaults(no_native_fusions=False)
    parser.add_argument('--backend',choices=['native','reference'],default='native')
    parser.add_argument('--diagnostics',action='store_true')
    parser.add_argument('--blas',choices=['hipblas','hipblaslt'],default='hipblas',help='默认使用已验证的 hipBLAS；hipBLASLt 尚待单独验证')
    args=parser.parse_args()
    for folder in [DATA,REPORTS,OUTPUTS]:folder.mkdir(parents=True,exist_ok=True)
    if args.command=='prepare':
        if IMAGE.startswith('local-ai/'):
            docker('image','inspect',IMAGE,capture=True)
        else:docker('pull',IMAGE)
        subprocess.run([sys.executable,str(ROOT/'.workbench/scripts/fetch-locked-checkpoint.py'),'--lock',str(UPSTREAM/'checkpoint.lock.json'),'--destination',str(MODELS)],check=True)
    elif args.command=='start':
        if not (MODELS/'verification.json').exists():raise RuntimeError('先执行 prepare 下载并验证权重')
        rows=docker('ps','--format','{{.Names}}|{{.Label "com.docker.compose.project"}}',capture=True).stdout.splitlines()
        active=[row.split('|')[0] for row in rows]
        if NAME in active:print('图像服务已运行：'+API);return 0
        occupied=GPU_NAMES.intersection(active)
        if 'paiton-qwen38' in occupied:
            sys.path.insert(0,str(ROOT/'platforms/scheduler'))
            import residency
            if residency.sleeping():occupied.remove('paiton-qwen38')
        occupied.update(row.split('|')[0] for row in rows if row.split('|')[1] in {'paiton-flux2','paiton-h3'})
        if occupied:raise RuntimeError('请先停止其他单卡模型服务：'+', '.join(sorted(occupied)))
        old=docker('ps','-a','--filter','name=^/'+NAME+'$','--format','{{.Names}}',capture=True).stdout.strip()
        if old:docker('rm',NAME)
        render_gid=(Path('/dev/kfd').stat().st_gid)
        runtime_args=['serve','--precision-profile',args.precision_profile]
        if args.no_native_fusions:runtime_args.append('--no-native-fusions')
        options=['-v',str(Path(__file__).parent/'runtime/reference_runtime.py')+':/app/paiton_image21/runtime.py:ro','-v',str(Path(__file__).parent/'runtime/server.py')+':/app/paiton_image21/server.py:ro','-e','TORCH_BLAS_PREFER_HIPBLASLT='+('0' if args.blas=='hipblas' else '1')]
        launch_args=['--offline','--model-dir','/models/qwen-image21',*runtime_args]
        if args.backend=='reference':
            options+=['--entrypoint','python']
            launch_args=['-u','-m','paiton_image21','--model-dir','/models/qwen-image21','--backend','reference','serve','--host','0.0.0.0']
        if args.diagnostics:
            options[1]=str(Path(__file__).parent/'runtime/diagnostic_runtime.py')+':/app/paiton_image21/runtime.py:ro'
        docker('run','-d','--name',NAME,'--restart','no','--ulimit','core=0','-e','HSA_ENABLE_SDMA='+('0' if args.sdma=='off' else '1'),'--device','/dev/kfd','--device','/dev/dri','--group-add',render_gid,'--ipc=host','-p','127.0.0.1:8191:8191','-v',str(DATA)+':/cache','-v',str(MODELS)+':/models/qwen-image21:ro',*options,IMAGE,*launch_args)
        print('图像服务正在加载：'+API+'；使用 check 查看就绪状态')
    elif args.command=='stop':docker('stop',NAME)
    elif args.command=='status':docker('ps','-a','--filter','name=^/'+NAME+'$')
    elif args.command=='logs':docker('logs','--tail','60',NAME)
    elif args.command=='check':
        with urlopen(API+'/health',timeout=5) as response:health=json.load(response)
        with urlopen(API+'/v1/models',timeout=5) as response:models=json.load(response)
        print(json.dumps({'health':health,'models':models},ensure_ascii=False,indent=2))
        if health['status']!='ready':return 1
    else:
        if args.mode=='edit' and (args.image is None or args.size!=1024):raise RuntimeError('编辑需要 --image，--size 必须是1024')
        stamp=datetime.datetime.now().strftime('%Y%m%dT%H%M%S')
        path=(args.output or OUTPUTS/(args.mode+'-'+stamp+'.png')).resolve()
        if path.exists():raise RuntimeError('输出文件已存在，请选择新路径')
        payload={'prompt':args.prompt,'mode':args.mode,'size':f'{args.size}x{args.size}','seed':args.seed,'n':1}
        if args.mode=='edit':payload['image_b64']=base64.b64encode(args.image.read_bytes()).decode()
        endpoint='/v1/images/edits' if args.mode=='edit' else '/v1/images/generations'
        with urlopen(Request(API+endpoint,data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'}),timeout=1200) as response:result=json.load(response)
        png=base64.b64decode(result['data'][0]['b64_json'],validate=True)
        if not png.startswith(b'\x89PNG\r\n\x1a\n'):raise ValueError('服务未返回有效PNG')
        path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(png)
        receipt=REPORTS/(path.stem+'.json')
        receipt.write_text(json.dumps({'output':str(path),'request':{k:v for k,v in payload.items() if k!='image_b64'},'metrics':result.get('metrics',{})},ensure_ascii=False,indent=2)+'\n')
        print('生成完成：'+str(path)+'\n指标记录：'+str(receipt))
    return 0


if __name__=='__main__':
    try:sys.exit(main())
    except HTTPError as error:
        print('ERROR: HTTP '+str(error.code)+' '+error.read(8192).decode(errors='replace'),file=sys.stderr);sys.exit(1)
    except (OSError,ValueError,RuntimeError,subprocess.CalledProcessError) as error:
        print('ERROR: '+str(error),file=sys.stderr);sys.exit(1)
