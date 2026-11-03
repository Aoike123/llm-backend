'use client';
import {useState} from 'react';
import {SERVICES,serviceName,fmt,clock} from '../lib/panel.mjs';
import RuntimeSummary from './runtime-summary';
import {ActionButton,Icon} from './ui-controls.mjs';
import {useRead} from './use-read.mjs';
import {Gallery,JobTable,STATE} from './media-library';
const time=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'—';
export function Overview({data,onService,onLibrary,onOpen}){
 const {value:media,error}=useRead('/api/mcp/overview');
 // Counts per engine come from the job facets; one row is enough to read them.
 const {value:counts}=useRead('/api/mcp/jobs?limit=1');
 const cards=[['当前后端',data?.runtime_topology?.current_runtime_name??(data?'待机':'读取中'),'单卡按需启动'],['GPU 租约',data?data.runtime_topology?.leased?'占用中':'空闲':'—','API / MCP 共用'],['网关等待',data?.queued??'—','等待 GPU 的请求'],['进行中的媒体任务',media?.pending_jobs??'—','API / MCP 提交的未完成任务']];
 const state=service=>data?.switching_target===service.id?['preparing','正在切换']:data?.current_model===service.id?['live','运行中']:['muted','按需启动'];
 return <div className="control-center">
  {error&&<p className="error-banner" role="alert">媒体任务状态读取失败：{error}</p>}
  <section className="stage-kpis">{cards.map(([title,value,note])=><div className="stage-kpi" key={title}><span className="label">{title}</span><div className="stage-value overview-value">{value}</div><p className="note">{note}</p></div>)}</section>
  <section className="mcp-card"><div className="charthead"><h2>模型服务</h2><span className="muted tiny">点击查看监控、作品与任务</span></div><div className="service-catalog">{SERVICES.map(service=>{const [tone,label]=state(service),jobs=counts?.facets?.engine?.[service.id];return <button key={service.id} onClick={()=>onService(service.id)}>
   <span className="catalog-head"><span className="catalog-symbol" style={{color:service.accent}}>{service.symbol}</span><span className={'catalog-state '+tone}>● {label}</span></span>
   <strong>{service.name}<small>{service.version}</small></strong><p>{service.description}</p>
   <span className="catalog-foot">{service.panel==='llm'?'对话 · 同步接口':jobs?jobs+' 个持久任务':'暂无持久任务'}{service.runtime&&SERVICES.filter(s=>s.runtime===service.runtime).length>1&&<span>共用 {service.runtime}</span>}</span>
  </button>;})}</div></section>
  <Gallery compact limit={6} onOpen={onOpen} title={<div className="charthead"><h2>最近作品</h2><ActionButton onClick={onLibrary}>打开作品库</ActionButton></div>}/>
  <RuntimeSummary topology={data?.runtime_topology}/>
 </div>;
}
export function NativeHistory({runtime:r}){
 if(!r)return <div className="empty">正在读取执行历史…</div>;
 if(!r.history_available)return <div className="empty">执行历史暂不可读</div>;
 return <><div className="task-table-wrap"><table className="task-table"><thead><tr><th>完成时间</th><th>结果</th><th>执行耗时</th><th>工作流任务</th></tr></thead><tbody>{r.history.map(row=><tr key={row.prompt_id}><td>{row.finished_at?time(row.finished_at*1000):'—'}</td><td className={row.state==='succeeded'?'live':row.state==='failed'?'bad':'muted'}>{STATE[row.state]??row.state}</td><td>{row.seconds==null?'—':fmt(row.seconds)+' 秒'}</td><td><code>{row.prompt_id}</code></td></tr>)}</tbody></table>{!r.history.length&&<div className="empty">暂无原生执行历史</div>}</div><p className="note">最近 {r.history_limit} 条 ComfyUI 原生历史，包含画布上直接运行的工作流；后端重启后可能为空。耗时为执行时间，不含网关等待。</p></>;
}
// Gateway completions, all services or one: the only record of synchronous calls and chat.
export function GatewayRecords({records,service=null}){
 const rows=(records??[]).filter(r=>!service||r.model===service);
 return <><div className="task-table-wrap"><table className="task-table"><thead><tr><th>完成时间</th>{!service&&<th>服务</th>}<th>结果</th><th>完整耗时</th><th>等待与切换</th><th>处理与返回</th></tr></thead><tbody>{rows.map((r,i)=><tr key={r.finished_at+'-'+i}><td><time>{new Date(r.finished_at*1000).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'})} {clock(r.finished_at)}</time></td>{!service&&<td>{serviceName(r.model)}</td>}<td className={r.outcome==='success'?'live':'bad'}>{r.outcome==='success'?'完成':r.outcome==='disconnected'?'断开':'异常'}</td><td>{fmt(r.seconds)} 秒</td><td>{fmt(r.queue_seconds)} 秒</td><td>{fmt(Math.max(0,r.seconds-r.queue_seconds))} 秒</td></tr>)}</tbody></table>{!rows.length&&<div className="empty">暂无网关记录</div>}</div><p className="note">网关保留最近 30 条跨服务完成记录（同步调用、聊天和持久任务的执行），重启后清空；作品见持久任务。</p></>;
}
function NativeQueue(){
 const {value,error}=useRead('/api/mcp/runtime');
 return <section className="mcp-card">{error&&<p className="error-banner" role="alert">{error}</p>}<p className="note">API 发往 ComfyUI 的任务也会出现在这里，不能与持久任务数量相加。画布上直接运行的工作流没有 job_id，完整输出请在 ComfyUI 查看。</p>{!value?<div className="empty">正在读取原生队列…</div>:!value.native_queue.available?<div className="empty">ComfyUI 当前未运行（按需启动），读取队列不会启动它。</div>:<div className="task-table-wrap"><table className="task-table"><thead><tr><th>状态</th><th>序号</th><th>prompt_id</th></tr></thead><tbody>{[['running','执行中'],['pending','等待执行']].flatMap(([key,name])=>value.native_queue[key].map(row=><tr key={row.prompt_id}><td>{name}</td><td>{row.number}</td><td><code>{row.prompt_id}</code></td></tr>))}</tbody></table>{!value.native_queue.running.length&&!value.native_queue.pending.length&&<div className="empty">原生队列空闲</div>}</div>}<h3>原生执行历史</h3><NativeHistory runtime={value?.native_queue}/></section>;
}
export function TaskCenter({data,onOpen,openId}){
 const [scope,setScope]=useState('durable');
 const comfy=SERVICES.some(s=>s.native_ui);
 const tabs=[['durable','持久媒体任务'],['requests','网关请求记录'],...(comfy?[['native','ComfyUI 原生队列']]:[])];
 return <div className="control-center"><div className="workspace-toolbar"><div className="workspace-tabs" role="tablist" aria-label="任务来源">{tabs.map(([id,name])=><button key={id} role="tab" aria-selected={scope===id} onClick={()=>setScope(id)}>{name}</button>)}</div></div>
  {scope==='durable'&&<JobTable onOpen={onOpen} openId={openId}/>}
  {scope==='requests'&&<section className="mcp-card"><GatewayRecords records={data?.recent}/></section>}
  {scope==='native'&&<NativeQueue/>}
 </div>;
}
const METHOD_CLASS={GET:'is-get',POST:'is-post',PATCH:'is-patch'};
export function ApiPanel(){
 const {value,error}=useRead('/api/mcp/api');
 if(error)return <div className="control-center"><div className="empty">读取失败：{String(error.message??error)}</div></div>;
 if(!value)return <div className="control-center"><div className="empty">正在读取接口…</div></div>;
 return <div className="control-center">
  <section className="mcp-card"><h2>统一 API</h2><p><code>{value.base}</code></p>
   <p className="note">API 与 MCP 共享底层执行服务与 GPU Coordinator。接口随已启用的引擎登记：同步路径由各能力自己提供，停用后即消失。</p>
   <p className="api-access">{Object.entries(value.access).map(([k,v])=><span key={k} className={'api-badge is-'+k}>{v}</span>)}<span className="muted tiny">公网接口必须带有效 Bearer 密钥；持久媒体接口只在本机，并要求专用密钥。</span></p></section>
  {value.groups.map(g=><section className="mcp-card" key={g.id}>
   <div className="charthead"><h2>{g.label}</h2><span className="muted tiny">{g.routes.length} 个</span></div><p className="note">{g.note}</p>
   <div className="task-table-wrap"><table className="task-table api-table"><thead><tr><th>方法</th><th>路径</th><th>用途</th><th>范围</th></tr></thead><tbody>
    {g.routes.map(r=><tr key={r.method+r.path}><td><span className={'api-method '+(METHOD_CLASS[r.method]??'')}>{r.method}</span></td><td><code>{r.path}</code></td>
     <td>{r.purpose}{r.models&&<small className="api-models">主推 <code>{r.models.primary}</code>{r.models.providers.length>1&&<> · 可用 {r.models.providers.join('、')}</>}</small>}</td>
     <td><span className={'api-badge is-'+r.access}>{value.access[r.access]}</span></td></tr>)}
   </tbody></table></div></section>)}
  <section className="mcp-card"><div className="charthead"><h2>可提交的持久任务</h2><span className="muted tiny">POST /v1/media/jobs 的 tool · {value.job_tools.length} 个能力</span></div>
   <p className="note">与 MCP 的生成工具同源：只列出已启用引擎提供的能力，带 task 的工具用 task 选择具体工作。</p>
   <div className="task-table-wrap"><table className="task-table api-table"><thead><tr><th>tool</th><th>task</th><th>能力</th><th>分类</th><th>模型</th></tr></thead><tbody>
    {value.job_tools.map(t=><tr key={t.capability}><td><code>{t.tool}</code></td><td>{t.task?<code>{t.task}</code>:'—'}</td><td>{t.label}</td><td>{t.category??'—'}</td><td><code>{t.primary}</code>{t.providers.length>1&&<small className="api-models"> 备用 {t.providers.filter(p=>p!==t.primary).join('、')}</small>}</td></tr>)}
   </tbody></table></div></section>
 </div>;
}
