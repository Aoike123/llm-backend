"""Maintenance A/B under an exclusive lease; restore production on failure."""
import importlib.util,json,os,subprocess,time
from pathlib import Path
from urllib.request import urlopen,Request
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
probe=load('speed_probe',ROOT/'.workbench/scripts/diagnose-llm-speed.py')
controller=load('paiton_controller',ROOT/'engines/shared/paiton/controller.py')
launcher=load('policy_launcher',ROOT/'.workbench/scripts/launch-llm-policy.py')
REPORT=ROOT/'workspace/reports/llm-policy-ab.json'
PROMPTS={'chinese':'请写一篇详细的中文科普文章，介绍计算机如何处理数据，解释内存、处理器与存储的区别，连续展开，不要提前总结。',
         'english':'Write a detailed technical explanation of how a computer processes data. Describe memory, processors, storage and practical examples in continuous prose.'}
report={'success':False,'stages':{},'policy_before':{'draft_sample_method':'probabilistic','draft_rerank':128}}
def save():REPORT.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
def suite(name):
    rows=[];report['stages'][name]=rows
    for language,prompt in PROMPTS.items():
        for temperature in (0,.7):
            for repetition in range(2):
                row=probe.run(f'{language}-t{temperature}-{repetition}',prompt,temperature)
                row.update(language=language,repetition=repetition);rows.append(row);save()
    return rows
def wait_ready():
    started=time.monotonic()
    while time.monotonic()-started<900:
        try:
            with urlopen(probe.BASE+'/health',timeout=2) as r:
                if r.status==200:return time.monotonic()-started
        except OSError:pass
        state=subprocess.run(['docker','inspect','--format','{{.State.Status}}','paiton-qwen38'],capture_output=True,text=True)
        if state.returncode or state.stdout.strip() not in ('running','created'):raise RuntimeError('Worker exited during load; see policy worker log')
        time.sleep(2)
    raise TimeoutError('Worker startup timeout')
def correctness():
    rows=[]
    for prompt,expected in [('只输出2+2的结果。','4'),('只输出17乘19的结果。','323'),('只输出Python表达式sum([1, 2, 3, 4])的结果。','10')]:
        body={'model':'qwen38-27b-w3a4','messages':[{'role':'user','content':prompt}],'temperature':0,'max_tokens':32,'chat_template_kwargs':{'enable_thinking':False}}
        with urlopen(Request(probe.BASE+'/v1/chat/completions',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'}),timeout=60) as r:result=json.load(r)
        output=result['choices'][0]['message']['content'].strip();rows.append({'expected':expected,'output':output,'passed':output==expected})
    report['correctness']=rows;save()
    if not all(r['passed'] for r in rows):raise RuntimeError('Correctness smoke failed')
def start_policy(policy):
    controller.model_env('llm-fast');os.environ.update(controller.ENV)
    args=list(controller.PROFILES['llm-fast']['args']);i=args.index('--image');args[i+1]=controller.RUNTIMES['llm']['target']
    command=launcher.command(controller.PAITON/'models/Qwen3.8-MXFP4-DFlash2/launch-rocm10.py',args,policy)
    report['restored']=False;save()
    subprocess.run([str(ROOT/'lab'),'pation-model-qwen38-27b-w3a4','stop','w3a4'],check=True,timeout=90)
    subprocess.run(command,check=True,env=controller.ENV,timeout=180)
    log=(ROOT/'workspace/reports/llm-policy-ab-worker.log').open('w')
    follower=subprocess.Popen(['docker','logs','-f','paiton-qwen38'],stdout=log,stderr=subprocess.STDOUT)
    try:
        report['new_policy_ready_seconds']=wait_ready();report['active_policy']=policy
    finally:follower.terminate();follower.wait(timeout=10);log.close();save()
def restore():
    report['restored']=False;save()
    subprocess.run([str(ROOT/'lab'),'pation-model-qwen38-27b-w3a4','stop','w3a4'],check=True,timeout=90)
    subprocess.run([str(ROOT/'lab'),'pation-model-qwen38-27b-w3a4','start','w3a4'],check=True,timeout=180,env=dict(os.environ,LAB_LLM_RESIDENCY_DISABLE='1'))
    wait_ready();report['restored']=True;report['active_policy']=report['policy_before'];save()
def main():
    with probe.lease('llm'):
        try:
            assert probe.metrics()['vllm:num_requests_running']==0
            suite('probabilistic-r128')
            report['policy_test']={'draft_sample_method':'greedy','draft_rerank':0};save()
            start_policy(report['policy_test']);correctness();suite('greedy-r0')
            report['success']=True;report['active_policy']=report['policy_test'];save()
        except BaseException as error:
            report['error']=str(error) or type(error).__name__;save()
            raise
        finally:
            try:restore()
            except Exception as recovery:report['restore_error']=str(recovery);save()
            if report.get('restore_error'):raise RuntimeError('Production recovery failed: '+report['restore_error'])
if __name__=='__main__':main()
