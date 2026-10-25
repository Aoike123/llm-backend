"""Experimental CPU-resident LLM lifecycle; unknown state stays GPU-active."""
import json,subprocess,time
from pathlib import Path
from urllib.request import Request,urlopen
ROOT=Path(__file__).resolve().parents[2]
CONFIG=Path(__file__).with_name('residency.json')
def config():return json.loads(CONFIG.read_text())
def available_memory():
    return int(next(x.split()[1] for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:')))*1024

def labelled(name='paiton-qwen38'):
    try:
        value=subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "ai.workbench.resident"}}',name],text=True,stderr=subprocess.DEVNULL).strip()
        return value=='true'
    except subprocess.CalledProcessError:return False

def request(path,post=False,timeout=5):
    with urlopen(Request('http://127.0.0.1:18983'+path,data=b'' if post else None),timeout=timeout) as r:
        raw=r.read();return json.loads(raw) if raw else {}

def sleeping():
    if not labelled():return False
    try:return request('/is_sleeping')['is_sleeping'] is True
    except (OSError,ValueError,KeyError):return False

def vram_used():
    return sum(int(p.read_text()) for p in Path('/sys/class/drm').glob('card[0-9]*/device/mem_info_vram_used') if (p.parent/'vendor').read_text().strip()=='0x1002')

def sleep():
    policy=config()
    if not policy['enabled'] or 'llm' not in policy.get('models',[]) or not labelled():return False
    if available_memory()<policy['minimum_available_memory_gib']*2**30:return False
    request('/sleep?level=1&mode=wait',True,policy['transition_timeout_seconds'])
    if not sleeping():raise RuntimeError('LLM did not enter CPU-resident sleep')
    # Driver accounting can lag the physical unmap.
    for _ in range(30):
        if vram_used()<=policy['maximum_sleep_vram_gib']*2**30:break
        time.sleep(.2)
    if vram_used()>policy['maximum_sleep_vram_gib']*2**30:raise RuntimeError('Sleep retained too much GPU memory; cold fallback required')
    if available_memory()<policy['minimum_remaining_memory_gib']*2**30:raise RuntimeError('CPU residency exceeded memory budget')
    return True

def wake():
    policy=config();request('/wake_up',True,policy['transition_timeout_seconds'])
    if sleeping():raise RuntimeError('LLM remained asleep after wake')

def status():
    policy=config();supported=labelled()
    return {'enabled':policy['enabled'],'models':policy.get('models',[]),
            'llm':'cpu' if supported and sleeping() else 'gpu' if supported else 'cold',
            'available_memory_bytes':available_memory()}
