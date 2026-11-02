'use client';
import {useEffect,useState} from 'react';
import {ActionButton,Icon} from './ui-controls.mjs';
import {ArtifactView} from './artifact-view';
import McpModelView from './mcp-model-view';
import McpTools from './mcp-tools';
const tabs=[['overview','概览'],['model','模型视角'],['tools','工具参数'],['config','接入配置'],['calls','调用记录']];
const date=v=>v?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'暂无记录';
const states={queued:'已排队',preparing:'素材准备',waiting_for_admission:'等待名额',waiting_for_engine:'等待引擎',dispatching:'已派发',running:'生成中',saving:'保存中',succeeded:'已完成',failed:'失败',cancelled:'已取消',recovering:'恢复检查',unknown:'结果未知'};
function Code({value}){
  const [copied,setCopied]=useState(false),[error,setError]=useState('');const text=typeof value==='string'?value:JSON.stringify(value,null,2);
  return <div className="mcp-code"><pre>{text}</pre><ActionButton onClick={async()=>{try{await navigator.clipboard.writeText(text);setCopied(true);setError('');setTimeout(()=>setCopied(false),1500);}catch{setError('复制失败，请手动选择文本');}}}>{copied?'已复制':'复制'}</ActionButton>{error&&<p role="alert">{error}</p>}</div>;
}
function useMcpResource(path,poll=true){
  const [snapshots,setSnapshots]=useState({}),[failure,setFailure]=useState(null);
  const cached=path?snapshots[path]:null;
  useEffect(()=>{
    if(!path||(!poll&&cached))return;
    const controller=new AbortController();let timer,disposed=false,busy=false,loaded=Boolean(cached);
    async function read(){
      if(disposed||document.hidden||busy||(!poll&&loaded))return;busy=true;let retry=poll;
      try{
        const response=await fetch('/api/mcp/'+path,{cache:'no-store',signal:controller.signal});
        if(!response.ok)throw new Error('MCP 信息读取失败（'+response.status+'）');
        const value=await response.json();
        if(!disposed){loaded=true;setSnapshots(previous=>({...previous,[path]:value}));setFailure(null);}
      }catch(error){retry=true;if(!disposed&&error.name!=='AbortError')setFailure({path,message:error.message+'，正在重试。保留上次读取结果。'});}
      finally{busy=false;if(!disposed&&retry){clearTimeout(timer);timer=setTimeout(read,5000);}}
    }
    const visibility=()=>{clearTimeout(timer);if(!document.hidden)void read();};
    document.addEventListener('visibilitychange',visibility);void read();
    return()=>{disposed=true;controller.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);};
  },[path,poll]);
  return {value:cached??null,error:failure?.path===path?failure.message:''};
}
export default function McpPanel(){
  const [tab,setTab]=useState('overview'),[offset,setOffset]=useState(0),[jobId,setJobId]=useState(null);
  const overviewResource=useMcpResource('overview');
  const contentResource=useMcpResource(tab==='overview'?null:tab==='model'||tab==='tools'?'model-view':tab+(tab==='calls'?'?offset='+offset+'&limit=30':''),tab==='calls');
  const jobResource=useMcpResource(jobId?'jobs/'+jobId:null);
  const overview=overviewResource.value,content=contentResource.value,job=jobResource.value,error=overviewResource.error||contentResource.error||jobResource.error;
  useEffect(()=>{if(job?.job_id){const panel=document.getElementById('mcp-job-detail');panel?.scrollIntoView({behavior:'smooth',block:'start'});panel?.focus({preventScroll:true});}},[job?.job_id]);
  return <div className="mcp-panel">
    <div className="workspace-toolbar"><div className="workspace-tabs" role="tablist" aria-label="MCP 信息">{tabs.map(([id,label],i)=><button key={id} id={'mcp-tab-'+id} role="tab" aria-selected={tab===id} aria-controls="mcp-content" tabIndex={tab===id?0:-1} onClick={()=>{setTab(id);setJobId(null);}} onKeyDown={e=>{let next;if(e.key==='ArrowRight')next=tabs[(i+1)%tabs.length][0];if(e.key==='ArrowLeft')next=tabs[(i+tabs.length-1)%tabs.length][0];if(e.key==='Home')next=tabs[0][0];if(e.key==='End')next=tabs.at(-1)[0];if(next){e.preventDefault();setTab(next);setJobId(null);document.getElementById('mcp-tab-'+next)?.focus();}}}>{label}</button>)}</div><small className="muted">本机 stdio · 每 5 秒刷新</small></div>
    {error&&<div className="error-banner" role="alert">{error}</div>}
    <section id="mcp-content" role="tabpanel" aria-labelledby={'mcp-tab-'+tab} className="mcp-content">
      {tab==='overview'&&(overview?<>
        <section className="stage-kpis"><div className="stage-kpi"><span className="label">MCP 服务</span><div className="mcp-value">{overview.name}</div><p className="note">v{overview.version} · 已部署 · 客户端按需启动</p></div><div className="stage-kpi"><span className="label">媒体工具</span><div className="stage-value">{overview.tools_count}<span>个</span></div><p className="note">{overview.models.length} 个媒体模型 · {overview.workflows?.length??0} 个原生工作流</p></div><div className="stage-kpi"><span className="label">网关依赖</span><div className="mcp-value">{overview.gateway.recovery_pending?'恢复检查':overview.gateway.status==='ready'?'就绪':'排空中'}</div><p className="note">待完成媒体任务 {overview.pending_jobs} 个</p></div><div className="stage-kpi"><span className="label">MCP 媒体存储</span><div className="mcp-value">{(overview.storage.used_bytes/2**30).toFixed(2)} GiB</div><p className="note">配额 {(overview.storage.quota_bytes/2**30).toFixed(0)} GiB · 作品盘按类型和月份存放</p></div></section>
        <section className="mcp-card"><div className="charthead"><h2>实例上报</h2><span className="muted tiny">最近报告 {date(overview.last_reported_at)}</span></div><p className="note">{overview.note}</p>{overview.instances.length?<div className="task-table-wrap"><table className="task-table"><thead><tr><th>实例 / 客户端</th><th>观察状态</th><th>协议初始化</th><th>最后报告</th></tr></thead><tbody>{overview.instances.map(i=><tr key={i.owner_id+':'+i.instance_id}><td><code title={i.instance_id}>{i.instance_id.slice(0,18)}…</code><small className="mcp-sub">{i.client_name??'客户端未知'}</small></td><td className={i.closed_at||i.stale?'muted':'live'}>{i.closed_at?'已报告退出':i.stale?'信息过期':'最近有上报'}</td><td>{i.initialized_at?date(i.initialized_at):'尚无初始化报告'}<small className="mcp-sub">{i.protocol_version??'协议版本未知'}</small></td><td>{date(i.last_reported_at)}</td></tr>)}</tbody></table></div>:<div className="empty">尚无实例上报。请在客户端配置 local-media 并启动，然后发现工具。</div>}</section>
        <section className="mcp-card"><div className="charthead"><h2>媒体能力目录</h2><span className="muted tiny">能力清单 · 浏览不加载模型</span></div><div className="mcp-models">{overview.models.map(m=><div key={m.id}><strong>{m.id}</strong><small>{{image:'图像',video:'视频',audio:'音频'}[m.kind]??m.kind}</small><p>{m.tasks.join(' · ')}</p><small>{'运行时 '+(m.execution_runtime??'—')+' · 按需启动'}</small></div>)}</div></section>
        {overview.workflows?.length>0&&<section className="mcp-card"><h2>原生工作流</h2><div className="mcp-models">{overview.workflows.map(workflow=><div key={workflow.id}><strong>{workflow.name}</strong><p><code>{workflow.tool}</code></p><p>ComfyUI 原生执行 · 最多 {workflow.reference_images} 张图 / {workflow.reference_videos} 段视频 / {workflow.reference_audios} 段音频</p><p>{workflow.controls?.join(" · ")}</p><p>各参考槽位未传即关闭；LoRA 与优化默认保持原版状态。参数见「工具参数」。</p></div>)}</div></section>}
      </>:<div className="empty">正在读取 MCP 部署信息…</div>)}
      {tab==='config'&&(content?<section className="mcp-card"><h2>本机 stdio 接入</h2><p>先在终端初始化本机凭据，再将下面的 JSON 添加到支持 stdio 的 MCP 客户端。</p><Code value={content.setup_command}/><Code value={content.client_config}/><dl className="mcp-details"><div><dt>工作目录</dt><dd>{content.cwd}</dd></div><div><dt>凭据文件</dt><dd>{content.config_file}</dd></div><div><dt>导入目录</dt><dd>默认 资源盘导入目录（platform.json 的 storage.import_roots）与当前工作区；可在凭据文件配置 import_roots，或通过 MEDIA_IMPORT_ROOTS（冒号分隔）追加。</dd></div></dl><p className="note">{content.credential_note}</p><p className="note">可用 MEDIA_GATEWAY_URL、MEDIA_API_KEY、MEDIA_MCP_CONFIG 覆盖本机配置。HTTP MCP 尚未部署。</p><h3>验证连接</h3><p>客户端启动后执行工具发现，应该看到每个已启用能力一个生成工具，加上 2 个目录与素材、5 个任务与作品工具（数量随「引擎」页的启用状态变化）。list_media_models 只读取能力清单，并给出每种能力的主推与降级；随后可在概览查看初始化上报。无需生图验证连通。</p></section>:<div className="empty">正在读取接入配置…</div>)}
      {tab==='model'&&(content?.tools?<McpModelView view={content}/>:<div className="empty">正在读取模型视角…</div>)}
      {tab==='tools'&&(content?.tools?<McpTools tools={content.tools} models={content.models}/>:<div className="empty">正在读取工具定义…</div>)}
      {tab==='calls'&&(content?<><section className="mcp-card"><div className="charthead"><h2>工具调用记录</h2><span className="muted tiny">最多 5000 条 · 保留 {content.retention_days} 天</span></div><p className="note">工具成功表示调用已返回；生成结果由关联任务单独记录。提示词、密钥和媒体内容不写入此记录。</p>{content.calls.length?<div className="task-table-wrap"><table className="task-table"><thead><tr><th>时间 / 实例</th><th>工具</th><th>调用结果</th><th>耗时</th><th>媒体任务</th></tr></thead><tbody>{content.calls.map(c=><tr key={c.call_id}><td>{date(c.at)}<small className="mcp-sub" title={c.instance_id}>{c.instance_id.slice(0,18)}…</small></td><td><code>{c.tool}</code></td><td className={c.status==='success'?'live':'bad'}>{c.status==='success'?'返回成功':'调用失败'}</td><td>{c.duration_ms} ms</td><td>{c.job_id?<button className="mcp-link" title={c.job_id} onClick={()=>{setJobId(c.job_id);}}>{states[c.job_state]??'查看任务'}</button>:'—'}</td></tr>)}</tbody></table></div>:<div className="empty">暂无工具调用。客户端调用工具后，脱敏记录将显示在这里。</div>}<div className="mcp-pagination"><ActionButton disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-30))}>上一页</ActionButton><span>{content.calls.length?offset+1:0}–{offset+content.calls.length} / {content.total}</span><ActionButton disabled={!content.has_more} onClick={()=>setOffset(offset+30)}>下一页</ActionButton></div></section>
        {jobId&&<section className="mcp-card" id="mcp-job-detail" tabIndex={-1}><div className="charthead"><h2>关联媒体任务</h2><ActionButton onClick={()=>{setJobId(null);}}>关闭</ActionButton></div>{job?<><p><code>{job.job_id}</code> · <strong>{states[job.state]??job.state}</strong> · {job.model}</p><p className="note">{job.cancellable?'尚未派发到后端，可由任务所有者取消。':'当前状态不支持取消。'} 创建于 {date(job.created_at)}</p>{job.error&&<p className="error-banner">{job.error.code} · {job.error.message}</p>}{job.effective_parameters&&<details><summary>实际参数</summary><Code value={job.effective_parameters}/></details>}<div className="mcp-artifact">{job.artifacts.map(a=><ArtifactView key={a.artifact_id} artifact={a}/>)}</div></>:<div className="empty">正在读取任务…</div>}</section>}
      </>:<div className="empty">正在读取调用记录…</div>)}
    </section>
  </div>;
}
