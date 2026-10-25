#!/usr/bin/env python3
"""No-reference control using the same Ref2VA model, prompt, seed and sampler."""
import argparse,json,subprocess,time,threading,urllib.request
from pathlib import Path
from urllib.parse import urlencode
ROOT=Path(__file__).resolve().parents[2]
REPORT=ROOT/'workspace/reports/h3-reference-20261019'
BASE='http://127.0.0.1:8188'
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--profile',choices=['long','small'],default='long');args=parser.parse_args()
STAMP='no-reference-quality-paiton' if args.profile=='long' else 'no-reference-small-paiton'
control=json.loads((REPORT/'maximum-quality-paiton-request.json').read_text())
control.update(reference_image_count=0,reference_video_count=0)
if args.profile=='small':control.update(width=576,height=320,frames=124)
graph=json.loads((ROOT/'platforms/comfyui/custom_nodes/pation_h3/reference.api.json').read_text())
graph['5']['inputs'].update(prompt=control['prompt'],width=control['width'],height=control['height'],length=control['frames'])
graph['8']['inputs']['engine']=control['engine'];graph['11']['inputs']['steps']=control['steps'];graph['12']['inputs']['noise_seed']=control['seed']
graph['17']['inputs']['filename_prefix']='H3/Ref2VA-'+STAMP
assert not any(k.startswith('ref_images.') or k.startswith('ref_videos.') for k in graph['5']['inputs'])
(REPORT/(STAMP+'.api.json')).write_text(json.dumps(graph,indent=2))
# Also provide an importable canvas with every orphan reference branch removed.
ui=json.loads((ROOT/'platforms/comfyui/workflows/ui/视频生成/H3 · 图像与视频混合参考.json').read_text())
keep={int(k) for k in graph}
ui['nodes']=[n for n in ui['nodes'] if n['id'] in keep or n['type']=='Note']
ui['links']=[link for link in ui['links'] if link[1] in keep and link[3] in keep]
valid_links={link[0] for link in ui['links']}
for node in ui['nodes']:
 if node['type']=='Note':node['widgets_values']=['无参考速度对照：保留Ref2VA、20步；尺寸和时长见参数；完整移除图片和视频参考分支，避免GetVideoComponents缺少video。'];continue
 for inp in node.get('inputs',[]):
  if inp.get('link') not in valid_links:inp['link']=None
 node['inputs']=[i for i in node.get('inputs',[]) if not i['name'].startswith(('ref_images.','ref_videos.','ref_video_audios.','ref_audios.'))]
 for out in node.get('outputs',[]):out['links']=[link for link in out.get('links',[]) if link in valid_links]
 if node['id']==5:
  node['widgets_values']=[control['prompt'],control['width'],control['height'],control['frames'],'match']
 if node['id']==17:node['widgets_values'][0]='H3/Ref2VA-'+STAMP
ui['extra']['workbench']={'id':'h3-no-reference-control','title':'H3 · 无参考速度对照（Ref2VA）'}
(REPORT/(STAMP+'.workflow.json')).write_text(json.dumps(ui,ensure_ascii=False,indent=2))
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
