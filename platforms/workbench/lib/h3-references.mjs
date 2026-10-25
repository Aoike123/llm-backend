import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=promisify(execFile);
export const H3_REFERENCE_LIMITS=Object.freeze({images:9,videos:3,files:12,video_seconds:15,total_video_seconds:15});
export function decodeReference(value,type='image') {
  // Internal asset pipeline uses bytes; public JSON clients cannot supply Buffer objects.
  if(Buffer.isBuffer(value)){
    if(!value.length||value.length>128*2**20)throw new Error('Reference file size invalid');
    if(type==='image'&&!value.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Reference images must be PNG');
    return value;
  }
  if(typeof value!=='string'||!value.length||value.length>32*2**20||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw new Error(`Reference ${type} must be nonempty base64 (without data URL prefix)`);
  const raw=Buffer.from(value,'base64');
  if(type==='image'&&!raw.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Reference images must be PNG base64');
  return raw;
}
export function h3ReferenceOptions(body) {
  const images=body.reference_images_b64??[],videos=body.reference_videos_b64??[];
  if(!Array.isArray(images)||!Array.isArray(videos))throw new Error('reference_images_b64 and reference_videos_b64 must be arrays');
  if(images.length>9||videos.length>3||images.length+videos.length>12)throw new Error('H3 supports at most 9 reference images and 3 reference videos (12 files total)');
  const reference=images.length+videos.length>0;
  const preset=body.preset??(reference?'reference':'turbo8');
  if(!['turbo8','turbo4','reference','reference-turbo4'].includes(preset))throw new Error('Choose turbo8, turbo4, reference or reference-turbo4');
  if(reference&&['turbo8','turbo4'].includes(preset))throw new Error('Reference inputs require reference or reference-turbo4 preset');
  if(preset.startsWith('reference')&&!reference)throw new Error('Reference preset requires at least one reference image or video');
  if(reference&&(body.first_frame_b64||body.last_frame_b64))throw new Error('Reference mode cannot be combined with first_frame_b64 or last_frame_b64');
  if(!['match','max'].includes(body.reference_image_size??'match'))throw new Error('reference_image_size must be match or max');
  if(!['stock','paiton'].includes(body.engine??'paiton'))throw new Error('H3 engine must be stock or paiton');
  if(body.reference_video_audio!==undefined&&typeof body.reference_video_audio!=='boolean')throw new Error('reference_video_audio must be boolean');
  for(const value of images)decodeReference(value);
  for(const value of videos)decodeReference(value,'video');
  return {images,videos,reference,preset};
}
// Decode and normalize real video files before acquiring a GPU lease. ffprobe metadata
// is checked against bounded decoding; caller-controlled paths/URLs never reach ffmpeg.
export async function prepareH3Videos(body) {
  const {videos}=h3ReferenceOptions(body);if(!videos.length)return [];
  const directory=await mkdtemp(join(tmpdir(),'h3-reference-'));
  try {
    const result=[];let total=0;
    for(const [index,encoded] of videos.entries()) {
      const source=join(directory,`${index}.input`),target=join(directory,`${index}.mp4`);
      await writeFile(source,decodeReference(encoded,'video'));
      let info;
      try {const {stdout}=await run('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm,avi,mpegts','-show_streams','-show_format','-of','json',source],{timeout:30000,maxBuffer:2**20});info=JSON.parse(stdout);}catch{throw new Error(`Reference video ${index+1} cannot be decoded`);}
      const stream=info.streams?.find(s=>s.codec_type==='video');
      const streamSeconds=Number(stream?.duration);
      const seconds=Number.isFinite(streamSeconds)?streamSeconds:Number(info.format?.duration);
      if(!stream||!Number.isFinite(seconds)||seconds<2||seconds>15.05)throw new Error(`Reference video ${index+1} must contain 2–15 seconds of video`);
      if(stream.width*stream.height>4096*2160)throw new Error('Reference video resolution exceeds 4096×2160 pixel budget');
      total+=seconds;if(total>15.05)throw new Error('Reference videos must total at most 15 seconds');
      const outputFrames=body.frames??124,aligned=outputFrames+((5-outputFrames%17+17)%17);
      if(seconds>aligned/24+1/24)throw new Error(`Reference video ${index+1} is longer than the output; increase frames to at least ${Math.ceil(seconds*24)} to avoid truncation`);
      const [numerator,denominator]=(stream.avg_frame_rate??'0/1').split('/').map(Number);
      const copyVideo=Math.abs(numerator/denominator-24)<0.0001&&Math.max(stream.width,stream.height)<=1344&&Math.min(stream.width,stream.height)<=768&&['h264','hevc','av1','mpeg4'].includes(stream.codec_name);
      const codec=copyVideo?['-c:v','copy']:['-vf',"fps=24,scale=w='if(gte(iw,ih),min(1344,iw),min(768,iw))':h='if(gte(iw,ih),min(768,ih),min(1344,ih))':force_original_aspect_ratio=decrease:force_divisible_by=2",'-frames:v','360','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-threads','2'];
      try {await run('ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm,avi,mpegts','-i',source,'-map','0:v:0',...(body.reference_video_audio?['-map','0:a:0?']:['-an']),'-t','15',...codec,...(body.reference_video_audio?['-c:a','aac','-ar','32000','-ac','2']:[]),'-movflags','+faststart','-y',target],{timeout:120000,maxBuffer:2**20});}catch{throw new Error(`Reference video ${index+1} could not be normalized to 24 fps`);}
      const hasAudio=body.reference_video_audio&&info.streams.some(s=>s.codec_type==='audio');
      result.push({bytes:await readFile(target),seconds,has_audio:!!hasAudio,effective_frames:Math.floor((Math.min(360,Math.round(seconds*24))-5)/17)*17+5});
    }
    return result;
  }finally{await rm(directory,{recursive:true,force:true});}
}
