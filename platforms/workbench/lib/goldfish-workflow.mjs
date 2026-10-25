import {readFile} from 'node:fs/promises';
import {TOPOLOGY} from './runtime-topology.mjs';
import {call} from './backend.mjs';
import {upload,uploadFile,saveVideoOutput,comfyFailure,beforeSubmission,submitPrompt} from './media.mjs';
import {GOLDFISH_LORAS,validateGoldfishControls,goldfishReferenceSlots} from './goldfish-controls.mjs';
import {pause} from './core.mjs';
export const GOLDFISH_ID='yz-h3-ultimate-original';
export const GOLDFISH_SEED=905138662823835;
export const goldfishFrames=seconds=>{const frames=Math.max(5,Math.round(seconds*24));return frames+(5-frames%17+17)%17;};
export async function buildGoldfishGraph(input,{uploadImage,uploadVideo,uploadAudio,preparedVideos=[]}={}){
 if(!input.prompt?.trim())throw Error('Goldfish requires a prompt');
 validateGoldfishControls(input);
 const slots=(kind,values)=>input['reference_'+kind+'_slots']?values.map((value,i)=>({value,index:input['reference_'+kind+'_slots'][i]})):goldfishReferenceSlots(input,kind,values);
 const images=slots('images',input.reference_images_b64??[]),videos=slots('videos',preparedVideos),audios=slots('audios',input.reference_audios_b64??[]);
 if(images.length>9||videos.length>3||audios.length>3||images.length+videos.length+audios.length>12)throw Error('Goldfish reference count exceeds native limits');
 if(audios.length&&!images.length&&!videos.length)throw Error('Audio references require image or video references');
 const graph=JSON.parse(await readFile(new URL('../../comfyui/workflows/api/02-video/yz-h3-ultimate-original.api.json',import.meta.url),'utf8'));
 graph['263'].inputs.text=input.prompt;
 const imageNodes=['51','49','50','43','19','23','199','200','201'];
 for(const key of Object.keys(graph['265'].inputs))if(key.startsWith('ref_images.'))delete graph['265'].inputs[key];
 for(const node of imageNodes)delete graph[node];
 for(const {index,value:bytes} of images){
  const node=imageNodes[index];graph[node]={class_type:'LoadImage',inputs:{image:await uploadImage(bytes)}};
  graph['265'].inputs['ref_images.ref_image_'+index]=[node,0];
 }
 for(const {index,value:video} of videos){
  const node=['25','27','26'][index];
  graph[node]={class_type:'VHS_LoadVideo',inputs:{video:await uploadVideo(video.bytes),force_rate:24,custom_width:0,custom_height:0,frame_load_cap:0,skip_first_frames:0,select_every_nth:1,format:'H3'}};
  graph['265'].inputs['ref_videos.ref_video_'+index]=[node,0];
  if(input.reference_video_audio&&video.has_audio)graph['265'].inputs['ref_video_audios.ref_video_audio_'+index]=[node,2];
 }
 for(const {index,value:bytes} of audios){
  const node=['14','48','15'][index];graph[node]={class_type:'LoadAudio',inputs:{audio:await uploadAudio(bytes)}};
  graph['265'].inputs['ref_audios.ref_audio_'+index]=[node,0];
 }
 if(input.reference_image_size!==undefined)graph['265'].inputs.ref_image_size=input.reference_image_size;
 graph['397'].inputs.seed=input.seed??GOLDFISH_SEED;
 graph['259'].inputs.value=input.duration_seconds??10;
 Object.assign(graph['252'].inputs,input.resolution??{});
 const sampling=input.sampling??{};
 for(const [key,value] of Object.entries(sampling))if(key==='steps')graph['261'].inputs.steps=value;else graph['397'].inputs[key]=value;
 // Rebuild the original model chain; bypassed nodes are absent, all consumers follow the live chain.
 let model=['192',0];
 const chain=(id,type,values,enabled=true)=>{
  if(enabled){graph[id]={class_type:type,inputs:{...values,model}};model=[id,0];}else delete graph[id];
 };
 for(const [key,id,file,enabled,strength] of GOLDFISH_LORAS){const options=input.loras?.[key]??{};chain(id,'LoraLoaderModelOnly',{lora_name:file,strength_model:options.strength??strength},options.enabled??enabled);}
 const o=input.optimizations??{};
 chain('331','ModelAttentionBackend',{...graph['331'].inputs},o.attention_enabled??true);
 // Spreading original inputs includes the previous model link; chain overwrites it.
 chain('332','BlockSparseAttention',{...graph['332'].inputs,...(o.sparse_tau===undefined?{}:{'selection.tau':o.sparse_tau}),...(o.sparse_start===undefined?{}:{start_percent:o.sparse_start}),...(o.sparse_end===undefined?{}:{end_percent:o.sparse_end})},o.sparse_enabled??true);
 chain('333','MiniMaxH3SigmaShift',{...graph['333'].inputs,...(o.shift_video===undefined?{}:{shift_video:o.shift_video}),...(o.shift_audio===undefined?{}:{shift_audio:o.shift_audio})},o.sigma_shift_enabled??true);
 chain('401','MiniMaxChunkFeedForward',{chunks:o.chunks??2,seq_threshold:o.seq_threshold??4096},o.feed_forward_enabled??true);
 chain('403','MiniMaxLowVRAMAttention',{head_chunks:o.head_chunks??4},o.low_vram_enabled??true);
 chain('329','ModelPreviewOverrideKJ',{...graph['329'].inputs},o.preview_enabled??true);
 graph['397'].inputs.model=model;graph['261'].inputs.model=model;
 const output={...input.output};delete output.include_audio;Object.assign(graph['364'].inputs,output);
 if(input.output?.include_audio===false){delete graph['254'];delete graph['364'].inputs.audio;}
 return graph;
}
// The workflow is submitted unchanged to native /prompt; no API bridge nodes.
export async function runGoldfish(input,{onSubmitted,outputDirectory,request=call,uploadImage,uploadVideo,uploadAudio,preparedVideos,saveOutput=saveVideoOutput,wait=pause}={}){
 const base='http://127.0.0.1:'+TOPOLOGY.runtimes.comfy.port,started=performance.now();
 const graph=await beforeSubmission(()=>buildGoldfishGraph(input,{uploadImage:uploadImage??(bytes=>upload(base,bytes)),uploadVideo:uploadVideo??(bytes=>uploadFile(base,bytes,'mp4','video/mp4')),uploadAudio:uploadAudio??(bytes=>uploadFile(base,bytes,'wav','audio/wav')),preparedVideos}));
 const pid=await submitPrompt(request,base,graph);
 await onSubmitted?.({base,prompt_id:pid});
 let entry;for(let i=0;i<1800;i++){entry=(await request(base,'/history/'+encodeURIComponent(pid)))[pid];if(entry)break;await wait(1000);}
 if(!entry)throw Error('Goldfish workflow exceeded 30 minutes; inspect native history');
 if(entry.status?.status_str==='error')throw comfyFailure(entry);
 if(entry.status?.status_str!=='success')throw Error('Goldfish native workflow failed');
 const saved=await saveOutput(base,entry,outputDirectory);
 return {data:[saved],metrics:{prompt_id:pid,workflow:GOLDFISH_ID,generation_seconds:(performance.now()-started)/1000}};
}
