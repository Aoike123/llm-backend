'use client';
import {useEffect,useState} from 'react';
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
// One artifact, rendered by what it is. compact drops the path and download row for galleries.
export function ArtifactView({artifact,compact=false}){
  const url=artifactUrl(artifact),label=STEM[artifact.name]??artifact.name;
  const body=artifact.kind==='image'?<img src={url} alt={label??'生成作品'} loading="lazy"/>
    :artifact.kind==='video'?<video src={url} controls preload="metadata"/>
    :artifact.kind==='audio'?<audio src={url} controls preload="metadata"/>
    :artifact.mime_type==='application/json'?<Transcript artifact={artifact}/>
    :<a href={url} download>下载作品</a>;
  return <figure className={'artifact-view artifact-'+artifact.kind}>{label&&<figcaption>{label}</figcaption>}{body}
    {!compact&&<><p className="muted tiny">{artifact.local_path}</p><a href={url} download>下载作品</a></>}</figure>;
}
