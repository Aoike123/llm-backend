// The original H3 graph presets behind the synchronous /v1/videos/generations API.
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {uploadFile,runPrompt,saveVideoOutput,beforeSubmission} from '../../../shared/comfyui/client.mjs';
import {decodeReference,h3ReferenceOptions,prepareH3Videos} from './references.mjs';
const id=()=>randomUUID().replaceAll('-','');
const upload=(base,encoded)=>uploadFile(base,decodeReference(encoded),'png','image/png');
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
  const graph=JSON.parse(await readFile(new URL('../graphs/'+preset+'.api.json',import.meta.url),'utf8'));
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
export async function video(base,body,{preparedVideos,onSubmitted,outputDirectory}={}) {
  validateVideoRequest('h3',body);
  const started=performance.now();
  const h3=await beforeSubmission(()=>buildH3Graph(body,{preparedVideos,uploadImage:encoded=>upload(base,encoded),uploadVideo:bytes=>uploadFile(base,bytes,'mp4','video/mp4')}));
  const {prompt_id,entry}=await runPrompt(base,h3.graph,{onSubmitted,label:'Video job'});
  const saved=await saveVideoOutput(base,entry,outputDirectory);
  return {created:Math.floor(Date.now()/1000),model:'h3',data:[saved],metrics:{generation_seconds:(performance.now()-started)/1000,prompt_id,preset:h3.preset,references:h3.reference_metrics,reference_mode:h3.reference?'multimodal':body.last_frame_b64?'first-last':body.first_frame_b64?'first-frame':'text'}};
}
