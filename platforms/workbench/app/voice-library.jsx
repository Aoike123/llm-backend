'use client';
import {useState} from 'react';
import {useRead} from './use-read.mjs';
import {ActionButton} from './ui-controls.mjs';
import {engineLabel,fmt} from '../lib/panel.mjs';
// Registered voices grouped by their label. The list is read every 5 s, so voices registered from
// MCP or renamed elsewhere appear without a reload; an edit re-reads at once.
const UNGROUPED='未分组';
async function label(id,change){
  const response=await fetch('/api/mcp/voices/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(change)});
  if(!response.ok)throw Error((await response.json().catch(()=>({}))).error??'保存失败');
}
function CopyId({id}){
  const [done,setDone]=useState(false);
  return <ActionButton variant="quiet" icon={done?'check':'copy'} title="复制后填入 references[].voice_artifact_id" onClick={async()=>{try{await navigator.clipboard.writeText(id);setDone(true);setTimeout(()=>setDone(false),1600);}catch{}}}>{done?'已复制':'复制 ID'}</ActionButton>;
}
function VoiceCard({voice,groups,onSaved}){
  const [editing,setEditing]=useState(false),[name,setName]=useState(voice.name??''),[group,setGroup]=useState(voice.group??''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  function open(){setName(voice.name??'');setGroup(voice.group??'');setError('');setEditing(true);}
  async function save(e){
    e.preventDefault();if(!name.trim())return setError('名称不能为空');setBusy(true);
    try{await label(voice.artifact_id,{name:name.trim(),group:group.trim()});setEditing(false);onSaved();}catch(x){setError(x.message);}finally{setBusy(false);}
  }
  return <article className="voice-card">
    {editing?<form className="voice-edit" onSubmit={save}>
      <label><span>名称</span><input value={name} maxLength={80} autoFocus onChange={e=>setName(e.target.value)}/></label>
      <label><span>分组</span><input value={group} maxLength={80} list="voice-groups" placeholder={UNGROUPED} onChange={e=>setGroup(e.target.value)}/></label>
      <div className="voice-edit-actions"><ActionButton variant="primary" type="submit" disabled={busy}>{busy?'保存中':'保存'}</ActionButton><ActionButton variant="quiet" type="button" onClick={()=>setEditing(false)}>取消</ActionButton></div>
      {error&&<p className="bad" role="alert">{error}</p>}
    </form>:<div className="voice-head"><div><h3>{voice.name??'未命名音色'}</h3><small>{fmt(voice.seconds)} 秒 · {engineLabel(voice.engine)} · {new Date(voice.created_at).toLocaleDateString('zh-CN')}{voice.renamed_at?' · 已改名':''}</small></div><ActionButton variant="quiet" icon="settings" onClick={open}>编辑</ActionButton></div>}
    {voice.transcript&&<p className="voice-transcript">{voice.transcript}</p>}
    {voice.clip_artifact_id&&<audio src={'/api/mcp/artifacts/'+voice.clip_artifact_id} controls preload="none"/>}
    <div className="voice-foot"><code title="voice_artifact_id">{voice.artifact_id}</code><CopyId id={voice.artifact_id}/></div>
  </article>;
}
export default function VoiceLibrary({engine=null}){
  const [revision,setRevision]=useState(0),[filter,setFilter]=useState(null);
  const {value,error}=useRead('/api/mcp/voices?'+new URLSearchParams({...(engine?{engine}:{}),r:revision}),{keep:true});
  if(!value)return <div className="empty">{error||'正在读取音色库…'}</div>;
  const byGroup=new Map();for(const v of value.voices){const g=v.group??UNGROUPED;if(!byGroup.has(g))byGroup.set(g,[]);byGroup.get(g).push(v);}
  const names=[...value.groups,...(byGroup.has(UNGROUPED)?[UNGROUPED]:[])],shown=filter&&byGroup.has(filter)?[filter]:names;
  return <div className="voice-library">
    <datalist id="voice-groups">{value.groups.map(g=><option key={g} value={g}/>)}</datalist>
    <div className="voice-toolbar" role="group" aria-label="音色分组"><button aria-pressed={!filter||!byGroup.has(filter)} onClick={()=>setFilter(null)}>全部<small>{value.total}</small></button>{names.map(g=><button key={g} aria-pressed={filter===g} onClick={()=>setFilter(g)}>{g}<small>{byGroup.get(g).length}</small></button>)}</div>
    {!value.total&&<div className="empty voice-empty">还没有注册音色。用 <code>{value.register_tool??'register_voice'}</code> 传入一段 10–20 秒的干净人声和名称即可注册，之后在合成时用 <code>references[].voice_artifact_id</code> 引用。</div>}
    {shown.map(g=><section className="voice-group" key={g}><h2>{g}<small>{byGroup.get(g).length} 个</small></h2><div className="voice-grid">{byGroup.get(g).map(v=><VoiceCard key={v.artifact_id} voice={v} groups={value.groups} onSaved={()=>setRevision(n=>n+1)}/>)}</div></section>)}
  </div>;
}
