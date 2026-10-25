import {randomUUID,createHash} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {ROOT,call} from './backend.mjs';
import {TOPOLOGY} from './runtime-topology.mjs';
import {pause} from './core.mjs';
import {decodeReference,h3ReferenceOptions,prepareH3Videos,H3_REFERENCE_LIMITS} from './h3-references.mjs';
export {H3_REFERENCE_LIMITS};
export const ARTIFACTS=ROOT+'workspace/outputs/api/';
const id=()=>randomUUID().replaceAll('-','');
// Content-addressed reference names let ComfyUI reuse a cached LoadImage across prompts.
const contentId=raw=>createHash('sha256').update(raw).digest('hex').slice(0,32);
export async function upload(base,encoded) {
  return uploadFile(base,decodeReference(encoded),'png','image/png');
}
export async function uploadFile(base,raw,extension,contentType) {
  const form=new FormData();form.append('image',new Blob([raw],{type:contentType}),'reference-'+contentId(raw)+'.'+extension);
  const r=await fetch(base+'/upload/image',{method:'POST',body:form,signal:AbortSignal.timeout(60000)});if(!r.ok)throw new Error('Reference upload failed');
  const result=await r.json();return [result.subfolder,result.name].filter(Boolean).join('/');
}
export function validateVideoRequest(model,body) {
  if('images_b64' in body)throw new Error('Use reference_images_b64 for H3 reference generation or first_frame_b64 for a first frame');
  if(model!=='h3')throw new Error('Unsupported video model; only minimax-h3 is enabled');
  const {reference}=h3ReferenceOptions(body);
  const width=body.width??864,height=body.height??480,frames=body.frames??124;
  if(![width,height,frames].every(Number.isInteger)||width<320||width>1344||height<320||height>1344||width*height>1344*768||width%32||height%32||frames<(reference?96:124)||frames>(reference?362:364)||(!reference&&frames%4))throw new Error('Invalid H3 dimensions or frame count (reference: 96–362 frames, dimensions multiples of 32, area ≤1344×768)');
  for(const key of ['first_frame_b64','last_frame_b64'])if(body[key])decodeReference(body[key]);
  if(body.seed!==undefined&&(!Number.isSafeInteger(body.seed)||body.seed<0))throw new Error('seed must be a nonnegative safe integer');
  if(body.steps!==undefined&&(!reference||!Number.isInteger(body.steps)||body.steps<1||body.steps>50))throw new Error('steps must be 1–50 in reference mode');
  if(body.preset==='reference-turbo4'&&body.steps!==undefined&&body.steps!==4)throw new Error('reference-turbo4 requires 4 steps');
}
export async function buildH3Graph(body,{uploadImage,uploadVideo,preparedVideos}={}) {
  validateVideoRequest('h3',body);
  const {images,videos,reference,preset}=h3ReferenceOptions(body);
  const graph=JSON.parse(await readFile(ROOT+'platforms/comfyui/custom_nodes/pation_h3/'+preset+'.api.json','utf8'));
  Object.assign(graph['5'].inputs,{prompt:body.prompt,width:body.width??864,height:body.height??480,length:body.frames??124});
  graph['12'].inputs.noise_seed=body.seed??771;graph['17'].inputs.filename_prefix='api/h3-'+id();
  if(reference) {
    graph['5'].inputs.ref_image_size=body.reference_image_size??'match';
    graph['8'].inputs.engine=body.engine??'paiton';
    if(body.steps!==undefined)graph['11'].inputs.steps=body.steps;
    for(const [i,image] of images.entries()) {
      const node=String(100+i);graph[node]={class_type:'LoadImage',inputs:{image:await uploadImage(image)}};
      graph['5'].inputs['ref_images.ref_image_'+i]=[node,0];
    }
    preparedVideos??=await prepareH3Videos(body);
    for(const [i,video] of preparedVideos.entries()) {
      const node=String(200+i*2),components=String(201+i*2);
      graph[node]={class_type:'LoadVideo',inputs:{file:await uploadVideo(video.bytes)}};
      graph[components]={class_type:'GetVideoComponents',inputs:{video:[node,0]}};
      graph['5'].inputs['ref_videos.ref_video_'+i]=[components,0];
      if(video.has_audio)graph['5'].inputs['ref_video_audios.ref_video_audio_'+i]=[components,1];
    }
  }else for(const [i,key] of ['first_frame_b64','last_frame_b64'].entries())if(body[key]) {
    graph[String(100+i)]={class_type:'LoadImage',inputs:{image:await uploadImage(body[key])}};
    graph['5'].inputs[key.replace('_b64','')]=[String(100+i),0];
  }
  return {graph,reference,preset,reference_metrics:{images:images.length,videos:videos.length,video_seconds:(preparedVideos??[]).map(v=>v.seconds),effective_video_frames:(preparedVideos??[]).map(v=>v.effective_frames),video_audio:(preparedVideos??[]).map(v=>v.has_audio)}};
}
// A native history entry with status "error" is a confirmed failure, not an uncertain outcome.
export function comfyFailure(entry) {
  const error=entry?.status?.messages?.find(([type])=>type==='execution_error')?.[1];
  const failure=new Error(error?`${error.node_type} (node ${error.node_id}): ${String(error.exception_message??'').split('\n')[0]}`.slice(0,300):'ComfyUI reported a failed workflow');
  failure.code='BACKEND_FAILED';return failure;
}
// Anything that fails before /prompt is sent left no backend work behind.
export async function beforeSubmission(work) {
  try {return await work();} catch(e) {e.code='NOT_SUBMITTED';throw e;}
}
// An HTTP answer from /prompt is final (rejected graphs are never queued); a lost answer is not.
export async function submitPrompt(request,base,graph) {
  let submission;
  try {submission=await request(base,'/prompt',{prompt:graph});}
  catch(e) {
    if(e.status){const detail=e.data?.error?.message??e.message;e.message=`ComfyUI rejected the workflow: ${detail}`.slice(0,300);e.code='BACKEND_FAILED';}
    throw e;
  }
  if(!submission?.prompt_id)throw Object.assign(new Error('ComfyUI returned no prompt_id'),{code:'BACKEND_FAILED'});
  return submission.prompt_id;
}
export function videoOutputFiles(entry) {
  // LoadVideo also emits MP4 preview records. Only generated output is an artifact.
  return Object.values(entry.outputs??{}).flatMap(output=>Object.values(output).filter(Array.isArray).flat()).filter(row=>row?.type==='output'&&row?.filename?.endsWith('.mp4'));
}
export async function video(model,body,{preparedVideos,onSubmitted,outputDirectory}={}) {
  validateVideoRequest(model,body);
  const started=performance.now(),base='http://127.0.0.1:'+TOPOLOGY.runtimes.comfy.port;
  const h3=await beforeSubmission(()=>buildH3Graph(body,{preparedVideos,uploadImage:encoded=>upload(base,encoded),uploadVideo:bytes=>uploadFile(base,bytes,'mp4','video/mp4')})),graph=h3.graph;
  const pid=await submitPrompt(call,base,graph);
  await onSubmitted?.({prompt_id:pid,base});
  let entry;for(let i=0;i<1800;i++){entry=(await call(base,'/history/'+pid))[pid];if(entry)break;await pause(1000);}
  if(!entry)throw new Error('Video job exceeded 30 minutes; lease retained until backend idle');
  if(entry.status?.status_str==='error')throw comfyFailure(entry);
  if(entry.status?.status_str!=='success')throw new Error('Video generation failed');
  const saved=await saveVideoOutput(base,entry,outputDirectory);
  return {created:Math.floor(Date.now()/1000),model,data:[saved],metrics:{generation_seconds:(performance.now()-started)/1000,prompt_id:pid,...(h3?{preset:h3.preset,references:h3.reference_metrics}:{}),reference_mode:h3?.reference?'multimodal':body.last_frame_b64?'first-last':body.first_frame_b64?'first-frame':'text'}};
}

export async function saveVideoOutput(base,entry,outputDirectory){
  if(entry.status?.status_str!=='success')throw new Error('Video generation failed');
  const files=videoOutputFiles(entry);if(!files.length)throw Object.assign(new Error('Video backend returned no MP4'),{code:'BACKEND_FAILED'});
  const params=new URLSearchParams();for(const k of ['filename','subfolder','type'])if(files[0][k]!==undefined)params.set(k,files[0][k]);
  const r=await fetch(base+'/view?'+params,{signal:AbortSignal.timeout(90000)});if(!r.ok)throw new Error('Video download failed');
  const directory=outputDirectory??ARTIFACTS;await mkdir(directory,{recursive:true});
  const name=outputDirectory?'output.mp4':id()+'.mp4',file=directory.replace(/\/?$/,'/')+name;
  // Stream large videos to disk instead of retaining a second full copy in memory.
  const {pipeline}=await import('node:stream/promises');const {createWriteStream}=await import('node:fs');
  await pipeline(r.body,createWriteStream(file+'.tmp',{mode:0o600}));
  const {rename,open}=await import('node:fs/promises');const fd=await open(file+'.tmp','r');try{await fd.sync();}finally{await fd.close();}await rename(file+'.tmp',file);
  return outputDirectory?{local_path:file}:{url:'/artifacts/'+name};
}
