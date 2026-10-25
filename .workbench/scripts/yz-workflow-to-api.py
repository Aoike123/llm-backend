import json,urllib.request
from pathlib import Path
wf=json.load(open('/mnt/Code/llm-backend/workspace/reports/YZ-h3-workflow-test-20261020.json'))
info=json.load(urllib.request.urlopen('http://127.0.0.1:8188/object_info',timeout=30))
nodes={n['id']:n for n in wf['nodes']}
links={l[0]:l for l in wf['links']}
sets={}
for n in wf['nodes']:
    if n['type']=='SetNode' and n.get('widgets_values'):
        sets[n['widgets_values'][0]]=n
api={}
visiting=set()
WIDGET={'INT','FLOAT','STRING','BOOLEAN'}

def spec_of(cls,name):
    inp=info[cls]['input']
    for sec in ('required','optional'):
        if name in inp.get(sec,{}): return inp[sec][name]
    return None

def is_widget(spec):
    if not isinstance(spec,list) or not spec: return False
    t=spec[0]
    if isinstance(t,list): return True
    if t in WIDGET or t in ('COMBO','COMFY_DYNAMICCOMBO_V3'): return True
    return False

def control_after(spec):
    return isinstance(spec,list) and len(spec)>1 and isinstance(spec[1],dict) and spec[1].get('control_after_generate')

def widget_inputs(node):
    cls=node['type']; wv=node.get('widgets_values'); out={}
    order=info[cls]['input_order']; names=list(order.get('required',[]))+list(order.get('optional',[]))
    if isinstance(wv,dict):
        candidate=set(names)|{'pix_fmt','crf'}
        for k,v in wv.items():
            if k in candidate and k not in ('videopreview',): out[k]=v
        return out
    if not isinstance(wv,list): return out
    idx=0
    for name in names:
        spec=spec_of(cls,name)
        if not is_widget(spec): continue
        if idx>=len(wv): break
        out[name]=wv[idx]; idx+=1
        if control_after(spec) and idx<len(wv): idx+=1
        if isinstance(spec,list) and spec and spec[0]=='COMFY_DYNAMICCOMBO_V3':
            selected=out[name]
            for opt in spec[1].get('options',[]):
                if opt.get('key')==selected:
                    for sub in opt.get('inputs',{}).get('required',{}):
                        sub_spec=opt['inputs']['required'][sub]
                        if is_widget(sub_spec) and idx<len(wv):
                            out[name+'.'+sub]=wv[idx]; idx+=1
                            if control_after(sub_spec) and idx<len(wv): idx+=1
                    break
    return out

def resolve_input(node):
    for i in node.get('inputs',[]):
        if i.get('link') in links: return i
    return None

def out_value(link_id):
    l=links.get(link_id)
    if not l: return None
    _,oid,oslot,_,_,_=l
    n=nodes[oid]
    mode=n.get('mode',0)
    if mode==2: return None
    if n['type']=='Reroute':
        inp=resolve_input(n)
        return out_value(inp['link']) if inp else None
    if n['type']=='GetNode':
        name=(n.get('widgets_values') or [''])[0]
        st=sets.get(name)
        if not st: return ('MISSING_SET',name)
        inp=resolve_input(st)
        return out_value(inp['link']) if inp else None
    otype=None
    try: otype=n.get('outputs',[])[oslot].get('type')
    except Exception: pass
    if mode==4:
        cands=[i for i in n.get('inputs',[]) if i.get('link') and (i.get('type')==otype or i.get('type')=='*' or otype=='*')]
        return out_value(cands[0]['link']) if cands else None
    emit(oid)
    return [str(oid),oslot]

def emit(nid):
    if nid in api or nid in visiting: return
    n=nodes[nid]
    visiting.add(nid)
    cls=n['type']
    inputs=widget_inputs(n)
    for i in n.get('inputs',[]):
        if i.get('link') in links:
            v=out_value(i['link'])
            if v is not None: inputs[i['name']]=v
    api[nid]={'class_type':cls,'inputs':inputs}
    visiting.discard(nid)

# prompt override
for n in wf['nodes']:
    if n['type']=='Text' and n['id']==263:
        n['widgets_values']=['Use <Picture 1>, <Picture 2> and <Picture 3> as references for the characters, clothing and environment. A cinematic continuous shot with natural body motion, coherent anatomy and smooth camera movement. Audio: ambient room tone with light rain.']
# save node
save=[n for n in wf['nodes'] if n['type']=='VHS_VideoCombine'][0]
emit(save['id'])
print('api nodes',len(api))
for k,v in sorted(api.items(),key=lambda kv:int(kv[0])):
    print(k,v['class_type'],json.dumps(v['inputs'],ensure_ascii=False)[:160])
json.dump(api,open('/tmp/yz.api.json','w'),ensure_ascii=False,indent=1)
