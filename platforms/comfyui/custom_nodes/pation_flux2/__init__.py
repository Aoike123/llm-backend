"""ComfyUI image node for the local FLUX.2 klein engine services."""
import base64
from io import BytesIO
import json
import os
import threading
from urllib.error import HTTPError,URLError
from urllib.request import Request,urlopen
import numpy as np
from PIL import Image
import torch
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from pation_api import request as gateway_request

_generation_lock=threading.Lock()
_endpoints={'Paiton':os.environ.get('PAITON_FLUX2_ENDPOINT','http://127.0.0.1:7861'),
            'Stock (Diffusers)':os.environ.get('PAITON_STOCK_ENDPOINT','http://127.0.0.1:7862')}


def request(endpoint,path,data):
    call=Request(endpoint+path,json.dumps(data).encode(),{'Content-Type':'application/json'})
    try:
        with urlopen(call,timeout=1230) as response:return json.load(response)
    except HTTPError as error:
        detail=json.load(error).get('error','Image generation failed.')
        raise RuntimeError(detail) from error
    except URLError as error:
        raise RuntimeError('The local image engine is unavailable. Start the FLUX.2 launch helper and check its logs.') from error


class PaitonFlux2:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required':{
            'engine':(list(_endpoints),),
            'prompt':('STRING',{'multiline':True,'default':'A small red fox on a mossy stone bridge in a misty woodland at sunrise.'}),
            'seed':('INT',{'default':42,'min':0,'max':0x1fffffffffffff,'control_after_generate':True})}}
    RETURN_TYPES=('IMAGE',)
    FUNCTION='generate'
    CATEGORY='Paiton'
    DESCRIPTION='Create a 1024 × 1024 image in four steps on your Radeon AI PRO R9700. The first image prepares the model.'

    @classmethod
    def IS_CHANGED(cls,**kwargs):
        return float('nan')

    def generate(self,engine,prompt,seed):
        if engine not in _endpoints:raise ValueError('Select Paiton or Stock (Diffusers).')
        result=gateway_request('/v1/images/generations',{'model':'flux2-klein','engine':engine,'prompt':prompt,'seed':seed})
        image=Image.open(BytesIO(base64.b64decode(result['data'][0]['b64_json']))).convert('RGB')
        pixels=torch.from_numpy(np.array(image,dtype=np.float32)/255.).unsqueeze(0)
        return (pixels,)


NODE_CLASS_MAPPINGS={'PaitonFlux2':PaitonFlux2}
NODE_DISPLAY_NAME_MAPPINGS={'PaitonFlux2':'FLUX.2 klein · Paiton / Stock'}
