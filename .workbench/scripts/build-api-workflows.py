"""Build grouped Chinese UI templates from cataloged API graphs and live schemas."""
import argparse
import json
from pathlib import Path
from urllib.request import urlopen
ROOT=Path(__file__).resolve().parents[2];HERE=ROOT/'platforms/comfyui/workflows'
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--schema',type=Path);args=parser.parse_args()
if args.schema:public_info=json.loads(args.schema.read_text())
else:
 with urlopen('http://127.0.0.1:8188/object_info',timeout=10) as response:public_info=json.load(response)
entries=json.loads((HERE/'catalog.json').read_text())['workflows']
for entry in entries:
 info=public_info
 if not entry.get('api') or entry['category']=='第三方工作流':continue
 graph=json.loads((HERE/entry['api']).read_text());nodes=[];links=[];link_id=0;depth={};visiting=set()
 def layer(key):
  if key in depth:return depth[key]
  if key in visiting:raise ValueError('Workflow cycle: '+entry['id'])
  visiting.add(key);parents=[]
  for value in graph[key]['inputs'].values():
   if isinstance(value,list) and len(value)==2 and isinstance(value[0],str) and value[0] in graph:
    parents.append(value[0])
  depth[key]=max((layer(p)+1 for p in parents),default=0);visiting.remove(key);return depth[key]
 for key in graph:layer(key)
 columns={};groups=[]
 for order,key in enumerate(sorted(graph,key=lambda k:(depth[k],int(k)))):
  node=graph[key];schema=info[node['class_type']];inputs=[];widgets=[]
  defs={}
  def expand(fields,prefix=''):
   for group in ('required','optional'):
    for name,definition in fields.get(group,{}).items():
     options=definition[1] if len(definition)>1 else {}
     if options.get('hidden'):continue
     full=prefix+name
     if definition[0]=='COMFY_AUTOGROW_V3':
      template=options['template'];item=next(iter(next(iter(template['input'].values())).values()))
      names=template.get('names') or [template['prefix']+str(i) for i in range(template['max'])]
      connected=[i for i,n in enumerate(names) if full+'.'+n in node['inputs']]
      count=min(len(names),max(template.get('min',0),max(connected,default=-1)+2,1))
      for n in names[:count]:defs[full+'.'+n]=item
      continue
     defs[full]=definition
     if definition[0]=='COMFY_DYNAMICCOMBO_V3':
      choices=options['options'];selected=node['inputs'].get(full,choices[0]['key'])
      match=next((o for o in choices if o['key']==selected),None)
      if match is None:raise ValueError('Unsupported dynamic option '+full)
      expand(match.get('inputs',{}),full+'.')
  expand(schema.get('input',{}))
  unknown=set(node['inputs'])-defs.keys()
  if unknown:raise ValueError(f'{entry["id"]}: unknown inputs {unknown}')
  for name,definition in defs.items():
   value=node['inputs'].get(name);dtype=definition[0];options=definition[1] if len(definition)>1 else {}
   # V3 nodes expose combos as COMBO + options; legacy nodes use a list.
   # Both create a widget and occupy a serialized widgets_values position.
   if dtype=='COMBO':dtype=options['options']
   is_link=isinstance(value,list) and len(value)==2 and isinstance(value[0],str) and value[0] in graph
   is_widget=isinstance(dtype,list) or dtype in ('STRING','INT','FLOAT','BOOLEAN','COMFY_DYNAMICCOMBO_V3')
   if is_link:
    source,source_slot=value;outputs=info[graph[source]['class_type']].get('output',[])
    if not isinstance(source_slot,int) or not 0<=source_slot<len(outputs):raise ValueError('Invalid source slot')
    if outputs[source_slot]!=dtype:raise ValueError(f'{entry["id"]}: incompatible link {outputs[source_slot]} -> {dtype}')
    link_id+=1;slot=len(inputs);links.append([link_id,int(source),source_slot,int(key),slot,dtype])
    inputs.append({'name':name,'type':dtype,'link':link_id,**({'widget':{'name':name}} if is_widget else {})})
    if is_widget:
     linked=graph[source]
     placeholder=linked['inputs'].get('value',options.get('default',dtype[0] if isinstance(dtype,list) else 0 if dtype in ('INT','FLOAT') else False if dtype=='BOOLEAN' else ''))
     widgets.append(placeholder)
     if options.get('control_after_generate') or (name in ('seed','noise_seed') and dtype=='INT' and options.get('control_after_generate') is not False):widgets.append('fixed')
   elif not is_widget:inputs.append({'name':name,'type':dtype,'link':None})
   else:
    if dtype=='COMFY_DYNAMICCOMBO_V3':value=value if value is not None else options['options'][0]['key']
    inputs.append({'name':name,'type':'COMBO' if isinstance(dtype,list) else dtype,'widget':{'name':name},'link':None})
    value=value if value is not None else options.get('default',dtype[0] if isinstance(dtype,list) else 0 if dtype in ('INT','FLOAT') else False if dtype=='BOOLEAN' else '')
    if isinstance(dtype,list) and value not in dtype and not (node['class_type'] in ('LoadImage','LoadVideo')):raise ValueError(f'{entry["id"]}: unsupported {name}={value}')
    widgets.append(value)
    if options.get('control_after_generate') or (name in ('seed','noise_seed') and dtype=='INT' and options.get('control_after_generate') is not False):widgets.append('fixed')
  if node['class_type']=='LoadImage':widgets.append('image')
  outs=[{'name':schema.get('output_name',schema['output'])[i],'type':dtype,'links':[]} for i,dtype in enumerate(schema.get('output',[]))]
  col=depth[key];row=columns.get(col,0);columns[col]=row+1
  title=schema.get('display_name',node['class_type'])
  if node['class_type']=='LoadImage':title='参考图 '+str(row+1)+' · 请替换图片'
  if node['class_type']=='SaveImage':title='保存图像'
  if node['class_type']=='SaveVideo':title='保存视频'
  if node['class_type']=='ImageBatch':title='合并参考批次 · 输入尺寸需一致'
  nodes.append({'id':int(key),'type':node['class_type'],'title':title,'pos':[80+col*470,100+row*420],
                'size':[390,350],'flags':{},'order':order,'mode':0,'inputs':inputs,'outputs':outs,
                'color':'#243b36' if node['class_type']=='LoadImage' else '#333045' if 'Pation' in node['class_type'] or 'Paiton' in node['class_type'] else '#293545',
                'bgcolor':'#1b232b','properties':{'Node name for S&R':node['class_type']},'widgets_values':widgets})
 from workflow_layout import arrange
 arrange(nodes,entry)
 for link in links:
  next(n for n in nodes if n['id']==link[1])['outputs'][link[2]]['links'].append(link[0])
 from workflow_layout import make_groups, add_notes
 groups=make_groups(nodes,entry)
 add_notes(nodes,entry)
 target=HERE/entry['ui'];target.parent.mkdir(parents=True,exist_ok=True)
 target.write_text(json.dumps({'last_node_id':max(n['id'] for n in nodes),'last_link_id':link_id,'nodes':nodes,'links':links,'groups':groups,'config':{},'extra':{'ds':{'scale':.55 if entry.get('execution')=='h3' else .8,'offset':[0,0]},'workbench':{'id':entry['id'],'title':entry['title']}},'version':.4},ensure_ascii=False,indent=2)+'\n')
 print(entry['ui'])
