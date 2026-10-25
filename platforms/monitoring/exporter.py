#!/usr/bin/env python3
"""Read-only AMD sysfs and local model health exporter. No GPU contexts are created."""
import json
import os
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen

SYS = Path(os.environ.get('HOST_SYS', '/host/sys'))
MODEL_URL = os.environ.get('MODEL_URL', 'http://127.0.0.1:18983').rstrip('/')
PROFILE_FILE = Path(os.environ.get('PROFILE_FILE', '/config/profiles.json'))


def number(path):
    try:
        return float(path.read_text().strip())
    except (OSError, ValueError):
        return None


def quote(value):
    return json.dumps(str(value), ensure_ascii=True)


def collect():
    lines = []
    declared = set()
    def gauge(name, value, labels=None, help_text=''):
        if value is None:
            return
        if name not in declared:
            lines.extend([f'# HELP {name} {help_text or name}', f'# TYPE {name} gauge'])
            declared.add(name)
        suffix = '{' + ','.join(f'{k}={quote(v)}' for k,v in sorted((labels or {}).items())) + '}' if labels else ''
        lines.append(f'{name}{suffix} {value}')
    found = 0
    for card in sorted((SYS / 'class/drm').glob('card[0-9]*')):
        device = card / 'device'
        try:
            if (device / 'vendor').read_text().strip() != '0x1002':
                continue
        except OSError:
            continue
        found += 1
        labels = {'gpu':card.name, 'pci':device.resolve().name}
        gauge('lab_gpu_info', 1, labels)
        for name, filename, scale in [('lab_gpu_vram_used_bytes','mem_info_vram_used',1), ('lab_gpu_vram_total_bytes','mem_info_vram_total',1), ('lab_gpu_gtt_used_bytes','mem_info_gtt_used',1), ('lab_gpu_busy_percent','gpu_busy_percent',1), ('lab_gpu_memory_busy_percent','mem_busy_percent',1)]:
            value=number(device/filename)
            gauge(name, None if value is None else value/scale, labels)
        for hwmon in (device/'hwmon').glob('hwmon*'):
            for sensor in hwmon.glob('temp*_input'):
                label_path=sensor.with_name(sensor.name.replace('_input','_label'))
                try: label=label_path.read_text().strip()
                except OSError: label=sensor.stem
                value=number(sensor)
                gauge('lab_gpu_temperature_celsius',None if value is None else value/1000,dict(labels,sensor=label))
            for name, filename, scale in [('lab_gpu_power_watts','power1_average',1e6),('lab_gpu_power_cap_watts','power1_cap',1e6),('lab_gpu_fan_rpm','fan1_input',1),('lab_gpu_clock_mhz','freq1_input',1e6)]:
                value=number(hwmon/filename)
                gauge(name,None if value is None else value/scale,labels)
    gauge('lab_gpu_devices',found)
    healthy=0
    try:
        with urlopen(MODEL_URL+'/health',timeout=1) as response: healthy=int(response.status==200)
    except OSError: pass
    sleeping=0
    try:
        with urlopen('http://127.0.0.1:18982/status',timeout=1) as response:
            sleeping=int(json.load(response).get('residency',{}).get('llm')=='cpu')
    except (OSError,ValueError):pass
    gauge('lab_llm_cpu_resident',sleeping)
    if sleeping:healthy=0
    gauge('lab_llm_health',healthy)
    for name,port,path in [('comfyui',8188,'/system_stats'),('gateway',18982,'/health')]:
        value=0
        try:
            with urlopen(f'http://127.0.0.1:{port}'+path,timeout=.5) as response:value=int(response.status==200)
        except OSError:pass
        gauge('lab_platform_health',value,{'service':name})
    if healthy:
        try:
            with urlopen(MODEL_URL+'/v1/models',timeout=1) as response: models=json.load(response)
            for model in models['data']:
                gauge('lab_llm_context_limit_tokens',model.get('max_model_len'),{'model':model['id']})
        except (OSError, ValueError, KeyError): pass
    try:
        profiles=json.loads(PROFILE_FILE.read_text())
        args=profiles['llm-fast']['args']
        for flag,metric in [('--max-num-seqs','lab_llm_configured_max_sequences'),('--kv-cache-memory-bytes','lab_llm_configured_kv_bytes'),('--long-prefill-threshold','lab_llm_configured_prefill_chunk_tokens')]:
            if flag in args: gauge(metric,float(args[args.index(flag)+1]))
        gauge('lab_llm_configured_thinking',int('--thinking' in args and args[args.index('--thinking')+1]=='on'))
        gauge('lab_llm_configured_vision',int('--vision' in args))
    except (OSError, ValueError, KeyError, IndexError): pass
    return ('\n'.join(lines)+'\n').encode()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ('/health','/metrics'):
            self.send_error(404);return
        body=b'OK\n' if self.path=='/health' else collect()
        self.send_response(200)
        self.send_header('Content-Type','text/plain; version=0.0.4; charset=utf-8')
        self.send_header('Content-Length',str(len(body)))
        self.end_headers();self.wfile.write(body)
    def log_message(self,*args): pass


if __name__=='__main__':
    ThreadingHTTPServer(('127.0.0.1',19101),Handler).serve_forever()
