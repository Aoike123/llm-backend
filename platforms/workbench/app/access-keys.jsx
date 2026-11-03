'use client';
import {useEffect,useState} from 'react';
import {ActionButton,Icon,Switch} from './ui-controls.mjs';
import PublicExposure from './public-exposure';
import {time,useManaged,useCopy,NumberField,TUNNEL} from './access-shared';
// One page for who may call the gateway and what the internet may reach. Keys, the public
// switchboard and the shared quotas are tabs of it; a status strip above keeps the headline
// numbers in view whichever tab is open.
const QUOTAS=[['maxConcurrent','执行并发','路',1,32,'同时占用 GPU 的请求数'],['requestsPerMinute','请求频率','RPM',1,60000,'每分钟放行的请求数'],['maxQueued','等待名额','个',0,128,'并发满额后可排队的请求数']];
const quotaPayload=draft=>({maxConcurrent:Number(draft.maxConcurrent),requestsPerMinute:Number(draft.requestsPerMinute),maxQueued:Number(draft.maxQueued)});

function KeyItem({item,post,busy}){
  const values=()=>({name:item.name,maxConcurrent:item.maxConcurrent,requestsPerMinute:item.requestsPerMinute,maxQueued:item.maxQueued});
  const [draft,setDraft]=useState(values),[editing,setEditing]=useState(false),[deleting,setDeleting]=useState(false);
  useEffect(()=>setDraft(values()),[item.name,item.maxConcurrent,item.requestsPerMinute,item.maxQueued]);
  const changed=draft.name!==item.name||QUOTAS.some(([k])=>Number(draft[k])!==item[k]);
  async function save(e){e.preventDefault();if((await post({action:'update',id:item.id,name:draft.name,...quotaPayload(draft)})).ok)setEditing(false);}
  return <li className={'ak-key'+(item.enabled?'':' is-off')}>
    <div className="ak-key-main">
      <span className="ak-key-icon"><Icon name="key"/></span>
      <div className="ak-key-name"><strong>{item.name}</strong><code>{item.preview}</code></div>
      <Switch checked={item.enabled} busy={busy} onChange={enabled=>post({action:'update',id:item.id,enabled})} label={item.enabled?'已启用':'已停用'}/>
    </div>
    <dl className="ak-key-facts">
      <div><dt>额度</dt><dd>{item.maxConcurrent} 路并发 · {item.requestsPerMinute} RPM · {item.maxQueued} 个等待</dd></div>
      <div><dt>现在</dt><dd>执行 {item.active} · 等待 {item.queued??0}</dd></div>
      <div><dt>累计</dt><dd>{item.requests} 次{item.lastUsedAt?' · 最近 '+time(item.lastUsedAt):' · 暂无请求'}</dd></div>
    </dl>
    <div className="ak-key-actions">
      <ActionButton variant="quiet" disabled={busy} aria-expanded={editing} onClick={()=>{setDraft(values());setEditing(!editing);setDeleting(false);}}>{editing?'收起':'编辑'}</ActionButton>
      {deleting?<><ActionButton className="ak-danger" disabled={busy} onClick={()=>post({action:'delete',id:item.id})}>确认删除</ActionButton><ActionButton variant="quiet" onClick={()=>setDeleting(false)}>取消</ActionButton></>
        :<ActionButton variant="quiet" aria-label={'删除 '+item.name} disabled={busy} onClick={()=>{setDeleting(true);setEditing(false);}}><Icon name="trash"/></ActionButton>}
    </div>
    {editing&&<form className="ak-edit" onSubmit={save} aria-label={'编辑 '+item.name}>
      <label className="ak-field ak-field-wide">名称<input required maxLength={80} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
      {QUOTAS.map(([key,title,unit,min,max,help])=><label className="ak-field" key={key}>{title}<NumberField label={item.name+' '+title} min={min} max={max} unit={unit} value={draft[key]} onChange={value=>setDraft({...draft,[key]:value})}/><small>{help}</small></label>)}
      <div className="ak-edit-foot"><small>创建于 {time(item.createdAt)} · 保存后用于之后的请求，已有请求继续完成</small><ActionButton variant="primary" type="submit" disabled={busy||!changed}>保存</ActionButton></div>
    </form>}
  </li>;
}

function KeysTab({keys,base,post,busy,setError}){
  const [creating,setCreating]=useState(false),[draft,setDraft]=useState({name:'',maxConcurrent:1,requestsPerMinute:60,maxQueued:8}),[secret,setSecret]=useState('');
  const [copied,copy]=useCopy(setError),list=keys?.keys??[];
  async function create(e){
    e.preventDefault();const result=await post({action:'create',name:draft.name,...quotaPayload(draft)});
    if(result.ok&&result.secret){setSecret(result.secret);setCreating(false);setDraft({...draft,name:''});}
  }
  const config=base?`Base URL: ${base}\nAPI Key: ${secret}\n`:`API Key: ${secret}\n`;
  return <div className="ak-panel">
    {secret&&<section className="ak-reveal" role="status" aria-label="新密钥">
      <div><h3>密钥已创建</h3><p>完整密钥只显示这一次，复制后交给使用者；关闭后只留摘要。</p></div>
      <textarea readOnly aria-label="完整 API 密钥" rows={2} value={secret}/>
      <div className="ak-actions"><ActionButton variant="primary" icon="copy" onClick={()=>copy(secret,'密钥')}>{copied==='密钥'?'已复制':'复制密钥'}</ActionButton><ActionButton icon="copy" onClick={()=>copy(config,'配置')}>{copied==='配置'?'已复制':'复制接入配置'}</ActionButton><ActionButton variant="quiet" onClick={()=>setSecret('')}>关闭</ActionButton></div>
    </section>}
    <div className="ak-toolbar"><h2>访问密钥<span className="ak-count">{list.length}</span></h2>
      <ActionButton variant={creating?'quiet':'primary'} icon={creating?'close':'plus'} disabled={!keys} onClick={()=>setCreating(!creating)}>{creating?'取消':'新建密钥'}</ActionButton></div>
    {creating&&<form className="ak-create" onSubmit={create}>
      <label className="ak-field ak-field-wide">密钥名称<input required autoFocus maxLength={80} placeholder="例如：设计团队、小王" value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
      {QUOTAS.map(([key,title,unit,min,max,help])=><label className="ak-field" key={key}>{title}<NumberField label={'新密钥'+title} min={min} max={max} unit={unit} value={draft[key]} onChange={value=>setDraft({...draft,[key]:value})}/><small>{help}</small></label>)}
      <div className="ak-edit-foot"><small>每把密钥独立计额度，同时受「全局额度」限制。</small><ActionButton variant="primary" type="submit" icon="plus" disabled={busy}>{busy?'创建中…':'创建'}</ActionButton></div>
    </form>}
    {!keys?<div className="empty">正在读取密钥…</div>:!list.length?<div className="empty">还没有密钥。新建一把，分发给 API 使用者。</div>
      :<ul className="ak-keys">{list.map(item=><KeyItem key={item.id} item={item} post={post} busy={busy}/>)}</ul>}
    <p className="note">停用可随时恢复，删除后立即失效。额度在请求放行时计数；模型目录查询、上传和下载只计请求频率，不占执行并发。</p>
  </div>;
}

function QuotaTab({keys,post,busy}){
  const [limits,setLimits]=useState(null),settings=keys?.settings;
  useEffect(()=>{if(settings)setLimits({...settings});},[settings?.maxConcurrent,settings?.requestsPerMinute,settings?.maxQueued,settings?.queueWaitSeconds]);
  if(!limits)return <div className="empty">正在读取…</div>;
  const rows=[['maxConcurrent','执行并发上限','所有密钥共享的同时执行数','路',1,32],['requestsPerMinute','每分钟请求上限','所有密钥共享的请求频率','RPM',1,60000],['maxQueued','总等待名额','所有密钥共享的排队容量','个',0,256],['queueWaitSeconds','最长入口等待','请求在队列里最多等多久','秒',1,900]];
  const changed=rows.some(([k])=>Number(limits[k])!==settings[k]);
  return <form className="ak-panel ak-quota" onSubmit={e=>{e.preventDefault();post({action:'settings',...Object.fromEntries(rows.map(([k])=>[k,Number(limits[k])]))});}}>
    <div className="ak-toolbar"><h2>全局额度</h2><span className="muted tiny">统一限制所有密钥的总量</span></div>
    <ul className="ak-quota-list">{rows.map(([key,title,help,unit,min,max])=><li key={key}><div><strong>{title}</strong><small>{help}</small></div><NumberField label={title} min={min} max={max} unit={unit} value={limits[key]} disabled={busy} onChange={value=>setLimits({...limits,[key]:value})}/></li>)}</ul>
    <div className="ak-edit-foot"><small>本机的可信调用（不带密钥）不受额度限制。</small><ActionButton variant="primary" type="submit" disabled={busy||!changed}>保存</ActionButton></div>
  </form>;
}

export default function AccessKeyManager(){
  const keys=useManaged('/api/access-keys',3000),pub=useManaged('/api/public',5000);
  const [tab,setTab]=useState('keys'),[localError,setLocalError]=useState('');
  const k=keys.data,p=pub.data,error=localError||keys.error||pub.error;
  const enabled=k?.keys.filter(key=>key.enabled).length,exposed=p?.routes.filter(r=>r.exposed).length,[tone,tunnelText]=TUNNEL[p?.tunnel.state??'unknown'];
  const tabs=[['keys','密钥',k?.keys.length],['public','公网放行',p?exposed+'/'+p.routes.length:null],['quota','全局额度',null]];
  return <div className="ak stage-enter">
    {error&&<div className="error-banner" role="alert">{error}</div>}
    <section className="ak-status" aria-label="概况">
      <div><span>公网</span><strong className={'ak-tone is-'+(p?.master===false?'off':tone)}><i/>{p?(p.master?tunnelText:'已关闭'):'—'}</strong><small>{p?(p.master?exposed+' / '+p.routes.length+' 个接口放行':'所有公网请求被拒绝'):'读取中'}</small></div>
      <div><span>密钥</span><strong>{enabled??'—'}<em> / {k?.keys.length??'—'}</em></strong><small>已启用 / 全部</small></div>
      <div><span>执行与排队</span><strong>{k?.active??'—'}<em> / {k?.settings.maxConcurrent??'—'} 路</em></strong><small>排队 {k?.queued??'—'} / {k?.settings.maxQueued??'—'}</small></div>
      <div><span>公网请求</span><strong>{p?.stats.served??'—'}<em> 次放行</em></strong><small>{p?(p.stats.denied+p.stats.blocked)+' 次被拒 · 自网关启动':'读取中'}</small></div>
    </section>
    <div className="ak-tabs" role="tablist" aria-label="访问管理">{tabs.map(([id,name,count])=><button key={id} role="tab" aria-selected={tab===id} onClick={()=>setTab(id)}>{name}{count!=null&&<span>{count}</span>}</button>)}</div>
    {tab==='keys'&&<KeysTab keys={k} base={p?.base} post={keys.post} busy={keys.busy} setError={setLocalError}/>}
    {tab==='public'&&<PublicExposure data={p} post={pub.post} busy={pub.busy} setError={setLocalError}/>}
    {tab==='quota'&&<QuotaTab keys={k} post={keys.post} busy={keys.busy}/>}
  </div>;
}
