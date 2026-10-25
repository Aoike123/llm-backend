#!/usr/bin/env python3
"""Sequential long-context checks and mixed-agent concurrency sweeps."""
import argparse, ast, base64, datetime, hashlib, json, random, re, threading, time
from pathlib import Path
from urllib.request import Request,urlopen
from concurrent.futures import ThreadPoolExecutor
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'workspace/reports/llm/paiton/context-concurrency';OUT.mkdir(parents=True,exist_ok=True)
BASE='http://127.0.0.1:18982';STAMP=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ');REPORT=OUT/('tuning-'+STAMP+'.json')
parser=argparse.ArgumentParser();parser.add_argument('--server-seqs',type=int,default=4);parser.add_argument('--long-lengths',default='131072,196608,256000');parser.add_argument('--levels',default='1,2,4,8');parser.add_argument('--seed-offset',type=int,default=0);parser.add_argument('--skip-two',action='store_true');args=parser.parse_args()
records=[];SAVE_LOCK=threading.Lock();report={'created_at':STAMP,'scope':'Custom long-context and mixed-agent workload checks, not a standard intelligence benchmark','server_max_num_seqs':args.server_seqs,'checks':records,'batches':[]}
# Reuse HTTP streaming and memory sampling functions without executing the earlier test suite.
source=ast.parse((ROOT/'.workbench/scripts/test-vision-long.py').read_text())
functions=[node for node in source.body if isinstance(node,ast.FunctionDef) and node.name in ('save','post','tokenize','gpu_used','completion')]
exec(compile(ast.Module(body=functions,type_ignores=[]),'shared-measurement-functions','exec'))
print('等待 256K 视觉服务',flush=True);deadline=time.monotonic()+900
while True:
 try:
  with urlopen(BASE+'/health',timeout=5) as r:
   if r.status==200:break
 except OSError:pass
 if time.monotonic()>deadline:raise SystemExit('启动超时')
 time.sleep(5)
with urlopen(BASE+'/v1/models') as r:report['models']=json.load(r)
MODEL=report['models']['data'][0]['id']
save()
image=base64.b64encode((ROOT/'workspace/reports/llm/paiton/vision-long-context/vision-fixture.png').read_bytes()).decode()
def prompt(target,seed,vision=False):
 seed+=args.seed_offset
 rng=random.Random(seed);expected={k:hashlib.sha256(f'{seed}-{k}'.encode()).hexdigest()[:12].upper() for k in ('ALPHA','BETA','GAMMA')}
 header=f'Read archive number {seed} carefully. Recover the exact secret values of ALPHA, BETA, GAMMA.\n<archive>\n'
 footer='\n</archive>\nReturn only JSON with ALPHA, BETA, GAMMA.'
 if vision:footer+=' Also count red squares and blue circles in the attached image and include red_squares and blue_circles.'
 rows=[f'Record {i}: hash {hashlib.sha256(f"{seed}-{i}".encode()).hexdigest()[:20]}; dept {rng.choice(("physics","biology","astronomy"))}; archived batch {rng.randrange(100000,999999)}.\n' for i in range(14000)]
 empty=tokenize(header+footer);sample=tokenize(header+''.join(rows[:100])+footer);n=int((target-empty-200)*100/(sample-empty))
 def build(n):
  seq=list(rows[:n])
  for key,position in zip(expected,(.1,.5,.9)):seq.insert(int(n*position),f'CONFIDENTIAL SECRET {key} = {expected[key]}.\n')
  return header+''.join(seq)+footer
 for _ in range(3):
  text=build(n);actual=tokenize(text)
  if abs(actual-(target-128))<128:break
  n=max(10,int(n*(target-128)/actual))
 content=[{'type':'text','text':text},{'type':'image_url','image_url':{'url':'data:image/png;base64,'+image}}] if vision else text
 return [{'role':'user','content':content}],expected,actual

def check(label,data):
 messages,expected,count=data;item=completion(label,messages,max_tokens=2048)
 try:answer=json.loads(re.search(r'\{[^{}]*\}',item.get('content','')).group())
 except Exception:answer={}
 item.update(raw_text_tokens=count,expected=expected,correct_keys=sum(answer.get(k)==v for k,v in expected.items()),thinking_observed=bool(item.get('reasoning')))
 item['passed']=item['correct_keys']==3
 if isinstance(messages[0]['content'],list):item['passed']=item['passed'] and answer.get('red_squares')==3 and answer.get('blue_circles')==1
 save();return item
for target in [int(x) for x in args.long_lengths.split(',') if x]:
 print(f'单路长上下文及图片：约 {target} tokens',flush=True)
 item=check('long-vision-'+str(target),prompt(target,800000+target,vision=True))
 print(json.dumps({k:item.get(k) for k in ('label','passed','usage','elapsed_seconds','time_to_first_token_seconds','peak_gpu_used_bytes','error')},ensure_ascii=False),flush=True)
 if not item['passed']:
  report['long_context_failed']=True;save();raise SystemExit('长上下文未通过，停止增加负载，保留原始报告')
# One ~192K agent plus distinct ~8K agents. Every level uses different archives to avoid prefix-cache hits.
for concurrency in [int(x) for x in args.levels.split(',') if x]:
 print(f'混合 agent 负载：1 路约 192K + {concurrency-1} 路约 8K',flush=True)
 data=[prompt(196608,910000+concurrency,True)]+[prompt(8192,920000+concurrency*10+i) for i in range(concurrency-1)]
 barrier=threading.Barrier(concurrency)
 def worker(pair):
  i,d=pair;barrier.wait();return check(f'mixed-c{concurrency}-slot{i}',d)
 start=time.monotonic()
 with ThreadPoolExecutor(max_workers=concurrency) as pool:items=list(pool.map(worker,enumerate(data)))
 wall=time.monotonic()-start;short=[x for x in items if '-slot0' not in x['label']]
 batch={'client_concurrency':concurrency,'server_max_num_seqs':args.server_seqs,'passed':sum(x['passed'] for x in items),'wall_seconds':wall,'long_elapsed_seconds':items[0]['elapsed_seconds'],'short_max_ttft_seconds':max((x.get('time_to_first_token_seconds') or 0 for x in short),default=None),'short_max_elapsed_seconds':max((x['elapsed_seconds'] for x in short),default=None),'total_prompt_tokens':sum(x.get('usage',{}).get('prompt_tokens',0) for x in items),'total_completion_tokens':sum(x.get('usage',{}).get('completion_tokens',0) for x in items),'peak_gpu_used_bytes':max(x['peak_gpu_used_bytes'] for x in items)}
 report['batches'].append(batch);save();print(json.dumps(batch,ensure_ascii=False),flush=True)
 if not all(x['passed'] for x in items):break
# Two independent near-128K requests test heavy long-context overlap separately.
if not args.skip_two:
 print('两路长上下文：每路约 128K',flush=True)
 data=[prompt(131072,940000+i,True) for i in range(2)];barrier=threading.Barrier(2)
 def long_worker(pair):
  i,d=pair;barrier.wait();return check('two-long-128k-slot'+str(i),d)
 start=time.monotonic()
 with ThreadPoolExecutor(max_workers=2) as pool:items=list(pool.map(long_worker,enumerate(data)))
 report['two_long_batch']={'passed':sum(x['passed'] for x in items),'wall_seconds':time.monotonic()-start,'peak_gpu_used_bytes':max(x['peak_gpu_used_bytes'] for x in items)}
report['all_passed']=all(x.get('passed',False) for x in records);save();print('报告：'+str(REPORT),flush=True)
