"""Enable and validate prefix reuse under an exclusive scheduler lease; restore on failure."""
import concurrent.futures, importlib.util, json, os, re, shutil, subprocess, sys, time
from pathlib import Path
from urllib.request import Request,urlopen
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'workspace/reports/prefix-cache-20261016';BASE='http://127.0.0.1:18983'
sys.path.insert(0,str(ROOT/'platforms/scheduler'));from client import lease
report={'runs':[],'success':False}
def save(): (OUT/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
def request(path,body=None,timeout=10):
 with urlopen(Request(BASE+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'}),timeout=timeout) as r:
  raw=r.read();return json.loads(raw) if raw else {}
def metrics():
 with urlopen(BASE+'/metrics',timeout=10) as r: raw=r.read().decode()
 result={}
 for line in raw.splitlines():
  m=re.match(r'^(vllm:[a-z_]+)(?:\{[^\n]*\})?\s+([\d.eE+-]+)$',line)
  if m:result[m[1]]=result.get(m[1],0)+float(m[2])
 return result
def ready(log):
 start=time.monotonic()
 for _ in range(240):
  try:
   request('/health');return time.monotonic()-start
  except Exception:
   state=subprocess.run(['docker','inspect','--format','{{.State.Status}}','paiton-qwen38'],capture_output=True,text=True).stdout.strip()
   if state not in ('running','created'):raise RuntimeError('Worker exited during startup; inspect '+str(log))
   time.sleep(2)
 raise RuntimeError('Worker readiness timeout')
def launch(kind):
 subprocess.run(['docker','stop','paiton-qwen38'],check=True,stdout=subprocess.DEVNULL,timeout=90)
 # --rm cleanup can finish after docker stop returns. Wait for it before
 # creating the replacement; retain an exited non-auto-remove worker by name.
 for _ in range(30):
  inspected=subprocess.run(['docker','inspect','--format','{{.State.Status}} {{.HostConfig.AutoRemove}}','paiton-qwen38'],capture_output=True,text=True)
  if inspected.returncode:break
  state=inspected.stdout.strip()
  if state=='exited false':
   subprocess.run(['docker','rename','paiton-qwen38','paiton-qwen38-cache-backup-'+str(int(time.time()))],check=True);break
  time.sleep(.5)
 else:raise RuntimeError('Old worker cleanup did not complete')
 cmd=json.loads((OUT/(kind+'-command.json')).read_text())
 spec=importlib.util.spec_from_file_location('controller',ROOT/'engines/shared/paiton/controller.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c);c.model_env('llm-fast')
 subprocess.run(cmd,env=c.ENV,check=True,stdout=subprocess.DEVNULL,timeout=180)
 log=OUT/(kind+'-startup.log')
 with log.open('w') as f:
  follower=subprocess.Popen(['docker','logs','-f','--timestamps','paiton-qwen38'],stdout=f,stderr=subprocess.STDOUT)
  try:return ready(log)
  finally:follower.terminate();follower.wait(timeout=10)
def probe(name,messages,expected):
 before=metrics();start=time.monotonic();first=None;parts=[];usage=None
 body={'model':'qwen38-27b-w3a4','messages':messages,'temperature':0,'max_tokens':32,'stream':True,'stream_options':{'include_usage':True},'chat_template_kwargs':{'enable_thinking':False}}
 with urlopen(Request(BASE+'/v1/chat/completions',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'}),timeout=180) as response:
  for line in response:
   if not line.startswith(b'data: ') or line.strip()==b'data: [DONE]':continue
   event=json.loads(line[6:]);usage=event.get('usage') or usage
   for choice in event.get('choices',[]):
    text=choice.get('delta',{}).get('content','')
    if text:
     if first is None:first=time.monotonic()
     parts.append(text)
 after=metrics();output=''.join(parts).strip();cached=(usage or {}).get('prompt_tokens_details',{}).get('cached_tokens')
 row={'name':name,'ttft_seconds':None if first is None else first-start,'elapsed_seconds':time.monotonic()-start,'usage':usage,'output':output,'expected':expected,'prefix_hits_delta':after.get('vllm:prefix_cache_hits_total',0)-before.get('vllm:prefix_cache_hits_total',0)}
 print(json.dumps(row),flush=True)
 if output!=expected:raise RuntimeError('Incorrect cached state result: '+name+' '+repr(output))
 if name!='cold' and not ((cached or 0)>0):raise RuntimeError('No cached prompt tokens reported for '+name)
 return row
def main():
 with lease('llm'):
  before=metrics();assert before.get('vllm:num_requests_running')==0 and before.get('vllm:num_requests_waiting')==0
  report['previous_worker']=subprocess.check_output(['docker','inspect','--format','{{.Id}}','paiton-qwen38'],text=True).strip();save()
  try:
   report['startup_seconds']=launch('enabled');save()
   plan=json.loads((ROOT/'workspace/data/llm/paiton/runtime/qwen38/workbench-kv-plan.json').read_text())
   report['layout']={k:plan.get(k) for k in ['prefix_caching','capacity_tokens','pool_blocks','context_tokens','concurrency','groups']};save()
   assert plan.get('prefix_caching') is True
   prefix='Validation code is CACHE-391. Preserve it exactly.\n' + ''.join(f'Row {i:05d}: alpha beta gamma delta epsilon.\n' for i in range(4000))
   a=[{'role':'user','content':prefix+'\nWhat is the validation code? Reply only the code.'}]
   b=[{'role':'user','content':prefix+'\nCompute 19*23. Reply only the integer.'}]
   for name,msg,answer in [('cold',a,'CACHE-391'),('repeat',a,'CACHE-391'),('shared-prefix-branch',b,'437'),('return-to-first-branch',a,'CACHE-391'),('conversation-continuation',a+[{'role':'assistant','content':'CACHE-391'},{'role':'user','content':'What was the validation code? Reply only the code.'}],'CACHE-391')]:
    report['runs'].append(probe(name,msg,answer));save()
   # Check two sessions restore independent checkpoint state concurrently.
   with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    futures=[pool.submit(probe,'concurrent-code',a,'CACHE-391'),pool.submit(probe,'concurrent-math',b,'437')]
    for future in futures:report['runs'].append(future.result());save()
   report['final_metrics']={k:v for k,v in metrics().items() if any(x in k for x in ['prefix_cache','preemption','num_requests_'])};report['success']=True;save()
  except BaseException as e:
   report['error']=repr(e);save()
   # Restore the pre-change launcher/profile/runtime as well as the running worker.
   for name in ['.workbench/scripts/launch-configured-llm.py','.workbench/runtime/rocm101/workbench_runtime.py','engines/shared/paiton/config/profiles.json','platforms/workbench/lib/backend.mjs']:
    shutil.copy2(OUT/'before'/name,ROOT/name)
   try:report['rollback_startup_seconds']=launch('rollback');report['restored']=True
   except BaseException as rollback:report['rollback_error']=repr(rollback)
   save();raise
if __name__=='__main__':main()
