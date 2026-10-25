'use client';
import {Fragment,useCallback,useEffect,useState} from 'react';
import {ActionButton,Icon} from './ui-controls.mjs';
// Public endpoint shown to key holders; set NEXT_PUBLIC_WORKBENCH_PUBLIC_API at build time.
const BASE=process.env.NEXT_PUBLIC_WORKBENCH_PUBLIC_API??'https://api.example.com/v1';
const time=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'尚未使用';
function KeyRow({item,onChange,busy}){
  const values=()=>({name:item.name,maxConcurrent:item.maxConcurrent,requestsPerMinute:item.requestsPerMinute,maxQueued:item.maxQueued});
  const [draft,setDraft]=useState(values),[editing,setEditing]=useState(false),[deleting,setDeleting]=useState(false);
  useEffect(()=>setDraft(values()),[item.name,item.maxConcurrent,item.requestsPerMinute,item.maxQueued]);
  const changed=draft.name!==item.name||Number(draft.maxConcurrent)!==item.maxConcurrent||Number(draft.requestsPerMinute)!==item.requestsPerMinute||Number(draft.maxQueued)!==item.maxQueued;
  async function save(e){e.preventDefault();if(await onChange({action:'update',id:item.id,...draft,maxConcurrent:Number(draft.maxConcurrent),requestsPerMinute:Number(draft.requestsPerMinute),maxQueued:Number(draft.maxQueued)}))setEditing(false);}
  return <Fragment><tr className={editing?'key-row editing':'key-row'}>
    <td><div className="key-identity"><span className="key-avatar"><Icon name="key"/></span><div><strong>{item.name}</strong><code>{item.preview}</code></div></div></td>
    <td data-label="状态"><span className={'key-status '+(item.enabled?'enabled':'disabled')}><i/>{item.enabled?'已启用':'已停用'}</span></td>
    <td data-label="访问额度"><div className="key-quotas"><span><b>{item.maxConcurrent}</b> 路并发</span><span><b>{item.requestsPerMinute}</b> RPM</span><span><b>{item.maxQueued}</b> 个等待</span></div><small>执行 {item.active} · 等待 {item.queued??0}</small></td>
    <td data-label="使用情况"><strong className="key-request-count">{item.requests}<span> 次</span></strong><small>{item.lastUsedAt?time(item.lastUsedAt):'暂无请求'}</small></td>
    <td><div className="key-row-actions"><ActionButton variant="quiet" disabled={busy} aria-expanded={editing} aria-label={'编辑 '+item.name} onClick={()=>{setDraft(values());setEditing(!editing);setDeleting(false);}}>{editing?'收起':'编辑'}</ActionButton><ActionButton variant="quiet" disabled={busy} onClick={()=>onChange({action:'update',id:item.id,enabled:!item.enabled})}>{item.enabled?'停用':'启用'}</ActionButton>{deleting?<><ActionButton className="key-delete" disabled={busy} onClick={()=>onChange({action:'delete',id:item.id})}>确认删除</ActionButton><ActionButton variant="quiet" disabled={busy} onClick={()=>setDeleting(false)}>取消</ActionButton></>:<ActionButton variant="quiet" aria-label={'删除 '+item.name} disabled={busy} onClick={()=>setDeleting(true)}><Icon name="trash"/></ActionButton>}</div></td>
  </tr>{editing&&<tr className="key-edit-row"><td colSpan={5}><form className="key-inline-editor" aria-label={'编辑 '+item.name+' 的额度'} onSubmit={save}><div className="key-edit-heading"><span>密钥设置</span><small>创建于 {time(item.createdAt)}</small></div><div className="key-edit-fields"><label>名称<input required aria-label={`${item.name} 名称`} maxLength={80} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label><label>执行并发<NumberField label={`${item.name} 执行并发上限`} min={1} max={32} value={draft.maxConcurrent} unit="路" onChange={value=>setDraft({...draft,maxConcurrent:value})}/></label><label>请求频率<NumberField label={`${item.name} 每分钟请求数`} min={1} max={60000} value={draft.requestsPerMinute} unit="RPM" onChange={value=>setDraft({...draft,requestsPerMinute:value})}/></label><label>等待名额<NumberField label={`${item.name} 等待名额`} min={0} max={128} value={draft.maxQueued} unit="个" onChange={value=>setDraft({...draft,maxQueued:value})}/></label></div><div className="key-editor-footer"><span>等待名额设为 0 时，并发满额将直接拒绝新请求。</span><ActionButton variant="quiet" disabled={busy} onClick={()=>setEditing(false)}>取消</ActionButton><ActionButton variant="primary" icon="check" type="submit" disabled={busy||!changed}>保存修改</ActionButton></div></form></td></tr>}</Fragment>;
}
function QuotaControl({title,help,label,value,min,max,unit,onChange,disabled}){
  return <div className="key-quota-control"><span className="key-quota-label">{title}</span><NumberField label={label} min={min} max={max} value={value} unit={unit} onChange={onChange} disabled={disabled}/><p>{help}</p></div>;
}
function NumberField({label,value,min,max,unit,onChange,disabled}){
 return <span className="key-input-unit"><input required disabled={disabled} aria-label={label} type="number" min={min} max={max} value={value} onChange={e=>onChange(e.target.value)}/><span>{unit}</span></span>;
}
export default function AccessKeyManager(){
  const [data,setData]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[secret,setSecret]=useState(''),[copied,setCopied]=useState('');
  const [draft,setDraft]=useState({name:'',maxConcurrent:1,requestsPerMinute:60,maxQueued:8}),[limits,setLimits]=useState(null);
  const refresh=useCallback(async(signal)=>{
    const response=await fetch('/api/access-keys',{cache:'no-store',signal});const result=await response.json();if(!response.ok)throw new Error(result.error??'读取密钥失败');setData(result);setError('');
  },[]);
  useEffect(()=>{const controller=new AbortController();let timer,disposed=false;async function poll(){try{await refresh(controller.signal);}catch(e){if(!disposed)setError(e.message);}finally{if(!disposed)timer=setTimeout(poll,3000);}}poll();return()=>{disposed=true;controller.abort();clearTimeout(timer);};},[refresh]);
  useEffect(()=>{if(data)setLimits({...data.settings});},[data?.settings.maxConcurrent,data?.settings.requestsPerMinute,data?.settings.maxQueued,data?.settings.queueWaitSeconds]);
  async function change(payload){
    setBusy(true);setError('');
    try{const response=await fetch('/api/access-keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const {secret:created,...result}=await response.json();if(!response.ok)throw new Error(result.error??'保存失败');setData(result);if(created){setSecret(created);setCopied('');setDraft({...draft,name:''});}return true;}
    catch(e){setError(e.message);return false;}finally{setBusy(false);}
  }
  async function copy(text,label){try{await navigator.clipboard.writeText(text);setCopied(label);}catch{setError('复制失败，请选中文本手动复制。');}}
  return <div className="access-keys stage-enter">
    {error&&<div className="error-banner" role="alert">{error}</div>}
    <section className="key-endpoint"><span className="key-endpoint-icon"><Icon name="external"/></span><div><span>API 接入地址</span><code>{BASE}</code></div><span className="key-endpoint-badge"><i/>OpenAI 兼容</span><ActionButton icon="copy" onClick={()=>copy(BASE,'地址')}>{copied==='地址'?'已复制':'复制地址'}</ActionButton></section>
    <div className="key-overview"><div><span>已启用密钥</span><strong>{data?data.keys.filter(k=>k.enabled).length:'—'}<small> / {data?.keys.length??'—'}</small></strong><small>可访问聊天、图像与视频</small></div><div><span>执行中</span><strong>{data?.active??'—'}<small> / {data?.settings.maxConcurrent??'—'} 路</small></strong><small>按密钥与全局额度放行</small></div><div><span>排队中</span><strong>{data?.queued??'—'}<small> / {data?.settings.maxQueued??'—'} 个</small></strong><small>等待名额 · 不占执行并发</small></div><div><span>累计请求</span><strong>{data?.keys.reduce((sum,k)=>sum+k.requests,0)??'—'}<small> 次</small></strong><small>现有密钥 · 本次网关运行期间</small></div></div>
    <div className="key-forms">
      <form className="key-card key-create" onSubmit={e=>{e.preventDefault();change({action:'create',name:draft.name,maxConcurrent:Number(draft.maxConcurrent),requestsPerMinute:Number(draft.requestsPerMinute),maxQueued:Number(draft.maxQueued)});}}>
        <div className="key-card-heading"><span className="key-card-icon"><Icon name="plus"/></span><div><h3>创建访问密钥</h3><p>独立密钥，独立访问额度</p></div><span className="key-card-tag">个人额度</span></div>
        <label className="key-name-field">密钥名称<input required maxLength={80} placeholder="例如：设计团队、小王" value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
        <div className="key-form-grid three"><QuotaControl title="执行并发" help="同时放行的请求数" disabled={busy} label="新密钥执行并发" min={1} max={32} value={draft.maxConcurrent} unit="路" onChange={value=>setDraft({...draft,maxConcurrent:value})}/><QuotaControl title="请求频率" help="每分钟可放行的请求数" disabled={busy} label="新密钥请求频率" min={1} max={60000} value={draft.requestsPerMinute} unit="RPM" onChange={value=>setDraft({...draft,requestsPerMinute:value})}/><QuotaControl title="等待名额" help="并发满额后的排队容量" disabled={busy} label="新密钥等待名额" min={0} max={128} value={draft.maxQueued} unit="个" onChange={value=>setDraft({...draft,maxQueued:value})}/></div>
        <div className="key-card-footer"><p>并发满额后进入等待队列。完整密钥仅在创建后显示一次。</p><ActionButton variant="primary" icon="plus" type="submit" disabled={busy||!data}>{busy?'保存中…':'创建密钥'}</ActionButton></div>
      </form>
      <form className="key-card key-global" onSubmit={e=>{e.preventDefault();change({action:'settings',maxConcurrent:Number(limits.maxConcurrent),requestsPerMinute:Number(limits.requestsPerMinute),maxQueued:Number(limits.maxQueued),queueWaitSeconds:Number(limits.queueWaitSeconds)});}}>
        <div className="key-card-heading"><span className="key-card-icon neutral"><Icon name="settings"/></span><div><h3>全局访问额度</h3><p>统一控制所有密钥的请求总量</p></div><span className="key-card-tag">全局限制</span></div>
        {limits?<><div className="key-form-grid"><QuotaControl title="执行并发上限" help="所有密钥共享的执行名额" disabled={busy} label="全局执行并发上限" min={1} max={32} value={limits.maxConcurrent} unit="路" onChange={value=>setLimits({...limits,maxConcurrent:value})}/><QuotaControl title="每分钟请求上限" help="所有密钥共享的请求频率" disabled={busy} label="全局每分钟请求上限" min={1} max={60000} value={limits.requestsPerMinute} unit="RPM" onChange={value=>setLimits({...limits,requestsPerMinute:value})}/></div><div className="key-form-grid"><QuotaControl title="总等待名额" help="所有密钥共享的排队容量" disabled={busy} label="全局总等待名额" min={0} max={256} value={limits.maxQueued} unit="个" onChange={value=>setLimits({...limits,maxQueued:value})}/><QuotaControl title="最长入口等待" help="等待请求放行的最长时间" disabled={busy} label="全局最长入口等待" min={1} max={900} value={limits.queueWaitSeconds} unit="秒" onChange={value=>setLimits({...limits,queueWaitSeconds:value})}/></div><div className="key-card-footer"><p>聊天、图像与视频共用额度。模型切换与生成耗时另计。</p><ActionButton icon="check" type="submit" disabled={busy}>保存额度</ActionButton></div></>:<p className="note">正在读取额度…</p>}
      </form>
    </div>
    {secret&&<section className="key-reveal" aria-label="新密钥" role="status"><div className="charthead"><h3>密钥已创建</h3><ActionButton icon="close" aria-label="关闭新密钥" onClick={()=>setSecret('')}>关闭</ActionButton></div><p>完整密钥仅在本次显示。复制后交给使用者，关闭后仅保留摘要。</p><textarea readOnly aria-label="完整 API 密钥" value={secret} rows={2}/><div className="key-row-actions"><ActionButton variant="primary" icon="copy" onClick={()=>copy(secret,'密钥')}>{copied==='密钥'?'已复制':'复制密钥'}</ActionButton><ActionButton icon="copy" onClick={()=>copy(`Base URL: ${BASE}\nAPI Key: ${secret}\n`,'配置')}>{copied==='配置'?'已复制':'复制分发配置'}</ActionButton></div></section>}
    <section className="key-list"><div className="charthead"><div className="key-list-heading"><h3>访问密钥</h3><span>{data?.keys.length??0}</span></div><span className="key-live"><i/>每 3 秒更新</span></div>{!data?<div className="empty">正在读取密钥…</div>:!data.keys.length?<div className="empty">创建第一把密钥，分发给 API 使用者。</div>:<div className="key-table-wrap"><table><thead><tr><th>密钥名称</th><th>状态</th><th>访问额度</th><th>请求 / 最近使用</th><th>操作</th></tr></thead><tbody>{data.keys.map(item=><KeyRow key={item.id} item={item} busy={busy} onChange={change}/>)}</tbody></table></div>}<p className="note">停用可随时恢复；删除后立即失效。额度在请求放行时计数，模型目录查询不占执行并发。</p></section>
  </div>;
}
