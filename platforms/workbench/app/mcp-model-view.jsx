'use client';
import {useState} from 'react';
import {Icon} from './ui-controls.mjs';
import {ToolDoc} from './mcp-tools';
// What a client model reads from local-media, laid out as it happens: what is in context from the
// start of a session, what enters only after a call, and the job loop. Sizes are the JSON
// characters the client receives; a node opens the exact text.
const COMMON=['list_media_models','import_media','get_job','cancel_job','get_artifact'];
const chars=value=>(typeof value==='string'?value:JSON.stringify(value)).length;
const n=v=>v.toLocaleString('zh-CN');
function Bar({value,max}){return <span className="graph-bar"><i style={{width:Math.max(2,value/max*100)+'%'}}/></span>;}
function Node({id,title,sub,size,max,selected,highlight,onSelect,children}){
  return <button className={'graph-node'+(selected?' is-selected':'')+(highlight?' is-highlight':'')} onClick={()=>onSelect(id)} aria-pressed={selected}>
    <span className="graph-node-head"><code>{title}</code><span>{n(size)} 字符</span></span>
    <Bar value={size} max={max}/>
    {sub&&<small>{sub}</small>}
    {children}
  </button>;
}
function Chips({tool,onHover}){
  const props=tool.inputSchema.properties??{},required=tool.inputSchema.required??[];
  return <span className="graph-chips">{Object.entries(props).map(([key,s])=>{
    const collapsed=s.type==='object'&&!s.properties,target=collapsed?/"model":"([^"]+)"/.exec(s.description??'')?.[1]:null;
    return <span key={key} className={'graph-chip'+(required.includes(key)?' is-required':'')+(collapsed?' is-collapsed':'')} onMouseEnter={()=>target&&onHover(target)} onMouseLeave={()=>onHover(null)} title={collapsed?'折叠：调用 list_media_models {"model":"'+target+'"} 才看到字段':required.includes(key)?'必填':'可选'}>{key}{collapsed&&<Icon name="external"/>}</span>;
  })}</span>;
}
export default function McpModelView({view}){
  const [selected,setSelected]=useState('instructions'),[hover,setHover]=useState(null);
  const tools=view.tools,generation=tools.filter(t=>!COMMON.includes(t.name)),common=tools.filter(t=>COMMON.includes(t.name));
  const lm=view.list_media_models,details=Object.entries(lm.models);
  const opening=chars(view.instructions)+tools.reduce((s,t)=>s+chars(t),0);
  const sizes=[chars(view.instructions),...tools.map(chars),chars(lm.overview),...details.map(([,v])=>chars(v))],max=Math.max(...sizes);
  const node=(id,title,size,sub,extra)=><Node key={id} id={id} title={title} size={size} max={max} sub={sub} selected={selected===id} highlight={hover&&id==='model:'+hover} onSelect={setSelected}>{extra}</Node>;
  const tool=tools.find(t=>'tool:'+t.name===selected);
  const detail=selected==='instructions'?{title:'服务说明（initialize 时随协议下发）',text:view.instructions}
    :selected==='models'?{title:'list_media_models {} 的返回',text:JSON.stringify(lm.overview,null,2)}
    :selected.startsWith('model:')?{title:'list_media_models {"model":"'+selected.slice(6)+'"} 的返回',text:JSON.stringify(lm.models[selected.slice(6)],null,2)}:null;
  return <div className="model-view">
    <section className="stage-kpis"><div className="stage-kpi"><span className="label">会话开始就读入</span><div className="stage-value">{n(opening)}<span>字符</span></div><p className="note">服务说明 + {tools.length} 个工具定义，每次会话都在上下文里</p></div><div className="stage-kpi"><span className="label">按需读入 · 概览</span><div className="stage-value">{n(chars(lm.overview))}<span>字符</span></div><p className="note">调用 list_media_models 之后</p></div><div className="stage-kpi"><span className="label">按需读入 · 单个模型</span><div className="stage-value">{n(Math.max(0,...details.map(([,v])=>chars(v))))}<span>字符</span></div><p className="note">最大的一个模型详情（含折叠参数）</p></div><div className="stage-kpi"><span className="label">最少要写</span><div className="stage-value overview-value">request_id + prompt</div><p className="note">不写 model 即走主推与降级</p></div></section>
    <div className="graph">
      <section className="graph-stage"><h3><b>1</b>会话开始 · 一直在上下文</h3>
        {node('instructions','服务说明',chars(view.instructions),'instructions：用法与调度建议')}
        <div className="graph-group">生成工具</div>
        {generation.map(t=>node('tool:'+t.name,t.name,chars(t),null,<Chips tool={t} onHover={setHover}/>))}
        <div className="graph-group">目录、素材与任务</div>
        {common.map(t=>node('tool:'+t.name,t.name,chars(t),null,<Chips tool={t} onHover={setHover}/>))}
      </section>
      <div className="graph-arrow" aria-hidden="true"><span>调用后</span><Icon name="chevron"/></div>
      <section className="graph-stage"><h3><b>2</b>调用后才读入</h3>
        {node('models','list_media_models {}',chars(lm.overview),'能力、主推与降级、各模型参数名')}
        <div className="graph-group">{'list_media_models {"model": …}'}</div>
        {details.map(([id,v])=>node('model:'+id,id,chars(v),'完整参数定义'+(Object.values(v.model.parameter_schemas??{}).some(p=>Object.values(p).some(s=>s.type==='object'&&s.properties))?' · 含折叠参数':'')))}
        <p className="note graph-hint">虚线参数在工具里是折叠的，悬停可看到展开它的模型节点。</p>
      </section>
      <div className="graph-arrow" aria-hidden="true"><span>提交后</span><Icon name="chevron"/></div>
      <section className="graph-stage graph-loop"><h3><b>3</b>任务回路</h3>
        {[['generate_*','返回 job_id、state、poll_after_seconds；接受不等于完成'],['get_job','轮询状态，可短等待 20 秒；unknown 不自动重试'],['get_artifact','作品元数据与本机路径；download=true 落到工作区']].map(([name,text],i)=><div className="loop-step" key={name}><code>{name}</code><small>{text}</small>{i<2&&<Icon name="down"/>}</div>)}
        <p className="note graph-hint">作品文件不会进入对话，只有元数据和路径。</p>
      </section>
    </div>
    <section className="mcp-card graph-detail">
      {tool?<ToolDoc key={tool.name} tool={tool} models={view.models} open/>:detail&&<><div className="charthead"><h2>{detail.title}</h2><span className="muted tiny">{n(detail.text.length)} 字符 · 模型读到的原文</span></div><pre className="tool-doc-raw">{detail.text}</pre></>}
    </section>
  </div>;
}
