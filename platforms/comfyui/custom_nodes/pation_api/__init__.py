"""CPU-only clients of the permanent local inference gateway."""
import base64
import io
import json
import os
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import numpy as np
from PIL import Image

BASE=os.environ.get('AI_WORKBENCH_API','http://127.0.0.1:18982').rstrip('/')
NODE_CLASS_MAPPINGS={}


def request(path,body):
    try:
        with urlopen(Request(BASE+path,data=json.dumps(body).encode(),headers={'Content-Type':'application/json'}),timeout=2700) as response:
            return json.load(response)
    except HTTPError as error:
        try:detail=json.load(error).get('error',str(error))
        except ValueError:detail=str(error)
        raise RuntimeError('本地 API：'+str(detail)) from error
    except URLError as error:
        raise RuntimeError('本地 API 未运行，请执行 ./lab scheduler start') from error


def image_pngs(images,max_count=4):
    batches=images if isinstance(images,(list,tuple)) else [images]
    result=[];pixels=0
    for batch in batches:
        if batch is None:continue
        if batch.ndim!=4 or batch.shape[-1] not in (3,4):raise ValueError('需要 ComfyUI IMAGE [B,H,W,C]')
        for frame in batch:
            pixels+=frame.shape[0]*frame.shape[1]
            if pixels>4194304:raise ValueError('参考图合计不能超过4,194,304像素，请先缩小')
            array=(frame.detach().cpu().clamp(0,1).numpy()*255).round().astype(np.uint8)
            out=io.BytesIO();Image.fromarray(array).save(out,format='PNG');result.append(out.getvalue())
    if not 1<=len(result)<=max_count:raise ValueError(f'需要1–{max_count}张参考图')
    return result


def encoded_frame(image):
    return base64.b64encode(image_pngs(image,max_count=1)[0]).decode()


def download(path):
    if not path.startswith('/artifacts/') or '..' in path:raise ValueError('无效视频产物路径')
    with urlopen(BASE+path,timeout=120) as response:return response.read()
