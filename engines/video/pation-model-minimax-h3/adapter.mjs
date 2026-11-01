// MiniMax H3 on the native ComfyUI runtime. Durable jobs run the approved Goldfish workflow;
// the synchronous /v1/videos/generations API keeps the original H3 graph presets.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {seed,list,fail,audioClip} from '../../../platforms/workbench/lib/engine-sdk.mjs';
import {idle,ready,interrupt,recoverPrompt,saveVideoOutput} from '../../shared/comfyui/client.mjs';
import {video,validateVideoRequest} from './lib/graph.mjs';
import {prepareH3Videos,H3_REFERENCE_LIMITS} from './lib/references.mjs';
import {GOLDFISH_CONTROLS,validateGoldfishControls,goldfishReferenceSlots} from './lib/goldfish-controls.mjs';
import {GOLDFISH_ID,GOLDFISH_SEED,goldfishFrames,runGoldfish} from './lib/goldfish-workflow.mjs';
const groups=[['images','reference_asset_ids','image'],['videos','reference_video_asset_ids','video'],['audios','reference_audio_asset_ids','audio']];
// H3 hears at most 15 seconds of each reference audio; longer assets are cut, never refused.
const AUDIO_SECONDS=15,heard=a=>a.kind==='audio'?Math.min(a.seconds,AUDIO_SECONDS):a.seconds;
export default {
  idle,ready,
  // A ComfyUI prompt can be interrupted by prompt_id; canvas work is never touched.
  interrupt,
  workflows:[{id:GOLDFISH_ID,name:'H3 视频生成（原版工作流）',tool:'generate_video',execution_runtime:'comfy',reference_images:9,reference_videos:3,reference_audios:3,controls:['参考组与槽位','六层 LoRA 开关与强度','SelfLift 采样','画幅与分辨率','显存优化与预览','音视频输出']}],
  describe:()=>({reference_limits:H3_REFERENCE_LIMITS,reference_presets:['reference','reference-turbo4']}),
  params:{'video.generate':()=>({reference_asset_ids:list(9),reference_video_asset_ids:list(3),reference_audio_asset_ids:list(3),seed:{...seed,default:GOLDFISH_SEED},duration_seconds:{type:'integer',minimum:4,maximum:15,default:10},...GOLDFISH_CONTROLS})},
  notes:{'video.generate':()=>'MiniMax-H3 original ComfyUI workflow. Images 0–9, videos 0–3, audio 0–3, ≤12 reference files; array order maps to workflow slots and an omitted array is disabled. Reference them in the prompt as <Picture N>/<Video N>/<Audio N>. Controls cover reference groups, six LoRA layers, SelfLift sampling, aspect/resolution, VRAM optimizations and output'},
  validate(capability,input){validateGoldfishControls(input);},
  assets(capability,input,{asset}){
    const refs=[];for(const [,key,kind] of groups)for(const id of input[key]??[])refs.push(asset(id,kind));
    const enabled=groups.flatMap(([slots,key])=>goldfishReferenceSlots(input,slots,input[key])).map(({value})=>refs.find(a=>a.asset_id===value));
    if(enabled.length>12)throw fail('Goldfish supports at most 12 reference files');
    if(enabled.some(a=>a.kind==='audio')&&!enabled.some(a=>a.kind!=='audio'))throw fail('Audio references require image or video references');
    for(const kind of ['video','audio'])if(enabled.filter(a=>a.kind===kind).reduce((sum,a)=>sum+heard(a),0)>15.05)throw fail('Reference '+kind+' total exceeds 15 seconds');
    if(enabled.some(a=>a.kind==='video'&&a.seconds>goldfishFrames(input.duration_seconds??10)/24+1/24))throw fail('Reference video is longer than the output');
    return refs;
  },
  // Prompt tags follow slot order; a reference video's own audio takes the next <Audio N>.
  onCreate(job,input,{asset}){
    let audioOrdinal=0;
    const images=goldfishReferenceSlots(input,'images',input.reference_asset_ids).map(({index},ordinal)=>({input_slot:index+1,tag:'<Picture '+(ordinal+1)+'>'}));
    const videos=goldfishReferenceSlots(input,'videos',input.reference_video_asset_ids).map(({value,index},ordinal)=>({input_slot:index+1,tag:'<Video '+(ordinal+1)+'>',...(input.reference_video_audio&&asset(value,'video').has_audio?{audio_tag:'<Audio '+(++audioOrdinal)+'>'}:{})}));
    const audios=goldfishReferenceSlots(input,'audios',input.reference_audio_asset_ids).map(({index})=>({input_slot:index+1,tag:'<Audio '+(++audioOrdinal)+'>'}));
    job.reference_mapping={images,videos,audios};
  },
  async payload(capability,input,{bytes,asset,outputDirectory}){
    const payload={...input,workflow:GOLDFISH_ID};delete payload.model;
    // Reference audio goes to ComfyUI as the 15 s, 32 kHz stereo clip H3 was tuned on.
    const audio=async(id,i)=>readFile(await audioClip(asset(id,'audio').file,join(outputDirectory,'reference-audio-'+i+'.wav'),{seconds:AUDIO_SECONDS,rate:32000,channels:2}));
    for(const [kind,key,type] of groups){const slots=goldfishReferenceSlots(input,kind,input[key]);payload['reference_'+kind+'_b64']=await Promise.all(slots.map(({value},i)=>type==='audio'?audio(value,i):bytes(value,type)));payload['reference_'+kind+'_slots']=slots.map(({index})=>index);}
    return payload;
  },
  async prepare(capability,d){
    if(d.workflow===GOLDFISH_ID)return d.reference_videos_b64.length?prepareH3Videos({...d,preset:'reference',frames:goldfishFrames(d.duration_seconds??10)}):[];
    return prepareH3Videos(d);
  },
  syncValidate(capability,body){validateVideoRequest('h3',body);},
  execute(capability,d,{base,preparedVideos,onSubmitted,outputDirectory}){
    if(d.workflow===GOLDFISH_ID)return runGoldfish(d,{base,onSubmitted,outputDirectory,preparedVideos});
    return video(base,d,{preparedVideos,onSubmitted,outputDirectory});
  },
  effective(capability,input,media,job){
    // Jobs recorded before the Goldfish workflow used the original H3 graph presets.
    if(capability!=='video.generate'){
      const reference=!!((input.reference_image_asset_ids?.length??0)+(input.reference_video_asset_ids?.length??0)),frames=input.frames??124;
      return {width:input.width??864,height:input.height??480,frames,preset:input.preset??(reference?'reference':'turbo8'),effective_frames:reference?frames+((5-frames%17+17)%17):frames,fps:24};
    }
    return {workflow:GOLDFISH_ID,seed:input.seed??GOLDFISH_SEED,reference_mapping:job.reference_mapping,controls:{loras:input.loras??{},sampling:input.sampling??{},optimizations:input.optimizations??{},resolution:input.resolution??{},output:input.output??{}},duration_seconds:input.duration_seconds??10,frames:goldfishFrames(input.duration_seconds??10)};
  },
  // After a gateway restart: the prompt_id recorded at submission says what ComfyUI did.
  recover:(job,ctx)=>recoverPrompt(job,ctx,async(base,entry)=>({data:[await saveVideoOutput(base,entry,ctx.outputDirectory)]})),
};
