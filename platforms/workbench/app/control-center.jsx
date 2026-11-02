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
export function ApiPanel(){
 const {value,error}=useRead('/api/mcp/overview');
 const routes=[['POST','/v1/images/generations','生图（Qwen-Image / Anima），同步'],['POST','/v1/images/edits','Qwen 编辑，同步'],['POST','/v1/videos/generations','视频生成（H3），同步'],['POST','/v1/media/jobs','持久任务（全部媒体能力），返回 202'],['GET','/v1/models','聊天模型与已保存额度'],['GET','/v1/media/models','媒体模型目录，不加载模型'],['GET','/v1/capabilities','能力、主推与降级顺序'],['POST','/v1/chat/completions','聊天 / SSE'],['POST','/v1/media/assets?kind=image','上传素材（二进制）'],['GET','/v1/media/jobs/{job_id}','查询任务，可短等待'],['POST','/v1/media/jobs/{job_id}/cancel','派发前取消'],['GET','/v1/media/artifacts/{artifact_id}','作品元数据'],['GET','/v1/media/artifacts/{artifact_id}/content','下载作品（二进制）']];
 return <div className="control-center"><section className="mcp-card"><h2>统一 API</h2><p><code>http://127.0.0.1:18982/v1</code></p><p className="note">聊天目录与媒体目录分开。API 和 MCP 共享底层执行服务与 GPU Coordinator；持久媒体 API 是本机接口，未通过公网代理开放。</p><p className="note">公网 API 必须携带有效 Bearer 密钥。本机同步 API 保留可信调用兼容；显式密钥按额度管理。持久媒体 API / MCP 必须使用专用有效密钥。</p><div className="task-table-wrap"><table className="task-table"><thead><tr><th>方法</th><th>路径</th><th>用途</th></tr></thead><tbody>{routes.map(([method,path,purpose])=><tr key={path+method}><td>{method}</td><td><code>{path}</code></td><td>{purpose}</td></tr>)}</tbody></table></div></section><section className="mcp-card"><h2>媒体能力</h2>{error&&<p role="alert">{error}</p>}<div className="mcp-models">{value?.capabilities?.map(route=><div key={route.capability}><strong>{route.label} · <code>{route.tool}</code></strong><p>主推 <code>{route.primary}</code>{route.fallbacks.length?' · 降级 '+route.fallbacks.join(' → '):''}</p><p>{route.sync?'同步 '+route.sync+' · ':''}持久任务 /v1/media/jobs</p></div>)}</div><p className="note">请求不带 model（或 model=auto）时走主推；点名模型不降级。主推与降级在「引擎」页设置。</p></section></div>;
}
