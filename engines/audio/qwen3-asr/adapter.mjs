// Qwen3-ASR 1.7B on the shared audio.cpp runtime: an imported audio asset in, a transcript out.
// With timestamps (default) the transcript carries a timed track: every word or character with its
// start/end seconds, and sentence-level segments split at pauses. The runtime aligns the text with
// Qwen3 ForcedAligner and cuts long audio at speech pauses with PulseVAD, which needs 16 kHz mono.
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {audioClip} from '../../../platforms/workbench/lib/engine-sdk.mjs';
import {ready,idle,runTask} from '../../shared/audiocpp/client.mjs';
const RATE=16000,PAUSE_SECONDS=0.8;
const round=seconds=>Math.round(seconds*1000)/1000;
const cjk=character=>/[⺀-鿿가-힯＀-￯]/.test(character??'');
const join_=(a,b)=>cjk(a.at(-1))&&cjk(b[0])?a+b:a+' '+b;
export function timedTrack(result){
  const words=(result.words??[]).map(w=>({text:String(w.word),start:round(w.start_sample/RATE),end:round(w.end_sample/RATE)})).filter(w=>w.text.trim());
  const segments=[];
  for(const word of words){
    const last=segments.at(-1);
    if(last&&word.start-last.end<=PAUSE_SECONDS){last.text=join_(last.text,word.text);last.end=word.end;}
    else segments.push({text:word.text,start:word.start,end:word.end});
  }
  return {words,segments,text:segments.map(s=>s.text).join(' ')};
}
export default {
  ready,idle,
  notes:{'audio.transcribe':()=>'Chinese, dialects and ~30 languages, auto-detected; recordings up to 30 minutes; timestamps=true (default) adds a timed track of words and sentences'},
  assets(capability,input,{asset}){return [asset(input.audio_asset_id,'audio')];},
  async payload(capability,input,{asset,outputDirectory}){
    const timestamps=input.timestamps!==false,source=asset(input.audio_asset_id,'audio').file;
    return {audio:timestamps?await audioClip(source,join(outputDirectory,'speech-16k.wav'),{rate:RATE}):source,timestamps};
  },
  async execute(capability,d,{base,outputDirectory}){
    const result=await runTask(base,'qwen3-asr',{audio:d.audio,...(d.timestamps?{return_timestamps:true}:{})});
    const language=result.language??null,file=join(outputDirectory,'transcript.json');
    const track=d.timestamps?timedTrack(result):null;
    const text=track?track.text:String(result.text??'').trim();
    await writeFile(file,JSON.stringify({text,language,timestamps:d.timestamps,...(track?{words:track.words,segments:track.segments}:{})},null,2),{mode:0o600});
    return {artifacts:[{kind:'text',file,mime:'application/json',name:'transcript',media:{characters:[...text].length,language,...(track?{segments:track.segments.length}:{})}}],
      metrics:{text,language,wall_ms:result.timing?.wall_ms??null,...(track?{segments:track.segments.length,first_speech:track.words[0]?.start??null,last_speech:track.words.at(-1)?.end??null}:{})}};
  },
  effective:(capability,input,media)=>({language:media.language,timestamps:input.timestamps!==false}),
};
