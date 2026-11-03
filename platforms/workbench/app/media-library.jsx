'use client';
import {useEffect,useRef,useState} from 'react';
import {useRead} from './use-read.mjs';
import {ActionButton,Icon} from './ui-controls.mjs';
import {ArtifactView,artifactUrl} from './artifact-view';
import {engineLabel,fmt} from '../lib/panel.mjs';

export const STATE={queued:'排队',preparing:'准备素材',waiting_for_admission:'等待准入',waiting_for_engine:'等待引擎',dispatching:'派发中',running:'生成中',saving:'保存作品',recovering:'恢复检查',succeeded:'完成',failed:'失败',cancelled:'已取消',unknown:'结果未知'};
const STATE_GROUPS=[['active','进行中'],['succeeded','完成'],['failed','失败'],['cancelled','已取消']];
const KINDS=[['image','图像'],['video','视频'],['audio','音频'],['text','文本']];
const TERMINAL=['succeeded','failed','cancelled','unknown'];
const stateTone=s=>s==='succeeded'?'live':['failed','unknown'].includes(s)?'bad':s==='cancelled'?'muted':'preparing';
export const when=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'—';
const query=params=>'?'+new URLSearchParams(Object.entries(params).filter(([,v])=>v!=null&&v!=='')).toString();
const duration=s=>!Number.isFinite(s)?null:s>=60?Math.floor(s/60)+':'+String(Math.round(s%60)).padStart(2,'0'):fmt(s)+' 秒';

// One row of choices with counts; counts come from the server with the other filters applied.
function Chips({label,value,options,counts,onChange,all='全部'}){
  const total=Object.values(counts??{}).reduce((a,b)=>a+b,0);
  return <div className="filter-row" role="group" aria-label={label}><span>{label}</span>
    <button aria-pressed={!value} onClick={()=>onChange(null)}>{all}<small>{counts?total:''}</small></button>
    {options.filter(([id])=>!counts||counts[id]||value===id).map(([id,name])=><button key={id} aria-pressed={value===id} onClick={()=>onChange(value===id?null:id)}>{name}<small>{counts?.[id]??0}</small></button>)}
  </div>;
}
function Pager({value,offset,limit,onOffset}){
  if(!value||value.total<=limit)return null;
  const pages=Math.ceil(value.total/limit),current=Math.floor(offset/limit)+1;
  return <div className="library-pager"><ActionButton disabled={!offset} onClick={()=>onOffset(Math.max(0,offset-limit))}>上一页</ActionButton><span>第 {current} / {pages} 页 · 共 {value.total} 项</span><ActionButton disabled={!value.has_more} onClick={()=>onOffset(offset+limit)}>下一页</ActionButton></div>;
}
const engineOptions=counts=>Object.keys(counts??{}).sort((a,b)=>(counts[b]-counts[a])).map(id=>[id,engineLabel(id)]);

// A preview that never plays inline: the tile opens the job, where the full player lives.
export function ArtifactThumb({artifact,size=640}){
  const url=artifactUrl(artifact),seconds=artifact.media?.duration_seconds,[failed,setFailed]=useState(false);
  const preview=failed?<span className="thumb-failed">预览不可用</span>:<img src={url+'?thumb='+size} alt="" loading="lazy" decoding="async" onError={()=>setFailed(true)}/>;
  if(artifact.kind==='image')return preview;
  if(artifact.kind==='video')return <>{preview}<span className="thumb-badge"><Icon name="play"/>{duration(seconds)}</span></>;
  const stem={vocals:'人声',instrumental:'伴奏',transcript:'转写'}[artifact.name];
  return <div className={'thumb-placeholder thumb-'+artifact.kind}><Icon name={artifact.kind==='audio'?'wave':'text'}/><strong>{stem??(artifact.kind==='audio'?'音频':'文本')}</strong><small>{artifact.kind==='audio'?duration(seconds)??fmt(artifact.bytes/2**20)+' MB':'JSON'}</small></div>;
}

// The asset library: every saved artifact, filterable by kind and engine, opening its job.
export function Gallery({engine:fixedEngine=null,capabilities=null,kinds=null,onOpen,limit=24,compact=false,title}){
  const [kind,setKind]=useState(null),[engine,setEngine]=useState(null),[offset,setOffset]=useState(0);
  useEffect(()=>setOffset(0),[kind,engine,fixedEngine]);
  const {value,stale,error}=useRead('/api/mcp/artifacts'+query({kind,engine:fixedEngine??engine,capability:capabilities?.join(','),kinds:kinds?.join(','),offset,limit}),{keep:true});
  const items=value?.artifacts??[];
  return <section className={'media-gallery'+(compact?' compact':'')+(stale?' is-stale':'')} aria-busy={stale}>
    {title}
    {!compact&&!(kinds?.length===1&&fixedEngine)&&<div className="filter-bar">{kinds?.length!==1&&<Chips label="类型" value={kind} options={KINDS} counts={value?.facets?.kind} onChange={setKind}/>}{!fixedEngine&&<Chips label="引擎" value={engine} options={engineOptions(value?.facets?.engine)} counts={value?.facets?.engine} onChange={setEngine}/>}</div>}
    {error&&<p className="error-banner" role="alert">{error}，保留最近读取结果。</p>}
    {!value?<div className="empty">正在读取作品…</div>:!items.length?<div className="empty">{kind||engine?'没有符合筛选的作品':'还没有保存的作品'}</div>:
      <ul className="gallery-grid">{items.map(a=><li key={a.artifact_id}><button className={'gallery-tile tile-'+a.kind} onClick={()=>onOpen(a.job_id)} aria-label={'查看任务 '+a.job_id}>
        <div className="tile-media"><ArtifactThumb artifact={a}/></div>
        <div className="tile-caption"><span>{engineLabel(a.engine)}</span><time>{when(a.created_at)}</time>{a.prompt&&<p>{a.prompt}</p>}</div>
      </button></li>)}</ul>}
    {!compact&&<Pager value={value} offset={offset} limit={limit} onOffset={setOffset}/>}
  </section>;
}

// Two-step: the first click arms, the second sends. Running ComfyUI jobs end as cancelled once it stops.
export function CancelJob({job,compact=false}){
  const [armed,setArmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(!armed)return;const timer=setTimeout(()=>setArmed(false),8000);return()=>clearTimeout(timer);},[armed]);
  if(job.cancel_requested_at&&!TERMINAL.includes(job.state))return <span className="muted">正在取消…</span>;
  if(!job.cancellable)return null;
  async function send(e){e.stopPropagation();setBusy(true);setError('');try{const response=await fetch('/api/mcp/jobs/'+job.job_id+'/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const result=await response.json();if(!response.ok)throw Error(result.error??'取消失败（'+response.status+'）');setArmed(false);}catch(e){setError(e.message);}finally{setBusy(false);}}
  return <span className="cancel-job" onClick={e=>e.stopPropagation()}>{armed?<ActionButton variant="danger" disabled={busy} onClick={send}>{busy?'正在取消…':'确认取消'}</ActionButton>:<ActionButton variant={compact?'quiet':'danger'} onClick={()=>setArmed(true)}>取消任务</ActionButton>}{error&&<span className="bad" role="alert"> {error}</span>}</span>;
}

// Durable jobs with filters. A fixed engine hides the engine filter (engine pages).
export function JobTable({engine:fixedEngine=null,onOpen,openId,limit=25}){
  const [state,setState]=useState(null),[engine,setEngine]=useState(null),[kind,setKind]=useState(null),[offset,setOffset]=useState(0);
  useEffect(()=>setOffset(0),[state,engine,kind,fixedEngine]);
  const {value,stale,error}=useRead('/api/mcp/jobs'+query({state,engine:fixedEngine??engine,kind,offset,limit}),{keep:true});
  const jobs=value?.jobs??[];
  return <section className={'job-table'+(stale?' is-stale':'')} aria-busy={stale}>
    <div className="filter-bar"><Chips label="状态" value={state} options={STATE_GROUPS} counts={value?.facets?.state} onChange={setState}/>{!fixedEngine&&<Chips label="引擎" value={engine} options={engineOptions(value?.facets?.engine)} counts={value?.facets?.engine} onChange={setEngine}/>}{!fixedEngine&&<Chips label="类型" value={kind} options={KINDS} counts={value?.facets?.kind} onChange={setKind}/>}</div>
    {error&&<p className="error-banner" role="alert">{error}，保留最近读取结果。</p>}
    <div className="task-table-wrap"><table className="task-table jobs"><thead><tr><th aria-label="预览"/><th>内容</th>{!fixedEngine&&<th>引擎</th>}<th>状态</th><th className="col-duration">耗时</th><th>创建时间</th><th aria-label="操作"/></tr></thead>
      <tbody>{jobs.map(job=>{const first=job.artifacts?.[0];return <tr key={job.job_id} className={'clickable-row'+(openId===job.job_id?' is-open':'')} onClick={()=>onOpen(job.job_id)} tabIndex={0} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onOpen(job.job_id);}}}>
        <td className="job-thumb">{first?<ArtifactThumb artifact={first} size={320}/>:<span className="thumb-empty"/>}</td>
        <td className="job-prompt"><span>{job.prompt??<i className="muted">{job.capability_label??job.capability??job.tool}</i>}</span><small className="mcp-sub">{job.capability??job.tool}{fixedEngine&&(job.served_by??job.model)?' · '+(job.served_by??job.model):''}{job.fallback_from?.length?' · 降级接手':''}{job.artifacts?.length>1?' · '+job.artifacts.length+' 个作品':''}</small></td>
        {!fixedEngine&&<td>{engineLabel(job.engine)}<small className="mcp-sub">{job.served_by??job.model}{job.fallback_from?.length?' · 降级接手':''}</small></td>}
        <td className={stateTone(job.state)}>{STATE[job.state]??job.state}</td>
        <td className="col-duration">{job.metrics?.total_seconds!=null?fmt(job.metrics.total_seconds)+' 秒':'—'}<small className="mcp-sub">{job.metrics?.queue_seconds!=null?'等待 '+fmt(job.metrics.queue_seconds)+' 秒':''}</small></td>
        <td><time>{when(job.created_at)}</time></td>
        <td><CancelJob job={job} compact/></td>
      </tr>;})}</tbody></table>
      {!value?<div className="empty">正在读取任务…</div>:!jobs.length&&<div className="empty">{state||engine||kind?'没有符合筛选的任务':'暂无持久媒体任务'}</div>}</div>
    <Pager value={value} offset={offset} limit={limit} onOffset={setOffset}/>
  </section>;
}

// What was asked for, as submitted: the main text first, then every other input the request carried.
const INPUT_LABEL={prompt:'提示词',text:'合成文本',negative_prompt:'反向提示词',instruct:'语气说明',reference_text:'参考音频原文',references:'参考',reference_asset_ids:'参考素材',reference_asset_id:'参考素材',audio_asset_id:'输入音频',image_asset_id:'输入图像',language:'语言',duration_seconds:'时长（秒）',aspect_ratio:'画幅',size:'尺寸',quality:'质量',strength:'重绘强度',speed:'语速',seed:'种子',model:'点名模型',speakers:'说话人数',workflow:'工作流'};
const SKIP_INPUT=new Set(['request_id','prompt','text']);
function inputValue(key,value){
  if(key==='references'&&Array.isArray(value))return <ol className="drawer-references">{value.map((r,i)=><li key={i}><code>{r.asset_id??r.artifact_id??r.source??'—'}</code>{r.start_seconds!=null&&<small> · {fmt(r.start_seconds)}–{r.duration_seconds!=null?fmt(r.start_seconds+r.duration_seconds):'结尾'} 秒</small>}{r.text&&<p>{r.text}</p>}</li>)}</ol>;
  if(Array.isArray(value)&&value.every(v=>typeof v!=='object'))return value.map(String).join('、');
  if(typeof value==='object')return <code className="drawer-json">{JSON.stringify(value,null,1)}</code>;
  return typeof value==='string'&&value.length>60?<p className="drawer-prompt">{value}</p>:String(value);
}
function Inputs({job}){
  const input=job.input??{},main=[['prompt',input.prompt],['text',input.text]].filter(([,v])=>typeof v==='string'&&v.trim());
  const rest=Object.entries(input).filter(([k,v])=>!SKIP_INPUT.has(k)&&v!=null&&v!==''&&!(typeof v==='object'&&!Array.isArray(v)&&!Object.keys(v).length));
  if(!main.length&&!rest.length)return null;
  return <section className="drawer-section drawer-inputs"><h3>输入</h3>
    {main.map(([k,v])=><div className="drawer-main-input" key={k}><span>{INPUT_LABEL[k]}</span><p className="drawer-prompt">{v}</p><CopyText text={v}/></div>)}
    {rest.length>0&&<dl className="drawer-fields">{rest.map(([k,v])=><Field key={k} label={INPUT_LABEL[k]??k}>{inputValue(k,v)}</Field>)}</dl>}
  </section>;
}
function CopyText({text}){
  const [done,setDone]=useState(false);
  return <ActionButton variant="quiet" icon={done?'check':'copy'} onClick={async()=>{try{await navigator.clipboard.writeText(text);setDone(true);setTimeout(()=>setDone(false),1600);}catch{}}}>{done?'已复制':'复制'}</ActionButton>;
}
function Field({label,children}){return children==null||children===''?null:<div><dt>{label}</dt><dd>{children}</dd></div>;}
const HIDDEN_PARAMS=new Set(['reference_mapping','controls']);
// Job detail as a side drawer over the page: opening and closing never moves the list underneath.
export function JobDrawer({id,onClose}){
  const dialog=useRef(null);
  const {value:job,error}=useRead(id?'/api/mcp/jobs/'+id:null,{interval:id?3000:0});
  const current=job?.job_id===id?job:null;
  useEffect(()=>{const el=dialog.current;if(!el)return;if(id&&!el.open)el.showModal();if(!id&&el.open)el.close();},[id]);
  const params=Object.entries(current?.effective_parameters??{}).filter(([k,v])=>!HIDDEN_PARAMS.has(k)&&v!=null&&!(typeof v==='object'&&!Object.keys(v).length));
  const references=current?.reference_mapping?['images','videos','audios'].flatMap(k=>current.reference_mapping[k]??[]):[];
  return <dialog ref={dialog} className="job-drawer" aria-labelledby="job-drawer-title" onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    {id&&<div className="job-drawer-body">
      <div className="drawer-head"><div><span className="eyebrow">JOB</span><h2 id="job-drawer-title">{current?engineLabel(current.engine):'任务详情'}{current&&<small className={stateTone(current.state)}>{STATE[current.state]??current.state}</small>}</h2><code>{id}</code></div><ActionButton variant="quiet" icon="close" aria-label="关闭详情" onClick={onClose}/></div>
      {error&&<p className="error-banner" role="alert">{error}</p>}
      {!current?<div className="empty">正在读取任务详情…</div>:<>
        {current.error&&<p className="error-banner">{current.error.code} · {current.error.message}</p>}
        {current.artifacts?.length>0&&<div className="drawer-artifacts">{current.artifacts.map(a=><ArtifactView key={a.artifact_id} artifact={a}/>)}</div>}
        {!TERMINAL.includes(current.state)&&<div className="drawer-progress"><span className="preparing">{STATE[current.state]??current.state}</span><CancelJob job={current}/></div>}
        <Inputs job={current}/>
        <section className="drawer-section"><h3>执行</h3><dl className="drawer-fields">
          <Field label="能力">{current.capability??current.tool}</Field>
          <Field label="实际模型">{current.served_by??current.model}</Field>
          <Field label="降级记录">{current.fallback_from?.length?current.fallback_from.map(f=>f.model+'（'+f.code+'）').join(' → ')+' → '+(current.served_by??current.model):null}</Field>
          <Field label="创建">{when(current.created_at)}</Field>
          <Field label="完成">{current.finished_at?when(current.finished_at):null}</Field>
          <Field label="耗时">{current.metrics?.total_seconds!=null?`${fmt(current.metrics.total_seconds)} 秒（等待 ${fmt(current.metrics.queue_seconds)} 秒）`:null}</Field>
          <Field label="实时率">{current.metrics?.rtf?fmt(current.metrics.rtf,2):null}</Field>
          <Field label="参考映射">{references.length?references.map(r=>r.tag+' → 槽位 '+r.input_slot).join('，'):null}</Field>
          <Field label="请求 ID">{current.request_id}</Field>
        </dl></section>
        {params.length>0&&<section className="drawer-section"><h3>参数</h3><dl className="drawer-fields">{params.map(([k,v])=><Field key={k} label={k}>{typeof v==='object'?<code>{JSON.stringify(v)}</code>:String(v)}</Field>)}</dl></section>}
        {current.metrics?.text&&<section className="drawer-section"><h3>转写文本</h3><p className="drawer-prompt">{current.metrics.text}</p></section>}
      </>}
    </div>}
  </dialog>;
}
