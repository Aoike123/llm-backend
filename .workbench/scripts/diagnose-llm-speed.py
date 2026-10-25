"""Controlled single-request streaming probe; retains the scheduler GPU lease."""
import hashlib,json,re,sys,time
from pathlib import Path
from urllib.request import Request,urlopen
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'platforms/scheduler'))
from client import lease
BASE='http://127.0.0.1:18983'
REPORT=ROOT/'workspace/reports/llm-single-throughput-diagnosis.json'
def metrics():
    with urlopen(BASE+'/metrics',timeout=5) as r:raw=r.read().decode()
    result={}
    for line in raw.splitlines():
        m=re.match(r'^(vllm:[a-z_]+)(?:\{[^\n]*\})?\s+([\d.eE+-]+)$',line)
        if m:result[m[1]]=result.get(m[1],0.)+float(m[2])
    return result

def hardware():
    result={}
    for card in Path('/sys/class/drm').glob('card[0-9]*'):
        device=card/'device'
        if not (device/'vendor').exists() or (device/'vendor').read_text().strip()!='0x1002':continue
        for key in ('gpu_busy_percent','mem_info_vram_used'):
            if (device/key).exists():result[key]=int((device/key).read_text())
        for hw in (device/'hwmon').glob('*'):
            for key in ('temp1_input','temp2_input','power1_average','power1_cap','freq1_input'):
                if (hw/key).exists():result[key]=int((hw/key).read_text())
    return result

def run(name,prompt,temperature=0):
    before=metrics();started=time.monotonic();first=None;last=None;usage=None;chunks=0;text=[]
    body={'model':'qwen38-27b-w3a4','messages':[{'role':'user','content':prompt}],
          'max_tokens':512,'ignore_eos':True,'temperature':temperature,'seed':42,'stream':True,
          'stream_options':{'include_usage':True},'chat_template_kwargs':{'enable_thinking':False}}
    with urlopen(Request(BASE+'/v1/chat/completions',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'}),timeout=180) as r:
        for line in r:
            if not line.startswith(b'data: '):continue
            if line.strip()==b'data: [DONE]':break
            data=json.loads(line[6:]);now=time.monotonic()
            if data.get('usage'):usage=data['usage']
            for choice in data.get('choices',[]):
                delta=choice.get('delta',{})
                if delta.get('content') or delta.get('reasoning_content'):
                    text.append(delta.get('content','')+delta.get('reasoning_content',''))
                    if first is None:first=now
                    last=now;chunks+=1
    finished=time.monotonic();after=metrics()
    if not usage or first is None or last<=first:raise RuntimeError('Missing streamed output/usage')
    def diff(key):return after.get('vllm:'+key,0)-before.get('vllm:'+key,0)
    draft=diff('spec_decode_num_draft_tokens_total');accept=diff('spec_decode_num_accepted_tokens_total');rounds=diff('spec_decode_num_drafts_total')
    decode=diff('request_decode_time_seconds_sum');prefill=diff('request_prefill_time_seconds_sum')
    row={'name':name,'temperature':temperature,'usage':usage,'ttft_seconds':first-started,'elapsed_seconds':finished-started,
         'output_tokens_per_second_after_first_estimate':usage['completion_tokens']/(last-first),
         'server_decode_seconds':decode,'server_prefill_seconds':prefill,
         'completion_tokens_per_server_decode_second_estimate':usage['completion_tokens']/decode if decode else None,
         'speculative_acceptance_ratio':accept/draft if draft else None,
         'mean_accepted_tokens_per_draft':accept/rounds if rounds else None,
         'completed_requests_in_interval':diff('request_decode_time_seconds_count'),'stream_chunks':chunks,'output_sha256':hashlib.sha256(''.join(text).encode()).hexdigest(),'output_preview':''.join(text)[:160],'hardware':hardware()}
    assert row['completed_requests_in_interval']==1,'Probe overlapped other worker requests'
    print(json.dumps(row,ensure_ascii=False),flush=True)
    return row

def main():
    report={'scope':'Single request, short input, thinking disabled; 512 tokens forced with ignore_eos. Client estimate includes first chunk tokens; not a universal workload speed guarantee.','runs':[]}
    try:
        with lease('llm'):
            assert metrics()['vllm:num_requests_running']==0
            report['hardware_before']=hardware()
            for name,prompt in [('chinese','请写一篇详细的中文科普文章，介绍计算机如何处理数据，解释内存、处理器与存储的区别，连续展开，不要提前总结。'),('english','Write a detailed technical explanation of how a computer processes data. Describe memory, processors, storage and practical examples in continuous prose.'),('english_repeat','Write a detailed technical explanation of how a computer processes data. Describe memory, processors, storage and practical examples in continuous prose.')]:
                report['runs'].append(run(name,prompt))
    finally:REPORT.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
if __name__=='__main__':main()
