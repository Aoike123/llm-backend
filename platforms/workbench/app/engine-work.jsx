'use client';
import {useState} from 'react';
import {useRead} from './use-read.mjs';
import {ArtifactView} from './artifact-view';
import {ActionButton} from './ui-controls.mjs';
import {fmt} from '../lib/panel.mjs';
const STATE={queued:'排队',preparing:'准备素材',waiting_for_admission:'等待准入',waiting_for_engine:'等待引擎',dispatching:'派发中',running:'运行中',saving:'保存作品',recovering:'恢复中',succeeded:'完成',failed:'失败',cancelled:'已取消',unknown:'结果不确定'};
const time=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'—';
// Parameters worth showing at a glance, per kind of work; the full set is in the job detail.
const HIGHLIGHT={image:['model','size','mode','engine','seed'],video:['model','duration_seconds','width','height','frames','seed'],audio:['model','speed','speakers','seed'],text:['model','language']};
function summary(job){
  const p=job.effective_parameters??{},keys=HIGHLIGHT[job.kind]??['model'];
  return keys.filter(k=>p[k]!==undefined&&p[k]!==null&&typeof p[k]!=='object').map(k=>k==='model'?p[k]:k+' '+p[k]).join(' · ')||'—';
}
const median=values=>{const v=values.filter(Number.isFinite).sort((a,b)=>a-b);return v.length?v[Math.floor(v.length/2)]:null;};
function Detail({id,onClose}){
  const {value:job,error}=useRead('/api/mcp/jobs/'+id);
  return <section className="engine-detail mcp-card" aria-label="任务详情"><div className="charthead"><h2>任务详情</h2><ActionButton onClick={onClose}>关闭</ActionButton></div>
    {error&&<p className="error-banner" role="alert">{error}</p>}
    {job?<>
      <p className="note"><code>{job.job_id}</code> · {STATE[job.state]??job.state} · {job.tool}</p>
      {job.error&&<p className="error-banner">{job.error.code} · {job.error.message}</p>}
      {job.fallback_from?.length>0&&<p className="note">降级记录：{job.fallback_from.map(f=>f.model+'（'+f.code+'）').join(' → ')} → {job.served_by??job.model}</p>}
      <div className="engine-artifacts">{job.artifacts?.map(a=><ArtifactView key={a.artifact_id} artifact={a}/>)}</div>
      {job.reference_mapping&&<p className="note">参考映射：{['images','videos','audios'].flatMap(k=>job.reference_mapping[k]??[]).map(r=>r.tag+'→槽位'+r.input_slot).join('，')||'无参考'}</p>}
      {job.effective_parameters&&<dl className="engine-params">{Object.entries(job.effective_parameters).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{typeof v==='object'?JSON.stringify(v):String(v)}</dd></div>)}</dl>}
      {job.metrics&&<p className="note">等待 {fmt(job.metrics.queue_seconds)} 秒 · 总计 {fmt(job.metrics.total_seconds)} 秒{job.metrics.rtf?' · RTF '+fmt(job.metrics.rtf,2):''}</p>}
    </>:<div className="empty">正在读取任务详情…</div>}
  </section>;
}
// Recent work of one engine: what it made, how long it took and which model actually ran it.
export default function EngineWork({service}){
  const [selected,setSelected]=useState(null);
  const {value,error}=useRead('/api/mcp/jobs?engine='+encodeURIComponent(service.id)+'&limit=40');
  const jobs=value?.jobs??[],done=jobs.filter(j=>['succeeded','failed','unknown'].includes(j.state)),ok=jobs.filter(j=>j.state==='succeeded');
  const artifacts=ok.flatMap(job=>(job.artifacts??[]).map(a=>({...a,job_id:job.job_id})));
  const cards=[['持久任务',value?.total??null,'个','API / MCP 提交到该引擎'],['成功率',done.length?ok.length/done.length*100:null,'%','最近 '+jobs.length+' 个任务'],['中位耗时',median(ok.map(j=>j.metrics?.total_seconds)),'秒','含等待与切换'],['降级接手',jobs.filter(j=>j.fallback_from?.length).length,'次','主推引擎不可用时由本引擎完成']];
  const kind=service.type==='language'?'text':service.type;
  return <div className={'engine-work engine-work-'+kind}>
    <section className="stage-kpis" aria-label="作品统计">{cards.map(([label,v,unit,note])=><div className="stage-kpi" key={label}><span className="label">{label}</span><div className="stage-value">{fmt(v,label==='成功率'?0:1)}<span>{unit}</span></div><p className="note">{value?note:'正在读取'}</p></div>)}</section>
    {error&&<p className="error-banner" role="alert">{error}，保留最近读取结果。</p>}
    <section className="mcp-card"><div className="charthead"><h2>最近作品</h2><span className="muted tiny">{artifacts.length} 个 · 点击查看任务</span></div>
      {!artifacts.length?<div className="empty">{value?'该引擎还没有完成的持久任务作品':'正在读取作品…'}</div>
      :<div className={'engine-gallery gallery-'+kind}>{artifacts.slice(0,kind==='image'?12:kind==='video'?4:8).map(a=><button key={a.artifact_id} className="gallery-item" onClick={()=>setSelected(a.job_id)} aria-label="查看任务"><ArtifactView artifact={a} compact/></button>)}</div>}
    </section>
    {selected&&<Detail id={selected} onClose={()=>setSelected(null)}/>}
    <section className="mcp-card"><div className="charthead"><h2>历史记录</h2><span className="muted tiny">最近 40 个持久任务</span></div>
      <div className="task-table-wrap"><table className="task-table"><thead><tr><th>创建时间</th><th>能力</th><th>状态</th><th>实际模型</th><th>等待 / 总耗时</th><th>参数</th></tr></thead>
      <tbody>{jobs.map(job=><tr key={job.job_id} onClick={()=>setSelected(job.job_id)} className="clickable-row"><td>{time(job.created_at)}</td><td>{job.capability??job.tool}</td><td className={job.state==='succeeded'?'live':['failed','unknown'].includes(job.state)?'bad':''}>{STATE[job.state]??job.state}</td><td>{job.served_by??job.model}{job.fallback_from?.length>0&&<small className="mcp-sub">由 {job.fallback_from.map(f=>f.model).join('、')} 降级</small>}</td><td>{fmt(job.metrics?.queue_seconds)} / {fmt(job.metrics?.total_seconds)} 秒</td><td className="engine-param-summary">{summary(job)}</td></tr>)}</tbody></table>
      {value&&!jobs.length&&<div className="empty">该引擎暂无持久任务</div>}</div>
      <p className="note">同步 API 请求不保存作品，只计入上方运行监控的耗时统计。</p>
    </section>
  </div>;
}
