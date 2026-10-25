"""CPU bridge to the separately managed MiniMax H3 ComfyUI worker."""
import sys
from pathlib import Path as _SchedulerPath
sys.path.insert(0,str(_SchedulerPath(__file__).resolve().parents[1]))

import io,json,time,uuid,threading
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request,urlopen
import numpy as np
from PIL import Image
import folder_paths
from comfy_api.latest import InputImpl
from pation_api import request, encoded_frame, download

class PationH3Video:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required':{'prompt':('STRING',{'multiline':True,'default':'A red fox walks through a sunlit forest. Audio: birds and gentle rustling.'}),'preset':(['turbo8','turbo4'],),'width':('INT',{'default':864,'min':320,'max':1280,'step':32}),'height':('INT',{'default':480,'min':320,'max':768,'step':32}),'frames':('INT',{'default':124,'min':124,'max':364,'step':4}),'seed':('INT',{'default':771,'min':0,'max':2**63-1})},'optional':{'first_frame':('IMAGE',),'last_frame':('IMAGE',)}}
    RETURN_TYPES=('VIDEO','STRING')
    RETURN_NAMES=('video','metrics')
    FUNCTION='generate';CATEGORY='Pation/MiniMax H3'
    DESCRIPTION='文生视频、参考图生视频与首尾帧。含音频；由常驻API自动切换H3服务；参考图约束首帧，非任意多参考身份控制。'
    @classmethod
    def IS_CHANGED(cls,**kwargs):return float('nan')
    def generate(self,prompt,preset,width,height,frames,seed,first_frame=None,last_frame=None):
        payload={'model':'minimax-h3','prompt':prompt,'preset':preset,'width':width,'height':height,'frames':frames,'seed':seed}
        if first_frame is not None:payload['first_frame_b64']=encoded_frame(first_frame)
        if last_frame is not None:payload['last_frame_b64']=encoded_frame(last_frame)
        result=request('/v1/videos/generations',payload)
        path=Path(folder_paths.get_temp_directory())/('h3-'+uuid.uuid4().hex+'.mp4')
        path.write_bytes(download(result['data'][0]['url']))
        return InputImpl.VideoFromFile(str(path)),json.dumps(result['metrics'],ensure_ascii=False)

NODE_CLASS_MAPPINGS={'PationH3Video':PationH3Video}
NODE_DISPLAY_NAME_MAPPINGS={'PationH3Video':'MiniMax H3 · 文生 / 参考图 / 首尾帧视频'}
