'use client';
import {useEffect,useState} from 'react';
import {fmt} from '../lib/panel.mjs';
const STEM={vocals:'人声',instrumental:'伴奏',transcript:'转写'};
export const artifactUrl=a=>'/api/mcp/artifacts/'+a.artifact_id;
function Transcript({artifact}){
  const [value,setValue]=useState(null),[error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();
    fetch(artifactUrl(artifact),{signal:controller.signal}).then(r=>{if(!r.ok)throw Error('读取失败');return r.json();}).then(setValue).catch(e=>{if(e.name!=='AbortError')setError(e.message);});
    return()=>controller.abort();},[artifact.artifact_id]);
  if(error)return <p className="bad">{error}</p>;
  if(!value)return <p className="muted">正在读取转写…</p>;
  return <div className="artifact-transcript"><p>{value.text}</p>{value.segments?.length>0&&<ol>{value.segments.map((s,i)=><li key={i}><time>{s.start?.toFixed?.(1)}s</time>{s.text}</li>)}</ol>}</div>;
}
function facts(a){
  const m=a.media??{};
  return [m.width&&m.height?m.width+'×'+m.height:null,m.duration_seconds?fmt(m.duration_seconds)+' 秒':null,m.fps?m.fps+' fps':null,a.bytes?fmt(a.bytes/2**20)+' MB':null].filter(Boolean).join(' · ');
}
// One artifact at full size: images show a 640px preview that opens the original.
export function ArtifactView({artifact}){
  const url=artifactUrl(artifact),label=STEM[artifact.name]??artifact.name;
  const body=artifact.kind==='image'?<a href={url} target="_blank" rel="noreferrer" title="打开原图"><img src={url+'?thumb=640'} alt={label??'生成作品'}/></a>
    :artifact.kind==='video'?<video src={url} controls preload="metadata" playsInline/>
    :artifact.kind==='audio'?<audio src={url} controls preload="metadata"/>
    :artifact.mime_type==='application/json'?<Transcript artifact={artifact}/>
    :null;
  return <figure className={'artifact-view artifact-'+artifact.kind}>{body}
    <figcaption><span>{label??{image:'图像',video:'视频',audio:'音频',text:'文本'}[artifact.kind]}{facts(artifact)&&<small> · {facts(artifact)}</small>}</span><a href={url} download>下载</a></figcaption>
    {artifact.local_path&&<p className="artifact-path" title={artifact.local_path}>{artifact.local_path}</p>}
  </figure>;
}
