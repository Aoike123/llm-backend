'use client';
import {useEffect,useState} from 'react';
import {useRead} from './use-read.mjs';
import {ActionButton,Switch} from './ui-controls.mjs';
const CATEGORY={llm:'语言',image:'图像',video:'视频',audio:'音频'};
async function post(path,body){
  const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const value=await r.json().catch(()=>({}));if(!r.ok)throw Error(value.error??('请求失败（'+r.status+'）'));return value;
}
function PackageRow({pkg,onChange}){
  const [busy,setBusy]=useState(false),[armed,setArmed]=useState(false),[error,setError]=useState('');
  async function toggle(){
    if(pkg.enabled&&!armed){setArmed(true);return;}
    setBusy(true);setError('');
    try{onChange(await post('/api/platform/engines/'+pkg.id,{enabled:!pkg.enabled}));setArmed(false);}catch(e){setError(e.message);}finally{setBusy(false);}
  }
  return <div className={'engine-package'+(pkg.enabled?'':' disabled')}>
    <span className="catalog-symbol" style={{color:pkg.accent}}>{pkg.symbol}</span>
    <div><strong>{pkg.display_name}<small>{pkg.version}</small></strong><p>{pkg.description}</p>
      <p className="muted tiny">{CATEGORY[pkg.category]??pkg.category} · <code>{pkg.path}</code> · 端口 {pkg.runtime.port}{pkg.status?' · '+pkg.status:''}</p>
      <p className="engine-models">{pkg.models.length?pkg.models.map(m=><span key={m.id}><code>{m.id}</code>{m.capabilities.join(' / ')}</span>):<span>对话（/v1/chat/completions）</span>}</p>
      {error&&<p className="bad" role="alert">{error}</p>}</div>
    <div className="engine-toggle">
      <Switch checked={pkg.enabled} busy={busy} onChange={toggle} label={busy?'处理中…':pkg.enabled?'已启用':'已停用'}/>
      {armed&&<div className="engine-confirm" role="alert"><span>停用会停止它正在运行的容器</span><ActionButton variant="danger" onClick={toggle}>确认停用</ActionButton><ActionButton variant="quiet" onClick={()=>setArmed(false)}>取消</ActionButton></div>}
    </div>
  </div>;
}
function RouteEditor({route,label,onChange}){
  const initial=()=>[route.primary,...route.fallbacks];
  const [chain,setChain]=useState(initial),[backend,setBackend]=useState(route.fallback_on_backend_error),[saving,setSaving]=useState(false),[error,setError]=useState('');
  useEffect(()=>{setChain(initial());setBackend(route.fallback_on_backend_error);},[route.primary,route.fallbacks.join(),route.fallback_on_backend_error]);
  const outside=route.providers.filter(id=>!chain.includes(id)),dirty=chain.join()!==initial().join()||backend!==route.fallback_on_backend_error;
  const move=(i,d)=>{const next=[...chain];[next[i],next[i+d]]=[next[i+d],next[i]];setChain(next);};
  async function save(){setSaving(true);setError('');try{onChange(await post('/api/platform/routing/'+route.capability,{primary:chain[0],fallbacks:chain.slice(1),fallback_on_backend_error:backend}));}catch(e){setError(e.message);}finally{setSaving(false);}}
  return <div className="route-editor"><div className="charthead"><h3>{label}<small> {route.capability} · {route.tool}</small></h3>{route.sync&&<code className="muted tiny">{route.sync}</code>}</div>
    <ol>{chain.map((id,i)=><li key={id}><span className={i?'muted':'live'}>{i?'降级 '+i:'主推'}</span><code>{id}</code>
      <span className="route-actions" role="group" aria-label={'调整 '+id}><ActionButton variant="quiet" icon="up" aria-label="上移" title="上移" disabled={!i} onClick={()=>move(i,-1)}/><ActionButton variant="quiet" icon="down" aria-label="下移" title="下移" disabled={i===chain.length-1} onClick={()=>move(i,1)}/>{chain.length>1&&<ActionButton variant="quiet" icon="close" className="route-remove" aria-label="移出降级链" title="移出降级链" onClick={()=>setChain(chain.filter(x=>x!==id))}/>}</span></li>)}</ol>
    {outside.length>0&&<p className="note">未纳入降级链（只能点名使用）：{outside.map(id=><button key={id} className="mcp-link" onClick={()=>setChain([...chain,id])}>+ {id}</button>)}</p>}
    <Switch className="route-backend" checked={backend} onChange={setBackend} label="后端明确报错时也降级" description="默认关闭：同一个坏输入不应把每个引擎都试一遍"/>
    {error&&<p className="bad" role="alert">{error}</p>}
    {(dirty||saving)&&<div className="route-save"><ActionButton variant="primary" disabled={saving} onClick={save}>{saving?'保存中…':'保存路由'}</ActionButton><ActionButton variant="quiet" onClick={()=>{setChain(initial());setBackend(route.fallback_on_backend_error);}}>还原</ActionButton><span className="muted tiny">有未保存的修改</span></div>}
  </div>;
}
export default function EnginesPanel(){
  const {value,error}=useRead('/api/platform');const [latest,setLatest]=useState(null);
  const view=latest??value;useEffect(()=>{setLatest(null);},[value]);
  return <div className="control-center engines-panel">
    {error&&<p className="error-banner" role="alert">{error}</p>}
    {view?.scan_error&&<p className="error-banner" role="alert">新引擎目录有误，未载入：{view.scan_error}</p>}
    <section className="mcp-card"><div className="charthead"><h2>引擎包</h2><span className="muted tiny">engines/*/*/engine.json · 新增目录后在此启用</span></div>
      <p className="note">一个引擎就是一个目录（清单 + adapter）。停用后它从 API、MCP 和服务列表中消失，文件保留；正在使用或排队的引擎不能停用。</p>
      {view?view.packages.map(pkg=><PackageRow key={pkg.id} pkg={pkg} onChange={setLatest}/>):<div className="empty">正在读取引擎包…</div>}
    </section>
    <section className="mcp-card"><div className="charthead"><h2>能力路由</h2><span className="muted tiny">API 与 MCP 默认走主推</span></div>
      <p className="note">请求不点名模型时按此顺序尝试。只有确定没有生成时才降级：引擎停用、启动失败或派发前被拒绝；结果不确定的任务永远不重试。点名模型的请求不降级。</p>
      {view?view.capabilities.map(route=><RouteEditor key={route.capability} route={route} label={view.capability_labels?.[route.capability]??route.capability} onChange={setLatest}/>):null}
      {view&&!view.capabilities.length&&<div className="empty">没有启用的媒体能力</div>}
    </section>
  </div>;
}
