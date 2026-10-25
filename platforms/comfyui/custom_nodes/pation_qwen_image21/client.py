"""Strict JSON bridge to the separately loaded Qwen-Image 2.1 worker."""
import base64
import json
from urllib.error import HTTPError,URLError
from urllib.request import Request,urlopen

ENDPOINT='http://127.0.0.1:18982'


def generate(prompt,size=1024,seed=42,mode='text-to-image',image_png=None,images_png=None):
    if not isinstance(prompt,str) or not prompt.strip() or len(prompt)>512:
        raise ValueError('提示词应为 1–512 个字符')
    if size not in (1024,2048):raise ValueError('仅支持 1024 或 2048 方图')
    if mode not in ('text-to-image','rgba','edit'):raise ValueError('不支持的生成模式')
    if type(seed) is not int or not 0<=seed<2**63:raise ValueError('seed 超出范围')
    if mode=='edit' and (size!=1024 or not (image_png or images_png)):raise ValueError('编辑需要输入图像，输出尺寸固定为 1024')
    if mode!='edit' and (image_png is not None or images_png is not None):raise ValueError('输入图像仅用于编辑模式')
    payload={'prompt':prompt,'size':f'{size}x{size}','seed':seed,'mode':mode,'n':1,'steps':40,'guidance':1.0,'response_format':'b64_json'}
    if images_png is not None:
        if not isinstance(images_png,list) or not 1<=len(images_png)<=4:raise ValueError('需要1–4张参考图')
        payload['images_b64']=[base64.b64encode(png).decode() for png in images_png]
    elif image_png is not None:payload['image_b64']=base64.b64encode(image_png).decode()
    path='/v1/images/edits' if mode=='edit' else '/v1/images/generations'
    request=Request(ENDPOINT+path,data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
    try:
        with urlopen(request,timeout=1200) as response:result=json.load(response)
    except HTTPError as error:
        try:message=json.loads(error.read()).get('error',str(error))
        except (ValueError,AttributeError):message=str(error)
        raise RuntimeError('Qwen-Image 服务返回：'+str(message)) from error
    except URLError as error:
        raise RuntimeError('Qwen-Image 服务未就绪；请执行 ./lab scheduler start（旧手动入口 ./lab pation-model-qwen-image-21 start）') from error
    png=base64.b64decode(result['data'][0]['b64_json'],validate=True)
    if not png.startswith(b'\x89PNG\r\n\x1a\n'):raise ValueError('图像服务未返回有效 PNG')
    return png,result.get('metrics',{})
