#!/usr/bin/env python3
"""Actual vision, default reasoning, and long-context retrieval checks (not a standard quality benchmark)."""
import base64, datetime, hashlib, json, math, random, re, struct, threading, time, zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.request import Request, urlopen
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'workspace/reports/llm/paiton/vision-long-context'
OUT.mkdir(parents=True,exist_ok=True)
BASE='http://127.0.0.1:18982'
with urlopen(BASE+'/v1/models',timeout=10) as r: MODEL=json.load(r)['data'][0]['id']
STAMP=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
REPORT=OUT/('results-'+STAMP+'.json')
records=[]
SAVE_LOCK=threading.Lock()
report={'created_at':STAMP,'scope':'Single-GPU sequential custom retrieval and vision checks; not an industry-standard intelligence benchmark','checks':records}
def save():
    with SAVE_LOCK:
        REPORT.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
def post(endpoint,payload,timeout=1800):
    return urlopen(Request(BASE+endpoint,data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'}),timeout=timeout)
def tokenize(text):
    with post('/tokenize',{'model':MODEL,'prompt':text}) as response: return json.load(response)['count']
def gpu_used():
    values=[]
    for path in Path('/sys/class/drm').glob('card*/device/mem_info_vram_used'):
        try: values.append(int(path.read_text()))
        except OSError: pass
    return max(values,default=0)
def completion(label,messages,max_tokens=2048):
    item={'label':label,'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    peak=[gpu_used()]; done=threading.Event()
    def sample():
        while not done.wait(.25): peak[0]=max(peak[0],gpu_used())
    monitor=threading.Thread(target=sample,daemon=True); monitor.start()
    started=time.monotonic(); text=[]; reasoning=[]; usage={}; first=None; finish=None
    try:
        with post('/v1/chat/completions',{'model':MODEL,'messages':messages,'max_tokens':max_tokens,'temperature':0,'stream':True,'stream_options':{'include_usage':True}}) as response:
            for raw in response:
                line=raw.decode().strip()
                if not line.startswith('data: '): continue
                if line=='data: [DONE]': break
                chunk=json.loads(line[6:])
                if chunk.get('usage'): usage=chunk['usage']
                for choice in chunk.get('choices',[]):
                    delta=choice.get('delta',{})
                    r=delta.get('reasoning') or delta.get('reasoning_content') or ''
                    c=delta.get('content') or ''
                    if (r or c) and first is None: first=time.monotonic()-started
                    text.append(c); reasoning.append(r)
                    if choice.get('finish_reason'): finish=choice['finish_reason']
        item.update(content=''.join(text),reasoning=''.join(reasoning),usage=usage,finish_reason=finish,time_to_first_token_seconds=first,elapsed_seconds=time.monotonic()-started)
    except Exception as error: item.update(error=str(error),elapsed_seconds=time.monotonic()-started)
    finally: done.set();monitor.join();item['peak_gpu_used_bytes']=max(peak[0],gpu_used())
    records.append(item);save();return item
# A deterministic 512 x 256 image: three red squares and one blue circle.
w,h=512,256
pixels=bytearray([255]*(w*h*3))
for y in range(h):
    for x in range(w):
        red=any(a<=x<a+65 and 50<=y<115 for a in (30,140,250))
        blue=(x-420)**2+(y-155)**2<=40**2
        if red or blue: pixels[(y*w+x)*3:(y*w+x)*3+3]=bytes((230,20,20) if red else (20,40,230))
def png_chunk(kind,data): return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
image=b'\x89PNG\r\n\x1a\n'+png_chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+png_chunk(b'IDAT',zlib.compress(b''.join(b'\0'+pixels[y*w*3:(y+1)*w*3] for y in range(h))))+png_chunk(b'IEND',b'')
(OUT/'vision-fixture.png').write_bytes(image)
print('等待视觉与长上下文服务就绪',flush=True)
deadline=time.monotonic()+900
while True:
    try:
        with urlopen(BASE+'/health',timeout=5) as response:
            if response.status==200: break
    except OSError: pass
    if time.monotonic()>deadline: raise SystemExit('服务启动超时')
    time.sleep(5)
with urlopen(BASE+'/v1/models') as response: report['models']=json.load(response)
save()
print('开始视觉测试（使用服务默认 thinking 设置）',flush=True)
item=completion('vision-counting',[{'role':'user','content':[{'type':'text','text':'Count the red squares and blue circles in this image. Return only JSON with keys red_squares and blue_circles.'},{'type':'image_url','image_url':{'url':'data:image/png;base64,'+base64.b64encode(image).decode()}}]}])
try:
    match=re.search(r'\{[^{}]*\}',item.get('content',''))
    answer=json.loads(match.group())
    item['passed']=answer.get('red_squares')==3 and answer.get('blue_circles')==1
except Exception: item['passed']=False
item['thinking_observed']=bool(item.get('reasoning'));save();print(json.dumps({k:item.get(k) for k in ('label','passed','thinking_observed','elapsed_seconds','content','error')},ensure_ascii=False),flush=True)
# Non-identical filler records and independent random secrets in three document positions.
for target in (8192,32768,61440):
    rng=random.Random(7100+target)
    expected={key:''.join(rng.choice('ABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(12)) for key in ('ALPHA','BETA','GAMMA')}
    header='Read the following archive and recover the three secret values assigned to keys ALPHA, BETA, GAMMA. Ignore ordinary record IDs and checksums.\n<archive>\n'
    footer='\n</archive>\nReturn only a JSON object with keys ALPHA, BETA, GAMMA and their exact secret values. Do not invent missing values.'
    lines=[f'Record {i:05d}: batch {rng.randrange(100000,999999)}; checksum {hashlib.sha256(str(target+i).encode()).hexdigest()[:24]}; status archived; department {rng.choice(("astronomy","botany","geology","physics"))}; audit date 2025-{rng.randrange(1,13):02d}-{rng.randrange(1,29):02d}.\n' for i in range(5500)]
    count=tokenize(header+''.join(lines[:100])+footer)
    n=int((target-256)/max(1,(count-tokenize(header+footer))/100))
    def document(n):
        seq=list(lines[:n])
        for key,fraction in zip(expected,(.1,.5,.9)):
            seq.insert(int(n*fraction),f'CONFIDENTIAL KEY {key}: SECRET VALUE {expected[key]}.\n')
        return header+''.join(seq)+footer
    for _ in range(3):
        prompt=document(n); actual=tokenize(prompt)
        if abs(actual-(target-128))<128: break
        n=max(10,int(n*(target-128)/actual))
    print(f'开始长上下文测试：目标 {target}，原始文本 {actual} tokens',flush=True)
    item=completion('retrieval-'+str(target),[{'role':'user','content':prompt}],max_tokens=2048)
    item.update(target_tokens=target,raw_text_tokens=actual,expected=expected,needle_positions=[.1,.5,.9])
    try:
        match=re.search(r'\{[^{}]*\}',item.get('content','')); answer=json.loads(match.group())
        item['correct_keys']=sum(answer.get(key)==value for key,value in expected.items())
    except Exception: item['correct_keys']=0
    item['passed']=item['correct_keys']==3
    item['thinking_observed']=bool(item.get('reasoning'))
    usage=item.get('usage',{});elapsed=item.get('elapsed_seconds',0);ttft=item.get('time_to_first_token_seconds')
    if ttft and usage.get('prompt_tokens'): item['prompt_tokens_per_second_estimate']=usage['prompt_tokens']/ttft
    if elapsed and usage.get('completion_tokens'): item['completion_tokens_per_second_end_to_end']=usage['completion_tokens']/elapsed
    save();print(json.dumps({k:item.get(k) for k in ('label','passed','correct_keys','thinking_observed','usage','elapsed_seconds','time_to_first_token_seconds','peak_gpu_used_bytes','error')},ensure_ascii=False),flush=True)
    if item.get('error'): break
report['concurrency_batches']=[]
for target in (8192,32768):
    prompts=[]
    for slot in range(8):
        secret=hashlib.sha256(f'concurrent-{target}-{slot}'.encode()).hexdigest()[:12].upper()
        rows=[f'Archive row {i}: value {hashlib.sha256(f"{target}-{slot}-{i}".encode()).hexdigest()[:20]}; ordinary audit record.\n' for i in range(3000)]
        header=f'You are reading archive {slot}. Recover the exact value of SECRET_KEY from this archive.\n'
        footer='\nReturn only the exact SECRET_KEY value.'
        basecount=tokenize(header+''.join(rows[:100])+footer)
        n=int((target-256)*100/basecount)
        def build(n):
            parts=rows[:n];parts.insert(n//2,'SECRET_KEY = '+secret+'\n');return header+''.join(parts)+footer
        for _ in range(3):
            prompt=build(n);count=tokenize(prompt)
            if abs(count-(target-128))<128:break
            n=max(10,int(n*(target-128)/count))
        prompts.append((slot,prompt,secret,count))
    barrier=threading.Barrier(8)
    print(f'开始 8 路同时请求，每路约 {target} tokens',flush=True)
    def worker(data):
        slot,prompt,secret,count=data
        barrier.wait()
        item=completion(f'concurrency-8-{target}-slot-{slot}',[{'role':'user','content':prompt}],max_tokens=1024)
        item.update(expected=secret,raw_text_tokens=count,passed=secret in item.get('content',''),thinking_observed=bool(item.get('reasoning')))
        return item
    batchstarted=time.monotonic()
    with ThreadPoolExecutor(max_workers=8) as pool: items=list(pool.map(worker,prompts))
    wall=time.monotonic()-batchstarted
    batch={'concurrency':8,'target_tokens_per_request':target,'passed':sum(item['passed'] for item in items),'wall_seconds':wall,'total_prompt_tokens':sum(item.get('usage',{}).get('prompt_tokens',0) for item in items),'total_completion_tokens':sum(item.get('usage',{}).get('completion_tokens',0) for item in items),'peak_gpu_used_bytes':max(item['peak_gpu_used_bytes'] for item in items)}
    batch['aggregate_completion_tokens_per_second_end_to_end']=batch['total_completion_tokens']/wall
    report['concurrency_batches'].append(batch);save();print(json.dumps(batch,ensure_ascii=False),flush=True)
report['all_passed']=all(item.get('passed',False) for item in records)
save();print('报告：'+str(REPORT),flush=True)
