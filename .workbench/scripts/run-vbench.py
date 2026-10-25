#!/usr/bin/env python3
"""Run four upstream VBench dimensions using the qualified isolated ROCm image."""
import importlib.util,json,os,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('paiton_controller',ROOT/'engines/shared/paiton/controller.py')
controller=importlib.util.module_from_spec(spec);spec.loader.exec_module(controller)
controller.require_idle()
source=Path(sys.argv[1]).resolve();output=Path(sys.argv[2]).resolve()
if not source.exists():raise SystemExit('Input video path does not exist')
cache=ROOT/'workspace/data/vbench'
image='local-ai-vbench:rocm101'
metadata=json.loads(subprocess.check_output(['docker','image','inspect',image],text=True))[0]
(output/'protocol.json').write_text(json.dumps({'image':image,'image_id':metadata['Id'],'source':str(source),'dimensions':['subject_consistency','background_consistency','temporal_flickering','motion_smoothness'],'mode':'custom_input','full_leaderboard_score':False},indent=2)+'\n')
cmd=['docker','run','--rm','--name','ai-vbench','--user',f'{os.getuid()}:{os.getgid()}','-e','HOME=/cache','-e','USER=ai-workbench','--network','none','--device','/dev/kfd','--device','/dev/dri','--group-add',str(os.stat('/dev/kfd').st_gid),'--shm-size','4g','--memory','16g','--cpus','8','-e','OMP_NUM_THREADS=4','-e','OPENBLAS_NUM_THREADS=4','-v',str(source)+':/videos:ro','-v',str(cache)+':/cache','-v',str(output)+':/results',image,'--videos_path','/videos','--output_path','/results','--load_ckpt_from_local','True','--mode','custom_input','--dimension','subject_consistency','background_consistency','temporal_flickering','motion_smoothness']
env=dict(os.environ,GPU_GUARD_WORKER='ai-vbench',GPU_GUARD_TIMEOUT='1200')
raise SystemExit(subprocess.run([sys.executable,str(ROOT/'.workbench/scripts/guard-image-test.py'),'--command',*cmd],env=env).returncode)
