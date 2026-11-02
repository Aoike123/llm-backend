'use client';
import {Fragment,useState} from 'react';
import {Icon} from './ui-controls.mjs';
// A readable view of exactly what MCP clients receive: per tool, every parameter with its type,
// limits, default and the models that accept it; collapsed advanced parameters open in place.
const TYPE={string:'文本',integer:'整数',number:'数字',boolean:'开关',array:'列表',object:'对象'};
const COMMON=['list_media_models','import_media','get_job','cancel_job','get_artifact'];
const size=value=>JSON.stringify(value).length;
function typeOf(s){
  if(s.enum)return '选项';
  if(s.type==='array')return '列表<'+(TYPE[s.items?.type]??s.items?.type??'?')+'>';
  return TYPE[s.type]??s.type??'—';
}
function limits(s){
  const out=[];
  if(s.enum)out.push(s.enum.join(' / '));
  if(s.maximum>=Number.MAX_SAFE_INTEGER)out.push('≥'+(s.minimum??0));
  else if(s.minimum!==undefined||s.maximum!==undefined)out.push((s.minimum??'')+'–'+(s.maximum??''));
  if(s.maxLength)out.push('≤'+s.maxLength+' 字');
  if(s.type==='array')out.push((s.minItems??0)+'–'+(s.maxItems??'∞')+' 项');
  if(s.pattern)out.push('格式受限');
  return out.join('；');
}
const fmtDefault=v=>v===undefined?'':typeof v==='object'?JSON.stringify(v):String(v);
// Which models take a parameter of a tool: base fields go to all; extras to models that declare them.
function acceptedBy(models,tool,key){
  const ids=models.filter(m=>Object.entries(m.parameters??{}).some(([k,list])=>k.startsWith(tool+'#')&&list.includes(key))).map(m=>m.id);
  return ids;
}
function fullSchema(models,tool,key){
  for(const m of models)for(const [k,schemas] of Object.entries(m.parameter_schemas??{}))if(k.startsWith(tool+'#')&&schemas[key])return schemas[key];
  return null;
}
export function Rows({schema,required=[],depth=0,tool,models,top=false}){
  const [open,setOpen]=useState({});
  return Object.entries(schema.properties??{}).map(([key,s])=>{
    const collapsed=s.type==='object'&&!s.properties&&top?fullSchema(models,tool,key):null,nested=s.properties?s:collapsed?.properties?collapsed:s.items?.properties?s.items:null;
    const by=top&&tool?acceptedBy(models,tool,key):[];
    return <Fragment key={key}><tr className={'param-row depth-'+depth}>
      <td><span className="param-name" style={{paddingLeft:depth*18}}>{nested?<button className="param-toggle" aria-expanded={!!open[key]} onClick={()=>setOpen(o=>({...o,[key]:!o[key]}))}><Icon name="chevron"/></button>:<i className="param-spacer"/>}<code>{key}</code>{collapsed&&<span className="param-tag">折叠</span>}</span></td>
      <td>{typeOf(s)}</td>
      <td>{required.includes(key)?<span className="param-required">必填</span>:<span className="muted">可选</span>}</td>
      <td className="param-limits">{limits(s)}{fmtDefault(s.default)&&<small>默认 {fmtDefault(s.default)}</small>}</td>
      <td className="param-desc">{s.description??''}{by.length>0&&<small>仅 {by.join('、')}</small>}</td>
    </tr>{nested&&open[key]&&<Rows schema={nested} required={nested.required} depth={depth+1}/>}</Fragment>;
  });
}
export function ToolDoc({tool,models,open=false}){
  const [raw,setRaw]=useState(false),props=tool.inputSchema.properties??{},collapsed=Object.values(props).filter(s=>s.type==='object'&&!s.properties).length;
  return <details className="mcp-tool tool-doc" open={open||undefined}><summary><code>{tool.name}</code><span className="tool-doc-meta">{Object.keys(props).length} 个参数 · 必填 {(tool.inputSchema.required??[]).join('、')||'无'}{collapsed?' · 折叠 '+collapsed:''} · {size(tool).toLocaleString()} 字符</span><Icon name="chevron"/></summary>
    <p className="tool-doc-desc">{tool.description}</p>
    {Object.keys(props).length?<div className="task-table-wrap"><table className="task-table param-table"><thead><tr><th>参数</th><th>类型</th><th>必填</th><th>取值</th><th>说明</th></tr></thead><tbody><Rows schema={tool.inputSchema} required={tool.inputSchema.required} tool={tool.name} models={models} top/></tbody></table></div>:<p className="note">没有参数。</p>}
    <button className="mcp-link" onClick={()=>setRaw(r=>!r)}>{raw?'收起原始定义':'查看原始定义（客户端收到的 JSON）'}</button>
    {raw&&<pre className="tool-doc-raw">{JSON.stringify(tool,null,2)}</pre>}
  </details>;
}
export default function McpTools({tools,models}){
  const generation=tools.filter(t=>!COMMON.includes(t.name)),common=tools.filter(t=>COMMON.includes(t.name));
  const total=tools.reduce((n,t)=>n+size(t),0);
  const collapsed=generation.reduce((n,t)=>n+Object.values(t.inputSchema.properties??{}).filter(s=>s.type==='object'&&!s.properties).length,0);
  return <>
    <section className="stage-kpis"><div className="stage-kpi"><span className="label">工具</span><div className="stage-value">{tools.length}<span>个</span></div><p className="note">{generation.length} 个生成 · {common.length} 个公共</p></div><div className="stage-kpi"><span className="label">定义体积</span><div className="stage-value">{total.toLocaleString()}<span>字符</span></div><p className="note">tools/list 全部工具定义，不含服务说明</p></div><div className="stage-kpi"><span className="label">折叠的高级参数</span><div className="stage-value">{collapsed}<span>组</span></div><p className="note">list_media_models {'{model}'} 展开；网关仍完整校验</p></div><div className="stage-kpi"><span className="label">最少输入</span><div className="stage-value overview-value">request_id + prompt</div><p className="note">不写 model 即走主推与降级</p></div></section>
    <section className="mcp-card"><div className="charthead"><h2>生成工具</h2><span className="muted tiny">参数表即客户端看到的定义；“仅 …”表示只有这些模型接受</span></div>{generation.map(t=><ToolDoc key={t.name} tool={t} models={models}/>)}</section>
    <section className="mcp-card"><div className="charthead"><h2>目录、素材与任务</h2><span className="muted tiny">{common.length} 个</span></div>{common.map(t=><ToolDoc key={t.name} tool={t} models={models}/>)}</section>
  </>;
}
