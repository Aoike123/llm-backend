#!/usr/bin/env python3
"""Exercise real H3 reference paths through the scheduled public API."""
import argparse,base64,json,subprocess,time,threading
from pathlib import Path
from urllib.request import Request,urlopen
ROOT=Path(__file__).resolve().parents[2]
REPORT=ROOT/'workspace/reports/h3-reference-20261019'
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--case',choices=['image-quality','video-quality','mixed','maximum','long-quality','maximum-quality'],required=True)
p.add_argument('--prepare-only',action='store_true')
p.add_argument('--engine',choices=['stock','paiton'],default='stock')
a=p.parse_args();REPORT.mkdir(parents=True,exist_ok=True)
fixtures=REPORT/'fixtures';fixtures.mkdir(exist_ok=True)
source=ROOT/'workspace/outputs/video/minimax-h3/MiniMax-H3/rocm101-turbo8-576x320_00001_.mp4'
def ffmpeg(*args):subprocess.run(['ffmpeg','-nostdin','-v','error',*map(str,args)],check=True)
for i in range(9):
 image=fixtures/f'fox-{i+1}.png'
 if not image.exists():ffmpeg('-ss',i*.45,'-i',source,'-frames:v',1,'-threads',1,'-y',image)
for i in range(3):
 clip=fixtures/f'motion-{i+1}.mp4'
 if not clip.exists():ffmpeg('-ss',i*1.5,'-i',source,'-t',2,'-vf','fps=30,scale=576:320','-c:v','libx264','-preset','fast','-crf',18,'-c:a','aac','-threads',2,'-y',clip)
if a.prepare_only:
 print('Prepared',fixtures);raise SystemExit()
b64=lambda path:base64.b64encode(path.read_bytes()).decode()
body={'model':'minimax-h3','prompt':'Use <Picture 1> as the reference for the fox appearance. The same red fox slowly walks through a sunlit forest clearing and looks at the camera. Natural detailed fur, coherent anatomy, smooth motion. Audio: birds and quiet rustling, no music.',
      'preset':'reference','width':576,'height':320,'frames':124,'seed':771,'engine':a.engine}
if a.case in ('image-quality','long-quality','mixed','maximum','maximum-quality'):body['reference_images_b64']=[b64(fixtures/'fox-1.png')]
if a.case in ('video-quality','mixed','maximum','maximum-quality'):
 body['reference_videos_b64']=[b64(fixtures/'motion-1.mp4')]
 body['prompt']='Use <Video 1> as the reference for fox appearance, natural walking motion and camera movement. '+('Use <Picture 1> for detailed fur appearance. ' if a.case!='video-quality' else '')+'The fox walks through a forest clearing and turns its head toward camera. Natural daylight, coherent anatomy and continuous shot. Audio: quiet forest ambience.'
if a.case=='mixed':body['reference_images_b64'].append(b64(fixtures/'fox-6.png'))
if a.case in ('maximum','maximum-quality'):
 body['reference_images_b64']=[b64(fixtures/f'fox-{i+1}.png') for i in range(9)]
 body['reference_videos_b64']=[b64(fixtures/f'motion-{i+1}.mp4') for i in range(3)]
 body['preset']='reference-turbo4';body['prompt']='All nine pictures show the same fox from different moments. Keep its appearance consistent. Follow <Video 1>, <Video 2> and <Video 3> for its walking and head movement. A continuous cinematic woodland shot, coherent anatomy. Audio: forest ambience.'
if a.case in ('long-quality','maximum-quality'):body.update(width=864,height=480,frames=360,steps=20,preset='reference')
start=time.monotonic();stamp=a.case+'-'+a.engine
stop=threading.Event();samples=[]
vram_paths=list(Path('/sys/class/drm').glob('card[0-9]*/device/mem_info_vram_used'))
def monitor():
 while not stop.is_set():
  row={'seconds':time.monotonic()-start}
  try:row['vram_used_bytes']=sum(int(path.read_text()) for path in vram_paths)
  except OSError:pass
  try:row['available_ram_bytes']=int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')))*1024
  except (OSError,StopIteration):pass
  samples.append(row);stop.wait(1)
thread=threading.Thread(target=monitor,daemon=True);thread.start()
meta={k:v for k,v in body.items() if not k.endswith('_b64')};meta.update(reference_image_count=len(body.get('reference_images_b64',[])),reference_video_count=len(body.get('reference_videos_b64',[])))
(REPORT/(stamp+'-request.json')).write_text(json.dumps(meta,indent=2));print('Submitting',stamp,meta,flush=True)
try:
 with urlopen(Request('http://127.0.0.1:18982/v1/videos/generations',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'}),timeout=3600) as r:result=json.load(r)
 result['wall_seconds']=time.monotonic()-start
 result['peak_device_vram_bytes']=max((s.get('vram_used_bytes',0) for s in samples),default=0)
 result['minimum_available_ram_bytes']=min((s.get('available_ram_bytes',2**63) for s in samples),default=None)
 url=result['data'][0]['url']
 with urlopen('http://127.0.0.1:18982'+url,timeout=90) as r:(REPORT/(stamp+'.mp4')).write_bytes(r.read())
 info=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_format','-show_streams','-of','json',str(REPORT/(stamp+'.mp4'))]))
 result['output_probe']=info
 output=next(s for s in info['streams'] if s['codec_type']=='video')
 expected_frames=body['frames']+((5-body['frames']%17+17)%17)
 assert int(output['nb_frames'])==expected_frames, ('Wrong artifact frame count',output['nb_frames'],expected_frames)
 assert (output['width'],output['height'])==(body['width'],body['height'])
 assert any(s['codec_type']=='audio' for s in info['streams']), 'H3 generated output must contain its audio track'
 (REPORT/(stamp+'-result.json')).write_text(json.dumps(result,indent=2))
 (REPORT/(stamp+'-error.json')).unlink(missing_ok=True)
 print(json.dumps({k:result[k] for k in ['metrics','wall_seconds']},indent=2),flush=True)
except Exception as error:
 detail=error.read().decode() if hasattr(error,'read') else str(error)
 (REPORT/(stamp+'-error.json')).write_text(json.dumps({'error':detail,'wall_seconds':time.monotonic()-start},indent=2));raise

finally:
 stop.set();thread.join(timeout=2)
 (REPORT/(stamp+'-memory.json')).write_text(json.dumps(samples,indent=2))
