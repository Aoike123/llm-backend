'use client';
import {useState} from 'react';
import {Icon} from './ui-controls.mjs';
import {ToolDoc} from './mcp-tools';
// What a client model reads from local-media, in the order it happens: the entry tool alone at the
// start, then the tools of the category it opens, then model details on request. Sizes are the JSON
// characters the client receives; a node opens the exact text.
const chars=value=>(typeof value==='string'?value:JSON.stringify(value)).length;
const n=v=>v.toLocaleString('zh-CN');
// Plain-language name and purpose per tool; a tool not listed here still shows, with the first
// sentence of its own description, so new tools never need a console change to appear.
const INFO={browse_media:['浏览分类','先看有哪些分类；打开一个，才列出它的工具','entry'],generate_image:['图像生成','出图；给参考图则为编辑','make'],generate_video:['视频生成','文生、图生、参考生视频','make'],generate_speech:['语音合成','合成语音，可克隆音色','make'],process_audio:['音频处理','人声分离、语音识别','make'],
  register_voice:['注册音色','把一段人声存成可复用的音色','voice'],search_voices:['搜索音色','按名称、分组、文本模糊查找','voice'],update_voice:['音色改名','改名称或分组','voice'],
  list_media_models:['查看模型','模型清单；给 model 看完整参数','prep'],import_media:['导入素材','本机图片、视频、音频 → 素材 ID','prep'],
  get_job:['查询任务','看进度，可等待 20 秒','job'],list_jobs:['任务列表','最近的任务','job'],cancel_job:['取消任务','取消排队或可中断的任务','job'],get_artifact:['获取作品','本机路径，可下载到工作区','job']};
const infoOf=tool=>INFO[tool.name]??[tool.name,(tool.description??'').split(/(?<=[.。])\s/)[0]];
function Bar({value,max}){return <span className="graph-bar"><i style={{width:Math.max(2,value/max*100)+'%'}}/></span>;}
function Node({id,title,label,sub,size,max,selected,highlight,onSelect,children}){
  return <button className={'graph-node'+(selected?' is-selected':'')+(highlight?' is-highlight':'')} onClick={()=>onSelect(id)} aria-pressed={selected}>
    <span className="graph-node-head"><span className="graph-node-title">{label&&<b>{label}</b>}<code>{title}</code></span><span title="模型读到的字符数，越大占上下文越多">{n(size)} 字符</span></span>
    <Bar value={size} max={max}/>
    {sub&&<small>{sub}</small>}
    {children}
  </button>;
}
// One line per on-demand item: name, size bar and characters, so a list reads as a table.
function Row({id,name,hint,size,max,selected,highlight,onSelect}){
  return <button className={'tree-row'+(selected?' is-selected':'')+(highlight?' is-highlight':'')} onClick={()=>onSelect(id)} aria-pressed={selected}>
    <span className="tree-row-name"><code>{name}</code>{hint&&<em>{hint}</em>}</span><Bar value={size} max={max}/><span className="tree-row-size">{n(size)}</span>
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
  const tools=view.tools,byName=Object.fromEntries(tools.map(t=>[t.name,t])),task=view.task_tools??[],categories=view.categories??[];
  const sum=names=>names.reduce((total,name)=>total+(byName[name]?chars(byName[name]):0),0);
  const lm=view.list_media_models,details=Object.entries(lm.models);
  const rowMax=Math.max(...Object.values(lm.by_category).map(chars),...details.map(([,v])=>chars(v)));
  const opening=chars(view.instructions)+sum(view.initial),opens=c=>sum(c.tools),widest=Math.max(0,...categories.map(opens));
  const allAtOnce=chars(view.instructions)+sum(tools.map(t=>t.name).filter(name=>!view.initial.includes(name)));
  const max=Math.max(...tools.map(chars),chars(view.instructions));
  const node=(name)=>{const t=byName[name];if(!t)return null;const [label,sub]=infoOf(t);
    return <Node key={name} id={'tool:'+name} title={name} label={label} size={chars(t)} max={max} sub={sub} selected={selected==='tool:'+name} onSelect={setSelected}><Chips tool={t} onHover={setHover}/></Node>;};
  const tool=tools.find(t=>'tool:'+t.name===selected);
  const detail=selected==='instructions'?{title:'服务说明（initialize 时随协议下发）',text:view.instructions}
    :selected.startsWith('models:')?{title:'list_media_models（已打开「'+selected.slice(7)+'」）的返回',text:JSON.stringify(lm.by_category[selected.slice(7)],null,2)}
    :selected.startsWith('model:')?{title:'list_media_models {"model":"'+selected.slice(6)+'"} 的返回',text:JSON.stringify(lm.models[selected.slice(6)],null,2)}:null;
  return <div className="model-view">
    <section className="stage-kpis">
      <div className="stage-kpi"><span className="label">进来就读入</span><div className="stage-value">{n(opening)}<span>字符</span></div><p className="note">服务说明 + 浏览入口，别的都不在上下文里</p></div>
      <div className="stage-kpi"><span className="label">打开一个分类后</span><div className="stage-value">{n(opening+widest)}<span>字符</span></div><p className="note">最大的分类（{categories.length} 个分类里），只含它自己的工具</p></div>
      <div className="stage-kpi"><span className="label">若全部一次列出</span><div className="stage-value">{n(allAtOnce+chars(byName.browse_media??''))}<span>字符</span></div><p className="note">旧方式：每个会话都带着所有分类</p></div>
      <div className="stage-kpi"><span className="label">按需读入 · 单个模型</span><div className="stage-value">{n(Math.max(0,...details.map(([,v])=>chars(v))))}<span>字符</span></div><p className="note">最大的一个模型详情（含折叠参数）</p></div>
    </section>
    <p className="note graph-guide">AI 客户端（如 Claude）连上后先只看到「浏览分类」；选了某个分类，才会列出该分类的工具，所以做视频的看不到图像工具。点任意卡片，右侧显示模型读到的原文。</p>
    <p className="graph-legend"><span className="graph-chip is-required">必填参数</span><span className="graph-chip">可选参数</span><span className="graph-chip is-collapsed">折叠参数 <Icon name="external"/></span><span className="muted tiny">折叠 = 初始不展开字段，调用「查看模型」才看到 · 横条 = 占上下文的大小</span></p>
    <div className="tree">
      <div className="tree-list">
        <section className="tree-group"><h3><b className="tree-step">1</b>进来就读入<small>连上就在上下文里</small><span>{n(opening)} 字符</span></h3>
          <Node id="instructions" title="instructions" label="服务说明" size={chars(view.instructions)} max={max} sub="告诉模型从哪开始、怎么省 GPU 切换" selected={selected==='instructions'} onSelect={setSelected}/>
          {view.initial.map(node)}
        </section>
        <section className="tree-group"><h3><b className="tree-step">2</b>选一个分类，才列出它的工具<small>工具和模型都只出现所选分类</small></h3>
          {categories.map(c=>{const own=c.tools.filter(name=>!task.includes(name));
            return <details key={c.id} className="tree-cat">
              <summary><Icon name="chevron"/><span><b>{c.label}</b><small>{c.summary}</small></span><span className="tree-sum">+{n(sum(own))} 字符</span></summary>
              <div className="tree-cat-body">{own.map(node)}
                {c.models.length>0&&<div className="tree-rows">
                  <div className="tree-rows-title">该分类的模型 · {c.models.length} 个，用「查看模型」读取</div>
                  <Row id={'models:'+c.id} name="模型总览" hint="能力、首选与备用模型、参数名" size={chars(lm.by_category[c.id])} max={rowMax} selected={selected==='models:'+c.id} onSelect={setSelected}/>
                  {c.models.map(id=>{const v=lm.models[id];return <Row key={id} id={'model:'+id} name={id} hint={Object.values(v.model.parameter_schemas??{}).some(p=>Object.values(p).some(sch=>sch.type==='object'&&sch.properties))?'含折叠参数':null} size={chars(v)} max={rowMax} selected={selected==='model:'+id} highlight={hover===id} onSelect={setSelected}/>;})}
                </div>}
              </div>
            </details>;})}
        </section>
        <section className="tree-group"><h3><b className="tree-step">3</b>每个分类都附带<small>提交之后：查进度、取作品</small><span>{n(sum(task))} 字符</span></h3>
          {task.map(name=><div key={name} className="tree-item">
            {node(name)}

          </div>)}
        </section>
      </div>
      <section className="mcp-card graph-detail">
        {tool?<ToolDoc key={tool.name} tool={tool} models={view.models} open/>:detail&&<><div className="charthead"><h2>{detail.title}</h2><span className="muted tiny">{n(detail.text.length)} 字符 · 模型读到的原文</span></div><pre className="tool-doc-raw">{detail.text}</pre></>}
      </section>
    </div>
  </div>;
}
