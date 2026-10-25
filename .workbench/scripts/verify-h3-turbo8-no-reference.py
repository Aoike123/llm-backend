#!/usr/bin/env python3
"""No-reference long Turbo8 comparison against the published Paiton profile."""
import argparse,json,subprocess,time,threading,urllib.request
from pathlib import Path
from urllib.parse import urlencode
ROOT=Path(__file__).resolve().parents[2]
REPORT=ROOT/'workspace/reports/h3-reference-20261019'
BASE='http://127.0.0.1:8188'
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--profile',choices=['long','short'],default='long')
args=parser.parse_args()
frames=362 if args.profile=='long' else 124
STAMP='no-reference-turbo8-paiton' if args.profile=='long' else 'no-reference-turbo8-short-paiton'
graph=json.loads((ROOT/'platforms/comfyui/custom_nodes/pation_h3/turbo8.api.json').read_text())
graph['5']['inputs'].update(width=864,height=480,length=frames)
graph['17']['inputs']['filename_prefix']='H3/'+STAMP
control={'prompt':graph['5']['inputs']['prompt'],'width':864,'height':480,'frames':frames,'steps':8,'seed':771,'engine':'paiton','preset':'turbo8','model':graph['1']['inputs']['unet_name'],'lora':graph['6']['inputs']['lora_name'],'sampler':'euler','scheduler':'simple','reference_image_count':0,'reference_video_count':0}
assert not any(k in graph['5']['inputs'] for k in ('first_frame','last_frame','start_image','end_image'))
(REPORT/(STAMP+'.api.json')).write_text(json.dumps(graph,indent=2))
(REPORT/(STAMP+'-request.json')).write_text(json.dumps(control,indent=2))
start=time.monotonic();stop=threading.Event();samples=[]
def monitor():
 while not stop.is_set():
  sample={'seconds':time.monotonic()-start}
  try:sample['vram_used_bytes']=sum(int(p.read_text()) for p in Path('/sys/class/drm').glob('card[0-9]*/device/mem_info_vram_used'))
  except OSError:pass
  samples.append(sample);stop.wait(1)
thread=threading.Thread(target=monitor,daemon=True);thread.start()
def call(path,payload=None):
 request=urllib.request.Request(BASE+path,data=None if payload is None else json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(request,timeout=30) as r:return json.load(r)
try:
 submission=call('/prompt',{'prompt':graph});pid=submission['prompt_id'];print('No-reference control submitted',submission,flush=True)
 for _ in range(1800):
  history=call('/history/'+pid)
  if pid in history:break
  time.sleep(1)
 else:raise RuntimeError('No-reference control timed out')
 entry=history[pid];assert entry['status']['status_str']=='success',entry['status']
 generated=[f for node in entry['outputs'].values() for rows in node.values() if isinstance(rows,list) for f in rows if isinstance(f,dict) and f.get('type')=='output' and f.get('filename','').endswith('.mp4')]
 assert generated,'Missing generated video'
 f=generated[0]
 with urllib.request.urlopen(BASE+'/view?'+urlencode({k:f[k] for k in ['filename','subfolder','type'] if k in f}),timeout=90) as r:(REPORT/(STAMP+'.mp4')).write_bytes(r.read())
 probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(REPORT/(STAMP+'.mp4'))]))
 video=next(s for s in probe['streams'] if s['codec_type']=='video');expected_frames=control['frames']+((5-control['frames']%17+17)%17)
 assert int(video['nb_frames'])==expected_frames and (video['width'],video['height'])==(control['width'],control['height'])
 assert any(s['codec_type']=='audio' for s in probe['streams'])
 events={kind:data for kind,data in entry['status']['messages']}
 generation_seconds=(events['execution_success']['timestamp']-events['execution_start']['timestamp'])/1000
 result={'generation_seconds':generation_seconds,'prompt_id':pid,'wall_seconds':time.monotonic()-start,'peak_device_vram_bytes':max(s.get('vram_used_bytes',0) for s in samples),'reference_images':0,'reference_videos':0,'control_parameters':control,'history':entry,'output_probe':probe}
 (REPORT/(STAMP+'-result.json')).write_text(json.dumps(result,indent=2));print('No-reference control success: generation',generation_seconds,'seconds; wall including queue',result['wall_seconds'],'seconds',flush=True)
finally:
 stop.set();thread.join(timeout=2);(REPORT/(STAMP+'-memory.json')).write_text(json.dumps(samples,indent=2))
