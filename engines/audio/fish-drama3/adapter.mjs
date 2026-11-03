// Fish Audio Drama 3 on the shared audio.cpp runtime: text to speech, cloning up to four reference
// voices. Reference i is the voice of <|speaker:i|> in the text; a reference without a transcript
// is transcribed by Qwen3-ASR on the same runtime, under the same GPU lease.
// A voice is registered once (task=voice), or kept from any synthesis that clones a clip: its
// acoustic tokens are saved as a voice artifact, and a later job that names it reuses the exact
// tokens, so the voice no longer depends on re-cutting, re-transcribing or re-encoding audio.
// Each take is kept the same way for continuation.
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {id,str,list,fail,audioClip,saveWav,modelEnabled} from '../../../platforms/workbench/lib/engine-sdk.mjs';
import {ready,idle,runTask} from '../../shared/audiocpp/client.mjs';
const MAX_REFERENCES=4,MAX_SECONDS=30,MAX_TAKES=4,FRAMES_PER_SECOND=21.5;
const reference={type:'object',additionalProperties:false,required:[],properties:{
  asset_id:{...id,description:'已导入的音频 asset_id（import_media kind=audio）。'},
  artifact_id:{...id,description:'或：本人已完成任务的音频作品，如人声分离的 vocals。'},
  voice_artifact_id:{...id,description:'或：之前语音任务产出的 voice-N 音色作品（或 take 作品），直接复用其声学 token，音色最稳定；不可再带 start/duration/text。'},
  start_seconds:{type:'number',minimum:0,maximum:1800,description:'从第几秒开始截取，默认 0。'},
  duration_seconds:{type:'number',minimum:1,maximum:MAX_SECONDS,description:'截取时长，最长 30 秒，默认取到 30 秒或结尾。'},
  text:{...str(2000),description:'参考片段的逐字文本；省略时自动语音识别（需启用 Qwen3-ASR）。'}}};
const SOURCES=['asset_id','artifact_id','voice_artifact_id'];
// Where a reference's audio lives: an imported asset or an owned audio artifact.
function source(ref,{asset,artifact}){
  if(ref.asset_id){const a=asset(ref.asset_id,'audio');return {file:a.file,seconds:a.seconds,bytes:a.bytes};}
  const a=artifact(ref.artifact_id);if(a.kind!=='audio')throw fail('Reference artifact '+ref.artifact_id+' is not audio');
  return {file:a.local_path,seconds:a.media?.duration_seconds??null,bytes:a.bytes};
}
// A voice or take artifact written by this adapter: the JSON file holding its acoustic tokens.
function tokens(artifactId,{artifact}){
  const a=artifact(artifactId);
  if(a.kind!=='text'||!/^drama3_(reference|take)_v1$/.test(a.media?.schema??''))throw fail('Artifact '+artifactId+' is not a Drama 3 voice or take');
  return {file:a.local_path,bytes:a.bytes};
}
async function loadTokens(file){
  const t=JSON.parse(await readFile(file,'utf8'));
  if(!Array.isArray(t.vq_codes)||typeof t.text!=='string')throw fail('Invalid Drama 3 token file');
  return {text:t.text,vq_codes:t.vq_codes};
}
// The runtime returns token artifacts as base64 JSON {text, vq_codes}.
function decoded(result,schema){
  const a=(result.artifacts??[]).find(x=>x.meta?.schema===schema);if(!a)return null;
  const t=JSON.parse(Buffer.from(a.payload,'base64').toString('utf8'));
  if(!Array.isArray(t.vq_codes))throw fail('Drama 3 returned invalid '+schema+' tokens');
  return t;
}
const frames=t=>t.vq_codes[0]?.length??0;
async function saveTokens(file,schema,t,extra={}){
  const media={schema,frames:frames(t),seconds:Math.round(frames(t)/FRAMES_PER_SECOND*100)/100,...extra};
  await writeFile(file,JSON.stringify({schema,text:t.text,vq_codes:t.vq_codes}),{mode:0o600});
  return {kind:'text',file,mime:'application/json',media};
}
// Transcribe a clip if needed, then encode it into Drama 3 reference tokens; runs under the GPU lease.
async function encodeVoice(base,ref){
  if(!ref.text){
    ref.text=String((await runTask(base,'qwen3-asr',{audio:ref.file})).text??'').trim();ref.transcribed=true;
    if(!ref.text)throw fail('No speech was recognized in a reference clip; choose another range');
  }
  const encoded=decoded(await runTask(base,'fish-drama3',{text:'',voice_ref:ref.file,options:{encode_reference_only:'true',reference_text:ref.text}}),'drama3_reference_v1');
  if(!encoded)throw fail('Drama 3 returned no reference tokens');
  return {text:ref.text,vq_codes:encoded.vq_codes};
}
async function clip(ref,i,ctx){
  const s=source(ref,ctx),start=ref.start_seconds??0,seconds=ref.duration_seconds??Math.min(MAX_SECONDS,Math.max(1,(s.seconds??MAX_SECONDS)-start));
  return {file:await audioClip(s.file,join(ctx.outputDirectory,'reference-'+i+'.wav'),{start,seconds}),text:ref.text??null,start,seconds,from:ref.asset_id??ref.artifact_id};
}
function checkStart(ref,i,ctx){
  const s=source(ref,ctx);
  if(s.seconds!=null&&(ref.start_seconds??0)>=s.seconds)throw fail('Reference '+i+' starts after its audio ends ('+s.seconds+' s)');
  return {bytes:s.bytes};
}
// task=voice names its audio with top-level fields; it is one reference underneath.
const voiceSource=input=>({asset_id:input.audio_asset_id,artifact_id:input.audio_artifact_id,start_seconds:input.start_seconds,duration_seconds:input.duration_seconds,text:input.transcript});
export default {
  ready,idle,
  params:{'speech.synthesize':()=>({references:{type:'array',items:reference,maxItems:MAX_REFERENCES,description:'参考音色，最多 4 个；第 i 个是文本中 <|speaker:i|> 的声音，单个参考时无需标签。每个音频参考都会另存为 voice-N 作品，之后用 voice_artifact_id 复用。'},
    previous_take_artifact_ids:{...list(MAX_TAKES),description:'续写：之前语音任务产出的 take 作品，按时间顺序，最多 4 个；让新一句承接其音色与语气。参考、历史与新生成共用 8192 帧（约 380 秒）上下文。'},
    temperature:{type:'number',minimum:0,maximum:2,description:'采样温度，默认 1.0；更低更稳定（建议固定音色时 0.6–0.8），更高更有表现力。'},
    top_p:{type:'number',minimum:0.1,maximum:1,description:'核采样阈值，默认 0.9；更低更稳定。'}}),
    'speech.voice':()=>({audio_artifact_id:{...id,description:'或本人已完成任务的音频作品，如人声分离的 vocals。'},
      start_seconds:{type:'number',minimum:0,maximum:1800,description:'从第几秒开始截取，默认 0。'},
      duration_seconds:{type:'number',minimum:1,maximum:MAX_SECONDS,description:'截取时长，最长 30 秒；10–20 秒干净人声效果最好。'},
      transcript:{...str(2000),description:'片段的逐字文本；省略时自动语音识别（需启用 Qwen3-ASR）。'}})},
  notes:{'speech.synthesize':()=>'inline tags like [laughing], [sighs], [whisper] direct delivery; mark speakers with <|speaker:0|>…<|speaker:3|>; long text is chunked automatically; for a stable voice pass a registered voice as voice_artifact_id with a fixed seed',
    'speech.voice':()=>'encodes 1–30 s of clean speech once; the voice artifact keeps its name and transcript'},
  validate(capability,input){
    if(capability==='speech.voice'){
      if(!!input.audio_asset_id===!!input.audio_artifact_id)throw fail('A voice needs exactly one of audio_asset_id or audio_artifact_id');
      if(!input.transcript&&!modelEnabled('qwen3-asr'))throw fail('A voice without transcript needs Qwen3-ASR enabled');
      return;
    }
    const refs=input.references??[];
    for(const ref of refs){
      if(SOURCES.filter(k=>ref[k]).length!==1)throw fail('Each reference needs exactly one of asset_id, artifact_id or voice_artifact_id');
      if(ref.voice_artifact_id&&['start_seconds','duration_seconds','text'].some(k=>ref[k]!==undefined))throw fail('A voice_artifact_id reference already fixes its clip and transcript');
    }
    if(refs.length>1&&!/<\|speaker:\d+\|>/.test(input.text))throw fail('Several references need <|speaker:N|> tags in text');
    if(refs.some(r=>!r.voice_artifact_id&&!r.text)&&!modelEnabled('qwen3-asr'))throw fail('A reference without text needs Qwen3-ASR enabled, or give its transcript');
  },
  assets(capability,input,ctx){
    if(capability==='speech.voice')return [checkStart(voiceSource(input),0,ctx)];
    const refs=(input.references??[]).map((ref,i)=>ref.voice_artifact_id?{bytes:tokens(ref.voice_artifact_id,ctx).bytes}:checkStart(ref,i,ctx));
    return [...refs,...(input.previous_take_artifact_ids??[]).map(a=>({bytes:tokens(a,ctx).bytes}))];
  },
  // Clips are cut on the CPU before the GPU lease; transcription and encoding wait for the lease in execute.
  async payload(capability,input,ctx){
    if(capability==='speech.voice')return {name:input.name,group:input.group??null,voice:await clip(voiceSource(input),0,ctx)};
    const references=[];
    for(const [i,ref] of (input.references??[]).entries())
      references.push(ref.voice_artifact_id?{tokens:tokens(ref.voice_artifact_id,ctx).file,from:ref.voice_artifact_id}:await clip(ref,i,ctx));
    const takes=(input.previous_take_artifact_ids??[]).map(a=>tokens(a,ctx).file);
    return {text:input.text,seed:input.seed??42,temperature:input.temperature,top_p:input.top_p,references,takes};
  },
  async execute(capability,d,{base,outputDirectory}){
    const started=performance.now(),artifacts=[],conditioning=[];
    if(capability==='speech.voice'){
      const ref=d.voice,voice=await encodeVoice(base,ref);
      const saved=await saveTokens(join(outputDirectory,'voice.json'),'drama3_reference_v1',voice,{name:d.name,group:d.group??null,from:ref.from,start_seconds:ref.start,transcript:ref.text});
      const clipMedia={duration_seconds:ref.seconds,sample_rate:44100,channels:1};
      return {artifacts:[{...saved,name:'voice'},{kind:'audio',file:ref.file,mime:'audio/wav',name:'clip',media:clipMedia}],
        metrics:{name:d.name,transcript:ref.text,transcribed:!!ref.transcribed,frames:saved.media.frames,seconds:saved.media.seconds,generation_seconds:(performance.now()-started)/1000}};
    }
    for(const [i,ref] of d.references.entries()){
      if(ref.tokens){conditioning.push(await loadTokens(ref.tokens));ref.text=conditioning[i].text;continue;}
      const voice=await encodeVoice(base,ref);conditioning.push(voice);
      artifacts.push({...await saveTokens(join(outputDirectory,'voice-'+i+'.json'),'drama3_reference_v1',voice,{from:ref.from,start_seconds:ref.start,transcript:ref.text}),name:'voice-'+i});
    }
    const takes=[];for(const file of d.takes)takes.push(await loadTokens(file));
    const options={...(d.temperature!==undefined?{temperature:String(d.temperature)}:{}),...(d.top_p!==undefined?{top_p:String(d.top_p)}:{})};
    if(conditioning.length)options.references=JSON.stringify(conditioning);
    if(takes.length)options.previous_takes=JSON.stringify(takes);
    const result=await runTask(base,'fish-drama3',{text:d.text,seed:d.seed,options});
    if(typeof result.audio!=='string')throw fail('Drama 3 returned no audio');
    const file=join(outputDirectory,'output.wav'),media=await saveWav(file,result.audio),data=result.custom_schema_output?.data??{};
    if(data.reached_limit)console.warn(JSON.stringify({event:'drama3_reached_limit',frames:data.frames}));
    artifacts.unshift({kind:'audio',file,mime:'audio/wav',media:{...media,rtf:result.timing?.rtf??null}});
    const take=decoded(result,'drama3_take_v1');
    if(take)artifacts.push({...await saveTokens(join(outputDirectory,'take.json'),'drama3_take_v1',take),name:'take'});
    return {artifacts,
      metrics:{rtf:result.timing?.rtf??null,frames:data.frames??null,reached_limit:data.reached_limit??false,generation_seconds:(performance.now()-started)/1000,
        context_frames:[...conditioning,...takes].reduce((n,t)=>n+frames(t),0),
        references:d.references.map(r=>r.tokens?{from:r.from,voice:true,text:r.text}:{from:r.from,start:r.start,seconds:r.seconds,transcribed:!!r.transcribed,text:r.text})}};
  },
  effective:(capability,input)=>capability==='speech.voice'?{name:input.name,group:input.group??null,source:input.audio_asset_id??input.audio_artifact_id,start_seconds:input.start_seconds??0,duration_seconds:input.duration_seconds??null,transcript:input.transcript?'given':'auto'}:({speakers:Math.max(1,(input.references??[]).length),
    references:(input.references??[]).map(r=>r.voice_artifact_id?{voice:r.voice_artifact_id}:{source:r.asset_id??r.artifact_id,start_seconds:r.start_seconds??0,duration_seconds:r.duration_seconds??null,transcript:r.text?'given':'auto'}),
    previous_takes:(input.previous_take_artifact_ids??[]).length,temperature:input.temperature??1,top_p:input.top_p??0.9}),
};
