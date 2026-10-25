#!/usr/bin/env python3
"""Manage the independent monitoring stack; never mutate model containers."""
import argparse
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DATA = ROOT / 'workspace/data/monitoring'
REPORTS = ROOT / 'workspace/reports/monitoring'
DEFAULT_IMAGES = {
    'PROMETHEUS_IMAGE': 'quay.nju.edu.cn/prometheus/prometheus:v3.15.0',
    'NODE_EXPORTER_IMAGE': 'quay.nju.edu.cn/prometheus/node-exporter:v1.12.1',
    'PYTHON_IMAGE': 'docker.io/library/python:3.12-slim',
}


def initialize():
    for folder in [DATA, DATA/'prometheus', REPORTS]:
        folder.mkdir(parents=True, exist_ok=True)
    lock = HERE/'images.lock.json'
    images = json.loads(lock.read_text())['images'] if lock.exists() else DEFAULT_IMAGES
    images = {key: value for key, value in images.items() if key in DEFAULT_IMAGES}
    (DATA/'runtime.env').write_text('\n'.join([f'MONITOR_UID={os.getuid()}', f'MONITOR_GID={os.getgid()}', *(f'{key}={value}' for key,value in images.items())])+'\n')


def compose(*args, capture=False):
    return subprocess.run(['docker', 'compose', '--env-file', str(DATA/'runtime.env'), '-f', str(HERE/'compose.yaml'), *args], cwd=HERE, check=True, text=True, capture_output=capture)


def fetch(url):
    headers = {}
    try:
        with urlopen(Request(url, headers=headers), timeout=10) as response:
            return json.load(response)
    except HTTPError as error:
        raise RuntimeError(f"{url}: HTTP {error.code}") from error


def query(expression):
    result = fetch('http://127.0.0.1:19090/api/v1/query?'+urlencode({'query':expression}))
    if result['status'] != 'success':
        raise RuntimeError('Prometheus 查询失败')
    return result['data']['result']


def report():
    workspace = fetch('http://127.0.0.1:13000/data?minutes=15')
    targets = fetch('http://127.0.0.1:19090/api/v1/targets')['data']['activeTargets']
    readings = {name:query(expression) for name,expression in {
        'gpu_devices':'lab_gpu_devices', 'vram_used_bytes':'lab_gpu_vram_used_bytes',
        'gpu_utilization_percent':'lab_gpu_busy_percent', 'gpu_temperature_celsius':'lab_gpu_temperature_celsius',
        'host_available_memory_bytes':'node_memory_MemAvailable_bytes', 'host_cpu_seconds':'count(node_cpu_seconds_total{mode="idle"})',
        'model_health':'lab_llm_health', 'model_context_tokens':'lab_llm_context_limit_tokens',
        'configured_concurrency':'lab_llm_configured_max_sequences', 'requests_running':'vllm:num_requests_running',
        'requests_waiting':'vllm:num_requests_waiting', 'kv_usage':'vllm:kv_cache_usage_perc',
        'generation_tokens_total':'vllm:generation_tokens_total', 'prompt_tokens_total':'vllm:prompt_tokens_total',
        'ttft_observations':'vllm:time_to_first_token_seconds_count',
        'gateway_health':'lab_platform_health{service="gateway"}',
        'comfyui_health':'lab_platform_health{service="comfyui"}',
        'scheduler_queue':'lab_scheduler_queued',
        'scheduler_leases':'lab_scheduler_active_leases',
    }.items()}
    expected = {'prometheus','host','amd_gpu','gateway'}
    healthy = {target['labels']['job'] for target in targets if target['health']=='up'}
    values = lambda key: [float(row['value'][1]) for row in readings[key]]
    llm_loaded=values('model_health')==[1.0]
    # ComfyUI only runs for H3 (or idle after boot); other backends stop it while they own the GPU.
    comfy_expected=workspace['model'] in (None,'h3')
    mandatory=['gpu_devices','vram_used_bytes','gpu_utilization_percent','gpu_temperature_celsius',
               'host_available_memory_bytes','configured_concurrency','gateway_health','comfyui_health',
               'scheduler_queue','scheduler_leases']
    passed = (workspace['values'].get('api')==1 and expected <= healthy
              and values('gpu_devices')
              and min(values('gpu_devices'))>=1 and values('gateway_health')==[1.0]
              and (not comfy_expected or (workspace['values'].get('comfy')==1 and values('comfyui_health')==[1.0]))
              and all(readings[key] for key in mandatory)
              and (not llm_loaded or 'llm' in healthy))
    return {'checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'passed':bool(passed),
            'workspace_model':workspace['model'], 'llm_state':'loaded' if llm_loaded else 'standby', 'comfyui_state':'expected' if comfy_expected else 'stopped-by-design', 'targets':[{ 'job':target['labels']['job'], 'health':target['health'], 'last_error':target['lastError']} for target in targets],
            'readings':readings}


def main():
    parser=argparse.ArgumentParser(description='本地监控：Next.js http://127.0.0.1:13000')
    parser.add_argument('command', choices=['start','stop','status','logs','check','export','lock-images'])
    parser.add_argument('--tail',type=int,default=60)
    args=parser.parse_args()
    if args.command=='lock-images':
        images={}
        for key, tag in DEFAULT_IMAGES.items():
            info=json.loads(subprocess.check_output(['docker','image','inspect',tag],text=True))[0]
            digests=info.get('RepoDigests',[])
            if not digests: raise RuntimeError('镜像尚未下载：'+tag)
            images[key]=digests[0]
        (HERE/'images.lock.json').write_text(json.dumps({'locked_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'images':images},indent=2)+'\n')
        initialize()
        print('三个监控镜像已锁定到下载后的 digest。')
        return 0
    if args.command in ('check','export'):
        result=report()
        REPORTS.mkdir(parents=True,exist_ok=True)
        stamp=datetime.datetime.now().strftime('%Y%m%dT%H%M%S')
        path=REPORTS/('check-'+stamp+'.json')
        path.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
        print(('验证通过' if result['passed'] else '验证失败')+f'：{path}')
        for target in result['targets']:
            standby=target['job']=='llm' and target['health']!='up' and result['llm_state']=='standby'
            print(f"  {target['job']}: {target['health']} " + ('（LLM 未加载，按需启动）' if standby else target['last_error']))
        if result['comfyui_state']!='expected': print(f"  comfyui: 当前引擎 {result['workspace_model']} 占用 GPU，按设计停止")
        return 0 if result['passed'] else 1
    if args.command=='start':
        initialize()
        compose('up','-d','--remove-orphans')
        deadline = time.monotonic()+45
        while True:
            try:
                for url in ['http://127.0.0.1:19090/-/ready']:
                    with urlopen(url, timeout=1) as response:
                        if response.status != 200: raise OSError('服务尚未就绪')
                break
            except OSError:
                if time.monotonic() >= deadline: raise RuntimeError('监控启动未就绪，请执行 ./lab monitor logs 检查')
                time.sleep(1)
        print('Next.js 工作台：http://127.0.0.1:13000/\n接入检查：./lab monitor check')
    elif args.command=='stop':
        compose('down')
    elif args.command=='status':
        compose('ps')
    elif args.command=='logs':
        compose('logs','--tail',str(args.tail))
    return 0


if __name__=='__main__':
    try: sys.exit(main())
    except (OSError,ValueError,KeyError,RuntimeError,subprocess.CalledProcessError) as error:
        print(f'ERROR: {error}',file=sys.stderr);sys.exit(1)
