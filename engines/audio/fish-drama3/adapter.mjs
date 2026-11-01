// Fish Audio Drama 3 on the shared audio.cpp runtime: text to speech, cloning up to four reference
// voices. Reference i is the voice of <|speaker:i|> in the text; a reference without a transcript
// is transcribed by Qwen3-ASR on the same runtime, under the same GPU lease.
import {join} from 'node:path';
import {id,str,fail,audioClip,saveWav,modelEnabled} from '../../../platforms/workbench/lib/engine-sdk.mjs';
import {ready,idle,runTask} from '../../shared/audiocpp/client.mjs';
const MAX_REFERENCES=4,MAX_SECONDS=30;
const reference={type:'object',additionalProperties:false,required:[],properties:{
  asset_id:{...id,description:'已导入的音频 asset_id（import_media kind=audio）。'},
  artifact_id:{...id,description:'或：本人已完成任务的音频作品，如人声分离的 vocals。'},
  start_seconds:{type:'number',minimum:0,maximum:1800,description:'从第几秒开始截取，默认 0。'},
  duration_seconds:{type:'number',minimum:1,maximum:MAX_SECONDS,description:'截取时长，最长 30 秒，默认取到 30 秒或结尾。'},
  text:{...str(2000),description:'参考片段的逐字文本；省略时自动语音识别（需启用 Qwen3-ASR）。'}}};
// Where a reference's audio lives: an imported asset or an owned audio artifact.
function source(ref,{asset,artifact}){
  if(!!ref.asset_id===!!ref.artifact_id)throw fail('Each reference needs exactly one of asset_id or artifact_id');
  if(ref.asset_id){const a=asset(ref.asset_id,'audio');return {file:a.file,seconds:a.seconds,bytes:a.bytes};}
  const a=artifact(ref.artifact_id);if(a.kind!=='audio')throw fail('Reference artifact '+ref.artifact_id+' is not audio');
  return {file:a.local_path,seconds:a.media?.duration_seconds??null,bytes:a.bytes};
}
export default {
  ready,idle,
  params:{'speech.synthesize':()=>({references:{type:'array',items:reference,maxItems:MAX_REFERENCES,description:'参考音色，最多 4 个；第 i 个是文本中 <|speaker:i|> 的声音，单个参考时无需标签。'},
    temperature:{type:'number',minimum:0,maximum:2,description:'采样温度，默认 1.0；更低更稳定，更高更有表现力。'}})},
  notes:{'speech.synthesize':()=>'inline tags like [laughing], [sighs], [whisper] direct delivery; mark speakers with <|speaker:0|>…<|speaker:3|>; long text is chunked automatically'},
  validate(capability,input){
    const refs=input.references??[];
    if(refs.length>1&&!/<\|speaker:\d+\|>/.test(input.text))throw fail('Several references need <|speaker:N|> tags in text');
    if(refs.some(r=>!r.text)&&!modelEnabled('qwen3-asr'))throw fail('A reference without text needs Qwen3-ASR enabled, or give its transcript');
  },
  assets(capability,input,ctx){
    return (input.references??[]).map((ref,i)=>{
      const s=source(ref,ctx);
      if(s.seconds!=null&&(ref.start_seconds??0)>=s.seconds)throw fail('Reference '+i+' starts after its audio ends ('+s.seconds+' s)');
      return {bytes:s.bytes};
    });
  },
  // Clips are cut on the CPU before the GPU lease; transcription waits for the lease in execute.
  async payload(capability,input,ctx){
    const references=[];
    for(const [i,ref] of (input.references??[]).entries()){
      const s=source(ref,ctx),start=ref.start_seconds??0,seconds=ref.duration_seconds??Math.min(MAX_SECONDS,Math.max(1,(s.seconds??MAX_SECONDS)-start));
      references.push({file:await audioClip(s.file,join(ctx.outputDirectory,'reference-'+i+'.wav'),{start,seconds}),text:ref.text??null,start,seconds,from:ref.asset_id??ref.artifact_id});
    }
    return {text:input.text,seed:input.seed??42,temperature:input.temperature,references};
  },
  async execute(capability,d,{base,outputDirectory}){
    const started=performance.now();
    for(const ref of d.references)if(!ref.text){
      ref.text=String((await runTask(base,'qwen3-asr',{audio:ref.file})).text??'').trim();ref.transcribed=true;
      if(!ref.text)throw fail('No speech was recognized in a reference clip; choose another range');
    }
    const options={...(d.temperature!==undefined?{temperature:String(d.temperature)}:{})};
    const request={text:d.text,seed:d.seed,options};
    if(d.references.length===1){request.voice_ref=d.references[0].file;options.reference_text=d.references[0].text;}
    else if(d.references.length>1)options.references=JSON.stringify(d.references.map(r=>({text:r.text,audio_path:r.file})));
    const result=await runTask(base,'fish-drama3',request);
    if(typeof result.audio!=='string')throw fail('Drama 3 returned no audio');
    const file=join(outputDirectory,'output.wav'),media=await saveWav(file,result.audio),data=result.custom_schema_output?.data??{};
    if(data.reached_limit)console.warn(JSON.stringify({event:'drama3_reached_limit',frames:data.frames}));
    return {artifacts:[{kind:'audio',file,mime:'audio/wav',media:{...media,rtf:result.timing?.rtf??null}}],
      metrics:{rtf:result.timing?.rtf??null,frames:data.frames??null,reached_limit:data.reached_limit??false,generation_seconds:(performance.now()-started)/1000,
        references:d.references.map(r=>({from:r.from,start:r.start,seconds:r.seconds,transcribed:!!r.transcribed,text:r.text}))}};
  },
  effective:(capability,input)=>({speakers:Math.max(1,(input.references??[]).length),references:(input.references??[]).map(r=>({source:r.asset_id??r.artifact_id,start_seconds:r.start_seconds??0,duration_seconds:r.duration_seconds??null,transcript:r.text?'given':'auto'})),temperature:input.temperature??1}),
};
