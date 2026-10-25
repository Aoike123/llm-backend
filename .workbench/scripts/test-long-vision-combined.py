#!/usr/bin/env python3
"""Verify an actual image and a long text in the same request, with default reasoning."""
import base64, hashlib, json, re, threading, time
from pathlib import Path
from urllib.request import Request,urlopen
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'workspace/reports/llm/paiton/vision-long-context';BASE='http://127.0.0.1:18982'
with urlopen(BASE+'/v1/models',timeout=10) as r: MODEL=json.load(r)['data'][0]['id']
def post(path,payload):
 return urlopen(Request(BASE+path,data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'}),timeout=900)
def count(prompt):
 with post('/tokenize',{'model':MODEL,'prompt':prompt}) as r:return json.load(r)['count']
lines=[f'Document line {i}: archive code {hashlib.sha256(str(i).encode()).hexdigest()[:24]}; routine maintenance entry, ordinary record.\n' for i in range(3000)]
header='Read the archive and the attached image.\n<archive>\n'
footer='\n</archive>\nReturn JSON with keys SECRET_KEY, red_squares, blue_circles. SECRET_KEY comes from the archive; count the colored shapes in the attached image.'
n=100
baseline=count(header+''.join(lines[:n])+footer);n=int(60500*100/baseline)
for _ in range(3):
 rows=lines[:n];rows.insert(n//2,'SECRET_KEY = MOUNTAIN7K8RIVER\n');text=header+''.join(rows)+footer;actual=count(text)
 if abs(actual-60500)<128:break
 n=int(n*60500/actual)
image=base64.b64encode((OUT/'vision-fixture.png').read_bytes()).decode()
payload={'model':MODEL,'messages':[{'role':'user','content':[{'type':'text','text':text},{'type':'image_url','image_url':{'url':'data:image/png;base64,'+image}}]}],'max_tokens':2048,'temperature':0}
peak=[0];done=threading.Event()
def monitor():
 while not done.wait(.25):
  for p in Path('/sys/class/drm').glob('card*/device/mem_info_vram_used'):
   try:peak[0]=max(peak[0],int(p.read_text()))
   except OSError:pass
thread=threading.Thread(target=monitor);thread.start();start=time.monotonic()
try:
 with post('/v1/chat/completions',payload) as response:result=json.load(response)
finally:done.set();thread.join()
message=result['choices'][0]['message'];content=message.get('content') or '';match=re.search(r'\{[^{}]*\}',content)
try:answer=json.loads(match.group())
except Exception:answer={}
report={'scope':'Long text and actual image in the same request; default thinking on','raw_text_tokens':actual,'elapsed_seconds':time.monotonic()-start,'peak_gpu_used_bytes':peak[0],'passed':answer.get('SECRET_KEY')=='MOUNTAIN7K8RIVER' and answer.get('red_squares')==3 and answer.get('blue_circles')==1,'thinking_observed':bool(message.get('reasoning') or message.get('reasoning_content')),'response':result}
(OUT/'combined-long-vision.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k!='response'},ensure_ascii=False));print(content)
