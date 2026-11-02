import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,readFile,writeFile,stat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registry} from '../lib/registry.mjs';
import {tools,validateGeneration,candidates} from '../lib/capabilities.mjs';

const AUDIO={'fish-drama3':{enabled:true},'bs-roformer':{enabled:true},'qwen3-asr':{enabled:true}};
// The audio.cpp packages ship disabled; enable them in memory only.
function enable(t,engines=AUDIO){const saved=registry.state;registry.load({...saved,engines:{...saved.engines,...engines}});t.after(()=>registry.load(saved));}
const wav=(seconds=1,rate=8000)=>{const n=seconds*rate,b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(36+n*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);return b.toString('base64');};
const tokens=(schema,text,n)=>({id:schema,kind:'acoustic_tokens',meta:{schema,family:'fish_drama3'},payload:Buffer.from(JSON.stringify({text,vq_codes:Array.from({length:10},()=>Array(n).fill(7))})).toString('base64')});
async function fakeServer(t,{asrText='参考片段的文本'}={}){
  const seen=[];let hold=null;
  const server=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',async()=>{
    const body=JSON.parse(raw||'{}');seen.push({url:req.url,...body});if(hold)await hold;
    res.setHeader('Content-Type','application/json');
    if(req.url==='/health')return res.end('{"status":"ok"}');
    if(req.url==='/v1/tasks/unload_all_models')return res.end('{"unloaded":[]}');
    if(body.model==='qwen3-asr')return res.end(JSON.stringify({text:asrText,language:'Chinese',timing:{wall_ms:5}}));
    if(body.model==='bs-roformer')return res.end(JSON.stringify({named_audio_outputs:[{id:'vocals',audio:wav(2)},{id:'instrumental',audio:wav(2)}],timing:{wall_ms:9}}));
    if(body.model==='fish-drama3'&&body.request.options?.encode_reference_only)return res.end(JSON.stringify({artifacts:[tokens('drama3_reference_v1',body.request.options.reference_text,43)]}));
    if(body.model==='fish-drama3')return res.end(JSON.stringify({audio:wav(3),sample_rate:8000,custom_schema_output:{data:{frames:64,reached_limit:false}},timing:{rtf:0.5},artifacts:[tokens('drama3_take_v1',body.request.text,64)]}));
    res.statusCode=404;res.end('{}');
  });});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  return {base:'http://127.0.0.1:'+server.address().port,seen,hold:p=>{hold=p;}};
}
async function workdir(t){const dir=await mkdtemp(join(tmpdir(),'audio-engines-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('audio capabilities share one tool whose task selects the capability and its strict schema',async t=>{
  enable(t);
  const audio=(await tools()).find(tool=>tool.name==='generate_audio');
  assert.deepEqual(audio.inputSchema.properties.task.enum,['speech','separate','transcribe']);assert.deepEqual(audio.inputSchema.required,['request_id']);
  for(const key of ['text','audio_asset_id','references','temperature'])assert.ok(audio.inputSchema.properties[key],key);
  assert.equal((await validateGeneration('generate_audio',{request_id:'a',text:'你好'})).capability,'speech.synthesize');
  await assert.rejects(validateGeneration('generate_audio',{request_id:'a',task:'speech'}),/text is required/);
  await assert.rejects(validateGeneration('generate_audio',{request_id:'a',task:'separate',text:'x',audio_asset_id:'asset_a'}),/Unsupported parameter: text/);
  assert.deepEqual(await validateGeneration('transcribe_audio',{request_id:'a',audio_asset_id:'asset_a'}),{capability:'audio.transcribe',args:{request_id:'a',audio_asset_id:'asset_a'}});
});
test('the audio tool disappears with its engines, and image edit is inferred from references',async t=>{
  assert.ok(!(await tools()).some(tool=>tool.name==='generate_audio'));
  assert.equal((await validateGeneration('generate_image',{request_id:'a',prompt:'x',reference_asset_ids:['asset_a']})).capability,'image.edit');
  assert.equal((await validateGeneration('generate_image',{request_id:'a',prompt:'x'})).capability,'image.generate');
});
test('separation writes each stem as a named WAV artifact with its duration',async t=>{
  enable(t);const server=await fakeServer(t),dir=await workdir(t),adapter=await registry.adapter('bs-roformer');
  const result=await adapter.execute('audio.separate',adapter.payload('audio.separate',{audio_asset_id:'asset_a'},{asset:()=>({file:'/media/in.wav'})}),{base:server.base,outputDirectory:dir});
  assert.deepEqual(result.artifacts.map(a=>[a.name,a.media.duration_seconds]),[['vocals',2],['instrumental',2]]);
  for(const a of result.artifacts)assert.ok((await stat(a.file)).size>44);
  assert.equal(server.seen.at(-1).request.audio,'/media/in.wav');
});
test('transcription stores the text as a JSON artifact and in metrics',async t=>{
  enable(t);const server=await fakeServer(t,{asrText:' 你好世界 '}),dir=await workdir(t),adapter=await registry.adapter('qwen3-asr');
  const result=await adapter.execute('audio.transcribe',{audio:'/media/in.wav'},{base:server.base,outputDirectory:dir});
  assert.equal(result.metrics.text,'你好世界');assert.equal(JSON.parse(await readFile(result.artifacts[0].file,'utf8')).text,'你好世界');assert.equal(result.artifacts[0].media.characters,4);
});
test('cloning clips an artifact reference, transcribes and encodes it under the lease and keeps the voice and take',async t=>{
  enable(t);const server=await fakeServer(t),dir=await workdir(t),adapter=await registry.adapter('fish-drama3');
  const source=join(dir,'vocals.wav');execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=220:sample_rate=44100','-t','6','-y',source]);
  const ctx={asset:()=>assert.fail('asset not used'),artifact:id=>({kind:'audio',local_path:source,bytes:1000,media:{duration_seconds:6}}),outputDirectory:dir};
  const input={request_id:'s',text:'好，欢迎！[laughing]',references:[{artifact_id:'artifact_v',start_seconds:2,duration_seconds:3}]};
  adapter.validate('speech.synthesize',input);
  const d=await adapter.payload('speech.synthesize',input,ctx);
  assert.equal(server.seen.length,0,'nothing reaches the GPU before the lease');
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_format','-of','json',d.references[0].file]));assert.ok(Math.abs(Number(probe.format.duration)-3)<0.05);
  const result=await adapter.execute('speech.synthesize',d,{base:server.base,outputDirectory:dir});
  const [asr,encode,speech]=server.seen.filter(r=>r.url==='/v1/tasks/run');
  assert.equal(asr.model,'qwen3-asr');assert.equal(encode.request.voice_ref,d.references[0].file);assert.equal(encode.request.options.reference_text,'参考片段的文本');
  const [voice]=JSON.parse(speech.request.options.references);assert.equal(voice.text,'参考片段的文本');assert.equal(voice.vq_codes[0].length,43);
  assert.deepEqual(result.artifacts.map(a=>[a.kind,a.name??null]),[['audio',null],['text','voice-0'],['text','take']]);
  assert.equal(result.artifacts[0].media.duration_seconds,3);assert.equal(result.metrics.references[0].transcribed,true);
  assert.equal(result.artifacts[1].media.schema,'drama3_reference_v1');assert.equal(result.artifacts[1].media.frames,43);
  assert.equal(JSON.parse(await readFile(result.artifacts[2].file,'utf8')).text,'好，欢迎！[laughing]');
});
test('a saved voice and earlier takes are reused as tokens without transcription or encoding',async t=>{
  enable(t,{...AUDIO,'qwen3-asr':{enabled:false}});const server=await fakeServer(t),dir=await workdir(t),adapter=await registry.adapter('fish-drama3');
  const saved=async(name,schema,text)=>{const file=join(dir,name+'.json');await writeFile(file,JSON.stringify({schema,text,vq_codes:[[1,2,3]]}));return {kind:'text',local_path:file,bytes:40,media:{schema}};};
  const owned={artifact_voice:await saved('voice','drama3_reference_v1','音色原文'),artifact_take:await saved('take','drama3_take_v1','上一句'),artifact_wav:{kind:'audio',local_path:'/x.wav',media:{}}};
  const ctx={asset:()=>assert.fail('asset not used'),artifact:id=>owned[id],outputDirectory:dir};
  const input={request_id:'s',text:'下一句',seed:7,temperature:0.7,top_p:0.8,references:[{voice_artifact_id:'artifact_voice'}],previous_take_artifact_ids:['artifact_take']};
  adapter.validate('speech.synthesize',input);
  assert.throws(()=>adapter.validate('speech.synthesize',{...input,references:[{voice_artifact_id:'artifact_voice',text:'x'}]}),/already fixes/);
  assert.throws(()=>adapter.validate('speech.synthesize',{...input,references:[{voice_artifact_id:'artifact_voice',asset_id:'a'}]}),/exactly one/);
  assert.throws(()=>adapter.assets('speech.synthesize',{...input,references:[{voice_artifact_id:'artifact_wav'}]},ctx),/not a Drama 3 voice/);
  const result=await adapter.execute('speech.synthesize',await adapter.payload('speech.synthesize',input,ctx),{base:server.base,outputDirectory:dir});
  const runs=server.seen.filter(r=>r.url==='/v1/tasks/run');assert.equal(runs.length,1);
  const {options}=runs[0].request;
  assert.deepEqual(JSON.parse(options.references),[{text:'音色原文',vq_codes:[[1,2,3]]}]);assert.deepEqual(JSON.parse(options.previous_takes),[{text:'上一句',vq_codes:[[1,2,3]]}]);
  assert.equal(options.temperature,'0.7');assert.equal(options.top_p,'0.8');assert.equal(runs[0].request.seed,7);
  assert.deepEqual(result.artifacts.map(a=>a.name??a.kind),['audio','take']);assert.equal(result.metrics.context_frames,6);
  assert.deepEqual(adapter.effective('speech.synthesize',input).references,[{voice:'artifact_voice'}]);
});
test('several voices need speaker tags, and a missing transcript needs the ASR engine',async t=>{
  enable(t);const adapter=await registry.adapter('fish-drama3');
  assert.throws(()=>adapter.validate('speech.synthesize',{text:'两个人',references:[{asset_id:'a',text:'x'},{asset_id:'b',text:'y'}]}),/speaker/);
  adapter.validate('speech.synthesize',{text:'<|speaker:0|>你好<|speaker:1|>你好',references:[{asset_id:'a',text:'x'},{asset_id:'b',text:'y'}]});
  enable(t,{...AUDIO,'qwen3-asr':{enabled:false}});
  await assert.rejects(candidates('speech.synthesize',{request_id:'s',text:'hi',references:[{asset_id:'a'}]}),/Qwen3-ASR/);
});
test('the runtime is not idle while one of its requests is in flight',async t=>{
  enable(t);const server=await fakeServer(t),adapter=await registry.adapter('qwen3-asr'),ctx={base:server.base};
  assert.equal(await adapter.idle(ctx),true);
  let release;server.hold(new Promise(r=>{release=r;}));
  const pending=adapter.execute('audio.transcribe',{audio:'/x.wav'},{base:server.base,outputDirectory:await workdir(t)});
  await new Promise(r=>setTimeout(r,50));assert.equal(await adapter.idle(ctx),false);
  release();await pending;assert.equal(await adapter.idle(ctx),true);
});
