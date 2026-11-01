// Client for the shared native ComfyUI runtime. Engine packages that run graphs on it (H3, Anima)
// submit native /prompt graphs, follow /history and fetch outputs through these helpers.
import {createHash,randomUUID} from 'node:crypto';
import {readFile,readlink,mkdir,rename,open} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {call,pause,ARTIFACTS,beforeSubmission} from '../../../platforms/workbench/lib/engine-sdk.mjs';
export {beforeSubmission};
const WORKFLOWS=new URL('./workflows/',import.meta.url);
const id=()=>randomUUID().replaceAll('-','');

export async function idle(ctx){const q=await call(ctx.base,'/queue');return q.queue_running.length===0&&q.queue_pending.length===0;}
export async function ready(ctx){await call(ctx.base,'/system_stats');return true;}

// A cataloged API graph, the same file the canvas template was built from.
export async function workflowGraph(workflowId){
  const catalog=JSON.parse(await readFile(new URL('catalog.json',WORKFLOWS),'utf8')).workflows;
  const entry=catalog.find(row=>row.id===workflowId);if(!entry)throw new Error('Unknown ComfyUI workflow: '+workflowId);
  return JSON.parse(await readFile(new URL(entry.api,WORKFLOWS),'utf8'));
}

// Content-addressed reference names let ComfyUI reuse a cached LoadImage across prompts.
const contentId=raw=>createHash('sha256').update(raw).digest('hex').slice(0,32);
export async function uploadFile(base,raw,extension,contentType){
  const form=new FormData();form.append('image',new Blob([raw],{type:contentType}),'reference-'+contentId(raw)+'.'+extension);
  const r=await fetch(base+'/upload/image',{method:'POST',body:form,signal:AbortSignal.timeout(60000)});if(!r.ok)throw new Error('Reference upload failed');
  const result=await r.json();return [result.subfolder,result.name].filter(Boolean).join('/');
}

// A native history entry with status "error" is a confirmed failure, not an uncertain outcome.
export function comfyFailure(entry){
  if(entry?.status?.messages?.some(([type])=>type==='execution_interrupted'))return Object.assign(new Error('Interrupted in ComfyUI'),{code:'BACKEND_CANCELLED'});
  const error=entry?.status?.messages?.find(([type])=>type==='execution_error')?.[1];
  const failure=new Error(error?`${error.node_type} (node ${error.node_id}): ${String(error.exception_message??'').split('\n')[0]}`.slice(0,300):'ComfyUI reported a failed workflow');
  failure.code='BACKEND_FAILED';return failure;
}
// Targeted: a queued copy is removed and only this prompt is interrupted, never canvas work.
export async function interruptPrompt(base,promptId,request=call){
  await request(base,'/queue',{delete:[promptId]});
  await request(base,'/interrupt',{prompt_id:promptId});
}
export const interrupt=backend=>interruptPrompt(backend.base,backend.prompt_id);
// An HTTP answer from /prompt is final (rejected graphs are never queued); a lost answer is not.
export async function submitPrompt(request,base,graph){
  let submission;
  try{submission=await request(base,'/prompt',{prompt:graph});}
  catch(e){
    if(e.status){const detail=e.data?.error?.message??e.message;e.message=`ComfyUI rejected the workflow: ${detail}`.slice(0,300);e.code='BACKEND_FAILED';}
    throw e;
  }
  if(!submission?.prompt_id)throw Object.assign(new Error('ComfyUI returned no prompt_id'),{code:'BACKEND_FAILED'});
  return submission.prompt_id;
}
// Submit, report the prompt_id, then wait for the history entry; a failed entry throws.
export async function runPrompt(base,graph,{onSubmitted,request=call,wait=pause,label='ComfyUI workflow'}={}){
  const pid=await submitPrompt(request,base,graph);
  await onSubmitted?.({base,prompt_id:pid});
  let entry;for(let i=0;i<1800;i++){entry=(await request(base,'/history/'+encodeURIComponent(pid)))[pid];if(entry)break;await wait(1000);}
  if(!entry)throw Error(label+' exceeded 30 minutes; inspect native history');
  if(entry.status?.status_str==='error')throw comfyFailure(entry);
  if(entry.status?.status_str!=='success')throw Error(label+' failed');
  return {prompt_id:pid,entry};
}

// Generated outputs only by default: LoadVideo also emits preview records of type "temp".
export const outputFiles=(entry,extension,types=['output'])=>Object.values(entry.outputs??{}).flatMap(output=>Object.values(output).filter(Array.isArray).flat()).filter(row=>types.includes(row?.type)&&row?.filename?.endsWith(extension));
export const videoOutputFiles=entry=>outputFiles(entry,'.mp4');
async function view(base,row,timeout){
  const params=new URLSearchParams();for(const k of ['filename','subfolder','type'])if(row[k]!==undefined)params.set(k,row[k]);
  const r=await fetch(base+'/view?'+params,{signal:AbortSignal.timeout(timeout)});if(!r.ok)throw new Error('ComfyUI output download failed');
  return r;
}
// Graphs that end in PreviewImage leave no persistent copy in ComfyUI's output directory.
export async function imageOutput(base,entry){
  const files=outputFiles(entry,'.png',['output','temp']);if(!files.length)throw Object.assign(new Error('Image backend returned no PNG'),{code:'BACKEND_FAILED'});
  return Buffer.from(await (await view(base,files[0],60000)).arrayBuffer());
}
// workspace/outputs/* are links to external storage; a link whose target was removed is recreated
// as its target directory instead of failing the save after the video was already generated.
async function linkTarget(directory){
  const path=directory.replace(/\/$/,'');
  try{return resolve(dirname(path),await readlink(path));}catch{return directory;}
}
export async function saveVideoOutput(base,entry,outputDirectory){
  if(entry.status?.status_str!=='success')throw new Error('Video generation failed');
  const files=videoOutputFiles(entry);if(!files.length)throw Object.assign(new Error('Video backend returned no MP4'),{code:'BACKEND_FAILED'});
  const r=await view(base,files[0],90000);
  const directory=outputDirectory??ARTIFACTS;await mkdir(await linkTarget(directory),{recursive:true});
  const name=outputDirectory?'output.mp4':id()+'.mp4',file=directory.replace(/\/?$/,'/')+name;
  // Stream large videos to disk instead of retaining a second full copy in memory.
  await pipeline(r.body,createWriteStream(file+'.tmp',{mode:0o600}));
  const fd=await open(file+'.tmp','r');try{await fd.sync();}finally{await fd.close();}await rename(file+'.tmp',file);
  return outputDirectory?{local_path:file}:{url:'/artifacts/'+name};
}
// After a gateway restart: the prompt_id recorded at submission says what ComfyUI did.
// `save(base,entry)` turns a successful history entry into the job result.
export async function recoverPrompt(job,{finish,change,backendIdle},save){
  if(!job.backend?.prompt_id)return false;
  let entry;
  for(let i=0;i<1800;i++){
    try{entry=(await call(job.backend.base,'/history/'+job.backend.prompt_id))[job.backend.prompt_id];}catch{}
    if(entry||await backendIdle(job.engine))break;await pause(1000);
  }
  if(entry?.status?.status_str==='success'){
    try{await finish(job,{...await save(job.backend.base,entry),metrics:{prompt_id:job.backend.prompt_id,recovered:true}});return true;}catch{return false;}
  }
  if(!entry)return false;
  const failure=entry.status?.status_str==='error'?comfyFailure(entry):null;
  if(failure?.code==='BACKEND_CANCELLED')await change(job,'cancelled',{error:{code:'CANCELLED',message:failure.message}});
  else await change(job,'failed',{error:{code:'BACKEND_FAILED',message:failure?.message??'Backend reported a failed recovered job'}});
  return true;
}
