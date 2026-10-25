"""Compact semantic layouts shared by generated UI workflows."""
H3={
 '1':(60,100,320,115,'扩散模型 · W4A8'), '2':(60,270,320,130,'文本/视觉编码器 · Qwen3-VL'),
 '3':(60,460,320,90,'视频 VAE · BF16'), '4':(60,610,320,90,'音频 VAE · FP32'),
 '6':(440,100,330,140,'Turbo LoRA · 可替换'), '7':(440,300,330,110,'视频/音频采样偏移'),
 '8':(440,480,330,100,'Paiton / Stock · 模型优化'),
 '5':(840,100,420,440,'提示词与首尾帧条件'), '12':(840,630,330,100,'随机噪声 · 固定种子'),
 '11':(840,800,330,145,'调度器 · 步数'), '9':(1330,100,320,100,'条件引导'),
 '10':(1330,280,320,95,'采样算法'), '13':(1330,460,320,230,'高级采样 · LATENT'),
 '14':(1720,100,320,110,'视频解码 · IMAGE'), '15':(1720,310,320,110,'音频解码 · AUDIO'),
 '16':(2110,100,360,140,'合成视频与原生音频'), '17':(2110,320,360,450,'保存与预览 · MP4'),
 '100':(60,820,320,320,'首帧 · 请替换图片'), '101':(440,820,330,320,'尾帧 · 请替换图片'),
}
WAN={
 '1':(60,100,330,150,'加载模型 / 编码器 / VAE'), '2':(60,340,330,150,'时长、分辨率与方向'),
 '5':(60,600,330,320,'参考首帧 · 无图选择 (none)'),
 '3':(460,100,410,270,'正向提示词 · CONDITIONING'), '4':(460,450,410,270,'负向提示词 · CONDITIONING'),
 '6':(940,260,320,240,'初始化 LATENT · 首帧与尺寸'), '7':(1330,100,320,430,'采样 · 算法/步数/CFG/种子'),
 '8':(1720,100,320,110,'VAE 解码 · IMAGE'), '9':(2110,100,360,140,'合成视频 · 24 fps'),
 '10':(2110,330,360,450,'保存与预览 · MP4'),
}

def arrange(nodes,entry):
    layout={'h3':H3,'wan':WAN}.get(entry.get('execution'))
    for node in nodes:
        node['bgcolor']='#252830'
        node['color']='#333641'
        if layout and str(node['id']) in layout:
            x,y,w,h,title=layout[str(node['id'])]
            node.update(pos=[x,y],size=[w,h],title=title)
        elif node['type']=='PrimitiveStringMultiline':
            node['title']='提示词 · 可连接其他文本节点'
            node['size']=[390,270]
        elif node['type']=='PrimitiveInt':
            node['title']='随机种子 · 固定可复现'
            node['size']=[390,110]
        elif node['type'].startswith(('Paiton','Pation')):
            node['title']+=' · API 后端'
        elif node['type']=='PreviewImage':
            node['title']='预览图像'
    if entry['id'].startswith('minimax-h3-multireference'):
        image_index=video_index=0
        for node in nodes:
            kind=node['type']
            if kind=='LoadImage':
                node.update(pos=[60,1200+image_index*400],size=[320,320],title=f'参考图 {image_index+1} · 可添加至9张');image_index+=1
            elif kind=='LoadVideo':
                node.update(pos=[440,1200+video_index*500],size=[330,320],title=f'参考视频 {video_index+1} · 可添加至3段');video_index+=1
            elif kind=='GetVideoComponents':
                i=(node['id']-201)//3;node.update(pos=[840,1200+i*500],size=[330,170],title=f'视频 {i+1} · 画面与原音轨')
            elif kind=='MiniMaxH3ReferenceVideoFrames':
                i=(node['id']-202)//3;node.update(pos=[1330,1200+i*500],size=[330,170],title=f'视频 {i+1} · 转24fps')
            elif kind=='MiniMaxH3ReferenceToVideo':node.update(size=[420,650],title='多模态参考 · 9图 + 3视频')
            elif kind=='RandomNoise':node.update(pos=[840,840])
            elif kind=='BasicScheduler':node.update(pos=[840,1010])
    if not layout:
        pipeline=entry['id']=='qwen-image21-references-to-h3'
        has_images=any(n['type']=='LoadImage' for n in nodes)
        batch=any(n['type']=='ImageBatch' for n in nodes)
        rgba=any(n['type']=='JoinImageWithAlpha' for n in nodes)
        image_row=0;text_row=0;seed_row=0
        prompt_x=460 if has_images else 60
        generate_x=940 if has_images else 540
        for node in nodes:
            kind=node['type']
            if kind=='LoadImage':
                node.update(pos=[60,100+image_row*400],size=[330,320],title='参考图 '+str(image_row+1)+' · 请替换图片');image_row+=1
            elif kind=='PrimitiveStringMultiline':
                x=1380 if pipeline and text_row else prompt_x
                node.update(pos=[x,100],size=[390,270],title=('视频提示词' if pipeline and text_row else '图像提示词')+' · 原生文本');text_row+=1
            elif kind=='PrimitiveInt':
                x=1380 if pipeline and seed_row else prompt_x
                node.update(pos=[x,450],size=[390,110]);seed_row+=1
            elif kind=='ImageBatch':node.update(pos=[460,650],size=[390,100])
            elif kind.startswith(('PationQwen','PaitonFlux')):node.update(pos=[generate_x,100],size=[390,330])
            elif kind=='PationH3Video':node.update(pos=[1840,100],size=[390,430],title='H3 · 跨模型 API 生成')
            elif kind=='JoinImageWithAlpha':node.update(pos=[generate_x+450,100],size=[330,130],title='合并图像与透明度')
            elif kind=='SaveImage':
                node.update(pos=[generate_x if pipeline else generate_x+(900 if rgba else 450),550 if pipeline else 100],size=[390,330],title='保存中间首帧' if pipeline else '保存图像')
            elif kind=='PreviewImage':node.update(pos=[generate_x+450,520],size=[390,330])
            elif kind=='SaveVideo':node.update(pos=[2300,100],size=[390,600])

def make_groups(nodes,entry):
    model=entry.get('execution')
    if model=='h3':
        groups=[('01 · 加载模型与编码器',[35,45,370,690]),('02 · LoRA 与优化',[415,45,380,690]),
                ('03 · 条件、噪声与步数',[815,45,470,940]),('04 · 采样',[1305,45,370,690]),
                ('05 · 视频/音频解码',[1695,45,370,440]),('06 · 合成与输出',[2085,45,410,770])]
        if any(n['type']=='LoadImage' for n in nodes):groups.append(('参考图片 · 请替换输入',[35,765,760,415]))
    elif model=='wan':
        groups=[('01 · 模型与输入',[35,45,380,940]),('02 · 文本条件',[435,45,460,720]),
                ('03 · LATENT',[915,205,370,340]),('04 · 采样',[1305,45,370,530]),
                ('05 · 解码',[1695,45,370,240]),('06 · 合成与输出',[2085,45,410,795])]
    else:
        columns={}
        for n in nodes:columns.setdefault(n['pos'][0],[]).append(n)
        groups=[]
        for index,(x,items) in enumerate(sorted(columns.items())):
            kinds={n['type'] for n in items}
            name='输入 · 提示词 / 种子 / 参考图' if kinds <= {'PrimitiveStringMultiline','PrimitiveInt','LoadImage'} else '输出 · 预览与保存' if kinds <= {'SaveImage','SaveVideo','PreviewImage'} else '处理 · 图像与参数'
            if any(k.startswith(('Paiton','Pation')) for k in kinds):name='生成 · API 后端'
            y=min(n['pos'][1] for n in items);bottom=max(n['pos'][1]+n['size'][1] for n in items)
            groups.append((name,[x-20,y-55,430,bottom-y+80]))
    return [{'title':name,'bounding':bounds,'color':'#626878','font_size':22,'flags':{}} for name,bounds in groups]

def add_notes(nodes,entry):
    mode=entry.get('execution')
    if mode=='h3':
        text='原生 H3：MODEL、CLIP、VAE、CONDITIONING、LATENT、IMAGE、AUDIO 均在同一个 GPU 工作进程中连接。\n修改 LoRA、采样器、步数后按实际输出重新验证。Turbo8 默认 8 步；Turbo4 需同时替换为匹配的 4 步 LoRA。\n权重：workspace/data/video/minimax-h3/models → GPU 容器模型目录；公共页面不重复加载权重。'
        if entry['id'].startswith('minimax-h3-multireference'):
            text='Ref2VA 多模态参考：最多9张图 + 3段视频（各2–15秒，视频总时长≤15秒）。在参考节点接线后继续添加同类输入。\n提示词用 <Picture 1> / <Video 1> 指定身份、服装、动作或运镜；视频经24fps转换，不是只取首帧。\n默认20步质量档；4步预览需同时换专用Ref2V LoRA。动态显存卸载已启用；大量参考与15秒高分辨率组合需实测。\n参考视频不得长于输出，底层会截断；length按17k+5对齐，360对应约15秒。视频音轨需要时从GetVideoComponents接到同编号ref_video_audio。'
        pos=[1720,860]
    elif mode=='wan':
        text='原生 Wan：加载器分别输出 MODEL、CLIP、VAE；正负条件、采样与解码可单独连接。\n无参考图时选择 (none)；参考首帧不等于任意人物一致性控制。\n权重：workspace/data/video/wan22/models → GPU 容器模型目录；当前模板不使用未验收的 FastWan 三步权重。'
        pos=[1330,860]
    else:
        text='图像输入、文本、种子、预览与保存使用 ComfyUI 原生节点。\n标注 API 后端的节点调用当前已验证的优化运行时，不提供 MODEL / LATENT 中间对象。\nFLUX 官方 Paiton 路径为整图生成；Qwen-Image 2.1 的 RGBA / 多参考编辑仍使用专用 API。未伪造模型加载、LoRA 或采样接口。\n挂载详情：docs/COMFYUI_NATIVE.md。'
        pos=[80,max(n['pos'][1]+n['size'][1] for n in nodes)+110]
    nodes.append({'id':max(n['id'] for n in nodes)+1,'type':'Note','title':'执行方式与模型挂载','pos':pos,'size':[730,230],
                  'flags':{},'order':len(nodes),'mode':0,'properties':{},'widgets_values':[text], 'color':'#343943','bgcolor':'#252830'})
