"""Exclusive controlled model sleep/wake test; holds the public GPU lease."""
import json,os,subprocess,sys,time
from pathlib import Path
from urllib.request import Request,urlopen
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'platforms/scheduler'))
from client import lease
REPORT=ROOT/'workspace/reports/llm-residency-test.json'
def call(path,body=None,timeout=120,post=False):
    request=Request('http://127.0.0.1:18983'+path,data=json.dumps(body).encode() if body is not None else b'' if post else None,headers={'Content-Type':'application/json'})
    with urlopen(request,timeout=timeout) as r:
        raw=r.read();return json.loads(raw) if raw else {}
def sample():
    result={}
    for p in Path('/sys/class/drm').glob('card[0-9]*/device/mem_info_vram_used'):
        if (p.parent/'vendor').read_text().strip()=='0x1002':result['vram_bytes']=int(p.read_text())
    result['mem_available_bytes']=int(next(x.split()[1] for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:')))*1024
    rows=json.loads(subprocess.check_output(['docker','stats','--no-stream','--format','{{json .}}','paiton-qwen38'],text=True))
    result['container_memory']=rows['MemUsage'];return result
body={'model':'qwen38-27b-w3a4','messages':[{'role':'user','content':'只输出 2+2 的答案。'}],'max_tokens':16,'temperature':0,'seed':42,'chat_template_kwargs':{'enable_thinking':False}}
report={'runs':[],'success':False}
def run_test():
    # Public clients queue while this test owns the GPU lifecycle.
    started=time.monotonic()
    if os.environ.get('LAB_LLM_RESIDENCY_REUSE')!='1':
        subprocess.run([str(ROOT/'lab'),'pation-model-qwen38-27b-w3a4','stop','w3a4'],check=True)
        env=dict(os.environ,LAB_LLM_RESIDENCY_TEST='1')
        subprocess.run([str(ROOT/'lab'),'pation-model-qwen38-27b-w3a4','start','w3a4'],env=env,check=True)
    for _ in range(900):
        try:call('/is_sleeping',timeout=2);call('/health',timeout=2);break
        except OSError:
            state=subprocess.check_output(['docker','inspect','--format','{{.State.Status}}','paiton-qwen38'],text=True).strip()
            if state not in ('running','created'):raise RuntimeError('Resident worker exited: '+subprocess.check_output(['docker','logs','--tail','80','paiton-qwen38'],stderr=subprocess.STDOUT,text=True))
            time.sleep(1)
    else:raise TimeoutError('Resident LLM failed to start')
    report['ready_wait_seconds' if os.environ.get('LAB_LLM_RESIDENCY_REUSE')=='1' else 'cold_start_seconds']=time.monotonic()-started
    report['baseline']=sample()
    baseline=call('/v1/chat/completions',body)['choices'][0]['message']['content'];report['baseline_output']=baseline
    for i in range(3):
        row={'cycle':i+1,'before':sample()};start=time.monotonic();call('/sleep?level=1&mode=wait',post=True)
        row['sleep_seconds']=time.monotonic()-start;assert call('/is_sleeping')['is_sleeping']
        time.sleep(2);row['sleeping']=sample();start=time.monotonic();call('/wake_up',post=True)
        row['wake_seconds']=time.monotonic()-start;assert not call('/is_sleeping')['is_sleeping']
        output=call('/v1/chat/completions',body)['choices'][0]['message']['content'];row['output']=output
        row['after']=sample();report['runs'].append(row);REPORT.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        assert output==baseline,(baseline,output)
        print('Cycle passed:',json.dumps(row,ensure_ascii=False),flush=True)
    report['success']=True

def recover():
    """Restore the normal allocator before releasing the exclusive GPU lease."""
    logs=subprocess.run(['docker','logs','paiton-qwen38'],capture_output=True,text=True)
    REPORT.with_suffix('.log').write_text(logs.stdout+logs.stderr)
    subprocess.run([str(ROOT/'lab'),'pation-model-qwen38-27b-w3a4','stop','w3a4'],check=True,timeout=90)
    env=dict(os.environ,LAB_LLM_RESIDENCY_DISABLE='1')
    subprocess.run([str(ROOT/'lab'),'pation-model-qwen38-27b-w3a4','start','w3a4'],env=env,check=True,timeout=180)
    deadline=time.monotonic()+900
    while time.monotonic()<deadline:
        try:
            call('/health',timeout=2)
            output=call('/v1/chat/completions',body)['choices'][0]['message']['content']
            if output.strip()!='4':raise RuntimeError('Recovery inference returned unexpected output')
            report['recovery']={'success':True,'output':output};return
        except OSError:
            state=subprocess.check_output(['docker','inspect','--format','{{.State.Status}}','paiton-qwen38'],text=True).strip()
            if state!='running':raise RuntimeError('Normal worker exited during recovery')
            time.sleep(2)
    raise TimeoutError('Normal worker recovery timed out')

def main():
    try:
        with lease('llm'):
            try:run_test()
            except BaseException as error:
                report['error']=str(error) or type(error).__name__
                print('Test failed; restoring stable LLM before releasing lease',flush=True)
                try:recover()
                except Exception as recovery_error:report['recovery']={'success':False,'error':str(recovery_error)}
                raise
    finally:
        REPORT.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')

if __name__=='__main__':main()
