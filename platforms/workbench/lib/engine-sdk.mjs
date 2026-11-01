import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {open,rename,writeFile,chmod} from 'node:fs/promises';
import {registry} from './registry.mjs';
// What engine adapters may use from the gateway. Adapters import only this module, so the
// gateway can change its internals without touching engine packages.
export {call,ROOT} from './backend.mjs';
export {pause} from './core.mjs';
export {fail} from './media-store.mjs';

export {str,id,seed,list,choice,object,prompt,PROMPT_MAX_LENGTH,validateSchema} from './media-tools.mjs';

// A single-request backend that answered with an HTTP error has finished; only a lost answer is uncertain.
export const answered=async request=>{try{return await request();}catch(e){if(e.status)e.code='BACKEND_FAILED';throw e;}};
export {beforeSubmission} from './media.mjs';

const run=promisify(execFile);
// Whether another model is enabled right now, for adapters that can use it as a helper step.
export const modelEnabled=id=>!!registry.model(id);
// A PCM WAV of [start, start+seconds) of any audio or video file; mono 44.1 kHz unless asked.
export async function audioClip(source,target,{start=0,seconds,rate=44100,channels=1}={}){
  await run('ffmpeg',['-nostdin','-v','error','-ss',String(start),'-i',source,...(seconds?['-t',String(seconds)]:[]),'-map','0:a:0','-ac',String(channels),'-ar',String(rate),'-c:a','pcm_s16le','-y',target],{timeout:180000,maxBuffer:2**20});
  return target;
}
// Write a base64 WAV durably and read its duration from the header.
export async function saveWav(file,encoded){
  const bytes=Buffer.from(encoded,'base64');
  if(bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw Object.assign(new Error('Backend returned invalid WAV audio'),{code:'ARTIFACT_INVALID'});
  let offset=12,format=null,data=0;
  while(offset+8<=bytes.length){const id=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4);if(id==='fmt ')format={channels:bytes.readUInt16LE(offset+10),rate:bytes.readUInt32LE(offset+12),byteRate:bytes.readUInt32LE(offset+16)};if(id==='data'){data=Math.min(size,bytes.length-offset-8);break;}offset+=8+size+(size%2);}
  if(!format||!data)throw Object.assign(new Error('Backend returned WAV without audio data'),{code:'ARTIFACT_INVALID'});
  const tmp=file+'.tmp';await writeFile(tmp,bytes);await chmod(tmp,0o600);const fd=await open(tmp,'r');try{await fd.sync();}finally{await fd.close();}await rename(tmp,file);
  return {duration_seconds:Math.round(data/format.byteRate*100)/100,sample_rate:format.rate,channels:format.channels};
}
