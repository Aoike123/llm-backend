"""ComfyUI image API nodes. All model compute stays in the image worker."""
import sys
from pathlib import Path as _SchedulerPath
sys.path.insert(0,str(_SchedulerPath(__file__).resolve().parents[1]))
from pation_api import image_pngs
import io
import json
import numpy as np
from PIL import Image
import torch
from .client import generate


def tensors(png):
    image=Image.open(io.BytesIO(png)).convert('RGBA')
    values=np.asarray(image).astype(np.float32)/255.0
    rgb=torch.from_numpy(values[:,:,:3].copy())[None,]
    # ComfyUI MASK uses 1 for transparency/inpaint, 0 for opaque areas.
    mask=torch.from_numpy((1.0-values[:,:,3]).copy())[None,]
    return rgb,mask


class PationQwenImage21Generate:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required':{'prompt':('STRING',{'multiline':True,'default':'A red ceramic teapot on a wooden table, soft daylight'}),'size':(['1024','2048'],),'mode':(['text-to-image','rgba'],),'seed':('INT',{'default':42,'min':0,'max':2**63-1})}}
    RETURN_TYPES=('IMAGE','MASK','STRING')
    RETURN_NAMES=('image','alpha_mask','metrics')
    FUNCTION='run'
    CATEGORY='Pation/Qwen-Image 2.1'
    DESCRIPTION='调用本机 Qwen-Image 2.1 引擎：40步、guidance 1、batch 1。RGBA 的 alpha 保存在 mask 输出中。'
    def run(self,prompt,size,mode,seed):
        png,metrics=generate(prompt,int(size),seed,mode)
        image,mask=tensors(png)
        return image,mask,json.dumps(metrics,ensure_ascii=False)


class PationQwenImage21Edit:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required':{'image':('IMAGE',),'prompt':('STRING',{'multiline':True,'default':'Change the teapot to blue. Keep the composition unchanged.'}),'seed':('INT',{'default':42,'min':0,'max':2**63-1})}}
    RETURN_TYPES=('IMAGE','MASK','STRING')
    RETURN_NAMES=('image','alpha_mask','metrics')
    FUNCTION='run'
    CATEGORY='Pation/Qwen-Image 2.1'
    DESCRIPTION='图片批次作为同一次编辑的1–4张参考图，合计不超过4,194,304像素，输出为1024方图。'
    def run(self,image,prompt,seed):
        png,metrics=generate(prompt,1024,seed,'edit',images_png=image_pngs(image))
        rgb,mask=tensors(png)
        return rgb,mask,json.dumps(metrics,ensure_ascii=False)


NODE_CLASS_MAPPINGS={'PationQwenImage21Generate':PationQwenImage21Generate,'PationQwenImage21Edit':PationQwenImage21Edit}
NODE_DISPLAY_NAME_MAPPINGS={'PationQwenImage21Generate':'Qwen-Image 2.1 · 文生图 / RGBA','PationQwenImage21Edit':'Qwen-Image 2.1 · 图像编辑'}


class PationQwenImage21References(PationQwenImage21Edit):
    INPUT_IS_LIST=True
    @classmethod
    def INPUT_TYPES(cls):
        return {'required':{'images':('IMAGE',),'prompt':('STRING',{'multiline':True,'default':'Use image 1 for the subject and image 2 for the setting. Create a coherent scene.'}),'seed':('INT',{'default':42,'min':0,'max':2**63-1})},
                'optional':{name:('IMAGE',) for name in ('image_2','image_3','image_4')}}
    DESCRIPTION='接收成熟节点输出的IMAGE批次或IMAGE列表，以及独立参考图。按输入顺序送入同一次多图编辑，不拼成一张图。'
    def run(self,images,prompt,seed,image_2=None,image_3=None,image_4=None):
        references=[*images,*(image_2 or []),*(image_3 or []),*(image_4 or [])]
        if len(prompt)!=1 or len(seed)!=1:raise ValueError('一组参考图对应一个提示词和seed')
        png,metrics=generate(prompt[0],1024,seed[0],'edit',images_png=image_pngs(references))
        rgb,mask=tensors(png)
        return rgb,mask,json.dumps(metrics,ensure_ascii=False)

NODE_CLASS_MAPPINGS['PationQwenImage21References']=PationQwenImage21References
NODE_DISPLAY_NAME_MAPPINGS['PationQwenImage21References']='Qwen-Image 2.1 · 多参考图编辑（批次 / 列表）'
