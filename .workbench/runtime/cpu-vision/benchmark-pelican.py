"""Sustained eight-stream HTML generation through the real platform gateway."""
import base64
import concurrent.futures
import json
import os
import re
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'workspace/reports/cpu-vision' / os.getenv('PELICAN_RUN', 'pelican-long-output')
OUT.mkdir(parents=True, exist_ok=True)
API = 'http://127.0.0.1:18982'
EFFORT = os.getenv('PELICAN_EFFORT','xhigh')

def post(payload):
    return urllib.request.urlopen(urllib.request.Request(API+'/v1/chat/completions',
        data=json.dumps(payload).encode(), headers={'Content-Type':'application/json'}), timeout=1800)

print('Warming throughput mode; startup excluded from benchmark', flush=True)
with post({'model':'qwen38-27b-65k-8way','messages':[{'role':'user','content':'你好'}], 'max_tokens':512,'reasoning_effort':'xhigh'}) as response:
    warmup = json.load(response)
(OUT/'warmup.json').write_text(json.dumps(warmup,ensure_ascii=False,indent=2))
if warmup['choices'][0]['finish_reason'] != 'stop' or not warmup['choices'][0]['message'].get('content'):
    raise RuntimeError('Greeting did not finish with a complete answer; benchmark not started')
print('xhigh greeting finished; launching animation requests with effort='+EFFORT+
      ', greeting_context='+str(os.getenv('PELICAN_GREETING_CONTEXT')=='1'),flush=True)
barrier = threading.Barrier(9)
samples = []
stop = threading.Event()
origin = time.perf_counter()

def monitor():
    while not stop.is_set():
        sample = {'seconds':time.perf_counter()-origin}
        try:
            with urllib.request.urlopen(API+'/status',timeout=3) as response:
                state=json.load(response)
            sample.update(active=state['active_leases'], queued=state['queued'], error=state['last_error'])
            sample['vram_bytes'] = {str(p.parent.parent.name):int(p.read_text()) for p in Path('/sys/class/drm').glob('card[0-9]/device/mem_info_vram_used')}
        except Exception as error:
            sample['monitor_error']=str(error)
        samples.append(sample)
        stop.wait(.5)

prompt = '''请绘制一只一直骑自行车的鹈鹕，输出完整的单文件 HTML 动画，作品标题“鹈鹕骑行 · 第%s号”。
实现方案已确定：使用原生 SVG 画出有长喙、喉囊、白色身体、翅膀和双脚的鹈鹕，以及自行车的车架、辐条、车轮和踏板。使用 CSS 无限循环使车轮和踏板旋转、身体轻微起伏，使用简单二维连杆让双脚随踏板活动；道路、树木和云朵连续移动。只是卡通动画，无需物理仿真，也无需比较其他技术方案。
请直接完成全部 SVG、CSS 和 JavaScript 代码，提供暂停/继续、速度滑块及日夜切换，中文操作界面，适配手机和桌面。不要引用外部资源，不要省略代码。只输出一个从 <!DOCTYPE html> 到 </html> 的完整代码块。'''

def run(index):
    content = [{'type':'text','text':prompt % (index+1)}]
    if index >= 6:
        content.append({'type':'image_url','image_url':{'url':'data:image/png;base64,'+base64.b64encode((ROOT/'.workbench/runtime/cpu-vision/fixture.png').read_bytes()).decode()}})
        content[0]['text'] += '\n附图仅作为红蓝配色参考，主体仍然是骑车的鹈鹕。'
    messages=[{'role':'user','content':content}]
    if os.getenv('PELICAN_GREETING_CONTEXT')=='1':
        messages=[{'role':'user','content':'你好'}, {'role':'assistant','content':warmup['choices'][0]['message']['content']}, *messages]
    payload={'model':'qwen38-27b-65k-8way','messages':messages,
        'max_tokens':32768,'reasoning_effort':EFFORT,'stream':True,'stream_options':{'include_usage':True},'seed':200+index}
    (OUT/f'{index+1:02d}-request.json').write_text(json.dumps(payload,ensure_ascii=False,indent=2))
    barrier.wait()
    start=time.perf_counter()
    result={'request':index+1,'image':index>=6,'first_delta_seconds':None,'first_content_seconds':None,'content':'','reasoning':'','usage':None}
    try:
        with post(payload) as response, (OUT/f'{index+1:02d}.sse').open('w') as raw:
            for line in response:
                line=line.decode()
                raw.write(line)
                if not line.startswith('data:'): continue
                data=line[5:].strip()
                if data=='[DONE]': break
                item=json.loads(data)
                if item.get('usage'): result['usage']=item['usage']
                for choice in item.get('choices',[]):
                    delta=choice.get('delta',{})
                    reasoning=delta.get('reasoning') or delta.get('reasoning_content') or ''
                    text=delta.get('content') or ''
                    if reasoning or text:
                        if result['first_delta_seconds'] is None: result['first_delta_seconds']=time.perf_counter()-start
                        result['last_delta_seconds']=time.perf_counter()-start
                    if text and result['first_content_seconds'] is None: result['first_content_seconds']=time.perf_counter()-start
                    result['content']+=text
                    result['reasoning']+=reasoning
                    if choice.get('finish_reason'): result['finish_reason']=choice['finish_reason']
        match=re.search(r'<!doctype html>.*?</html>',result['content'],re.I|re.S)
        result['complete_html']=bool(match)
        if match: (OUT/f'{index+1:02d}.html').write_text(match.group(0))
    except Exception as error: result['error']=str(error)
    result['seconds']=time.perf_counter()-start
    (OUT/f'{index+1:02d}.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps({key:value for key,value in result.items() if key not in ('content','reasoning')},ensure_ascii=False),flush=True)
    return result

with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
    futures=[executor.submit(run,index) for index in range(8)]
    origin=time.perf_counter()
    thread=threading.Thread(target=monitor,daemon=True);thread.start()
    barrier.wait()
    results=[future.result() for future in futures]
elapsed=time.perf_counter()-origin
stop.set();thread.join()
completion=sum((r.get('usage') or {}).get('completion_tokens',0) for r in results)
reasoning=sum(((r.get('usage') or {}).get('completion_tokens_details') or {}).get('reasoning_tokens',0) for r in results)
summary={'reasoning_effort':EFFORT,'greeting_context':os.getenv('PELICAN_GREETING_CONTEXT')=='1','warmup_finish_reason':warmup['choices'][0]['finish_reason'],
 'elapsed_seconds':elapsed,'requests':[{k:v for k,v in r.items() if k not in ('content','reasoning')} for r in results],
 'completion_tokens':completion,'reasoning_tokens':reasoning,'visible_tokens':completion-reasoning,
 'completion_tokens_per_second':completion/elapsed,'visible_tokens_per_second':(completion-reasoning)/elapsed,
 'peak_active_leases':max((s.get('active',0) for s in samples),default=0),
 'eight_active_sample_seconds':sum(.5 for s in samples if s.get('active')==8),
 'peak_vram_bytes':max((max(s.get('vram_bytes',{}).values(),default=0) for s in samples),default=0),
 'samples':samples}
(OUT/'benchmark.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
print(json.dumps({k:v for k,v in summary.items() if k not in ('samples','requests')},ensure_ascii=False),flush=True)
