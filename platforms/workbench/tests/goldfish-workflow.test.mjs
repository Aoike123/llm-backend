import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildGoldfishGraph,runGoldfish,GOLDFISH_SEED,goldfishFrames} from '../lib/goldfish-workflow.mjs';
const input={prompt:'One continuous shot',reference_images_b64:[Buffer.from('one'),Buffer.from('two'),Buffer.from('three')],duration_seconds:8,seed:123};
test('original workflow patches only prompt, three references, seed and duration',async()=>{
 const graph=await buildGoldfishGraph(input,{uploadImage:async bytes=>bytes.toString()+'.png'});
 const original=JSON.parse(await readFile(new URL('../../comfyui/workflows/api/02-video/yz-h3-ultimate-original.api.json',import.meta.url),'utf8'));
 assert.equal(graph['51'].inputs.image,'one.png');assert.equal(graph['49'].inputs.image,'two.png');assert.equal(graph['50'].inputs.image,'three.png');
 assert.equal(graph['263'].inputs.text,input.prompt);assert.equal(graph['397'].inputs.seed,123);assert.equal(graph['259'].inputs.value,8);
 for(const [node,key] of [['51','image'],['49','image'],['50','image'],['263','text'],['397','seed'],['259','value']])graph[node].inputs[key]=original[node].inputs[key];
 assert.deepEqual(graph,original);assert.equal(original['252'].inputs.megapixels,1.5);assert.equal(original['261'].inputs.steps,10);
 assert.equal(original['397'].class_type,'SelfLiftH3Sampler');assert.equal(original['364'].inputs.audio[0],'254');
 const defaults=await buildGoldfishGraph({...input,seed:undefined,duration_seconds:undefined},{uploadImage:async()=> 'ref.png'});assert.equal(defaults['397'].inputs.seed,GOLDFISH_SEED);assert.equal(defaults['259'].inputs.value,10);
 assert.equal(goldfishFrames(10),243);assert.equal(goldfishFrames(15),362);
 const empty=await buildGoldfishGraph({...input,reference_images_b64:[]});assert.equal(empty['51'],undefined);
});
test('Goldfish submits native prompt once, persists its id, polls and fetches output',async()=>{
 const calls=[],events=[];let polls=0;
 const r=await runGoldfish(input,{uploadImage:async()=> 'uploaded.png',request:async(base,path,body)=>{calls.push(path);assert.equal(base,'http://127.0.0.1:8188');if(path==='/prompt'){assert.equal(body.prompt['397'].class_type,'SelfLiftH3Sampler');return {prompt_id:'native-goldfish'};}assert.deepEqual(events,['native-goldfish']);return ++polls===1?{}:{'native-goldfish':{status:{status_str:'success'},outputs:{}}};},onSubmitted:async row=>events.push(row.prompt_id),wait:async()=>{},outputDirectory:'/tmp/job',saveOutput:async(base,entry,path)=>{assert.equal(path,'/tmp/job');return {local_path:'/tmp/job/output.mp4'};}});
 assert.equal(calls.filter(path=>path==='/prompt').length,1);assert.equal(r.data[0].local_path,'/tmp/job/output.mp4');assert.equal(r.metrics.workflow,'yz-h3-ultimate-original');
});

test('original bypasses, six LoRAs, optional reference branches and output switches compile without dangling links',async()=>{
 const g=await buildGoldfishGraph({...input,reference_images_b64:Array(9).fill(Buffer.from('image')),reference_audios_b64:[Buffer.from('audio')],reference_video_audio:true,loras:{dmad:{enabled:false},mystic:{enabled:false},combat:{enabled:true,strength:.8},motion_speed:{enabled:true,strength:2},motion_repair:{enabled:true},fight_flow:{enabled:true}},optimizations:{attention_enabled:false,sparse_enabled:false,sigma_shift_enabled:false,feed_forward_enabled:false,low_vram_enabled:false,preview_enabled:false},sampling:{steps:12,transition_step:7,highres_tiling:true,upscaler_unload:false},resolution:{megapixels:1,aspect_ratio:'9:16 (Portrait Widescreen)'},output:{include_audio:false,crf:17}}, {uploadImage:async()=> 'i.png',uploadVideo:async()=> 'v.mp4',uploadAudio:async()=> 'a.wav',preparedVideos:[{bytes:Buffer.from('video'),has_audio:true}]});
 assert.equal(g['53'],undefined);assert.equal(g['400'],undefined);assert.equal(g['342'].inputs.model[0],'192');assert.equal(g['343'].inputs.model[0],'342');assert.equal(g['345'].inputs.model[0],'344');
 assert.equal(g['397'].inputs.model[0],'345');assert.equal(g['261'].inputs.model[0],'345');assert.equal(g['261'].inputs.steps,12);
 assert.equal(g['332'],undefined);assert.equal(g['329'],undefined);assert.equal(g['254'],undefined);assert.equal(g['364'].inputs.audio,undefined);assert.equal(g['364'].inputs.crf,17);
 assert.equal(g['265'].inputs['ref_images.ref_image_8'][0],'201');assert.equal(g['265'].inputs['ref_videos.ref_video_0'][0],'25');assert.equal(g['265'].inputs['ref_video_audios.ref_video_audio_0'][1],2);assert.equal(g['265'].inputs['ref_audios.ref_audio_0'][0],'14');
 assert.equal(g['25'].inputs.format,'H3');assert.equal(g['397'].inputs.highres_tiling,true);
 for(const node of Object.values(g))for(const value of Object.values(node.inputs))if(Array.isArray(value))assert.ok(g[value[0]],'Missing linked node '+value[0]);
 const disabled=await buildGoldfishGraph({...input,use_image_references:false,use_video_references:false,use_audio_references:false,reference_audios_b64:[Buffer.from('audio')]},{preparedVideos:[{bytes:Buffer.from('video')}]});
 assert.ok(!Object.keys(disabled['265'].inputs).some(k=>k.startsWith('ref_images.')||k.startsWith('ref_videos.')||k.startsWith('ref_audios.')));
 await assert.rejects(buildGoldfishGraph({...input,sampling:{steps:5}}),/transition_step/);
 await assert.rejects(buildGoldfishGraph({...input,optimizations:{sparse_start:.9,sparse_end:.1}}),/sparse_start/);
 await assert.rejects(buildGoldfishGraph({...input,reference_images_b64:[],reference_audios_b64:[Buffer.from('audio')]}),/require image/);
});
test('SelfLift invalid combinations fail before uploads or native submission',async()=>{
 const unexpected=async()=>assert.fail('Invalid sampling must fail before backend work');
 for(const sampling of [{upscaler_model:'none'},{upscaler_model:'none',rho:0}]){
  await assert.rejects(runGoldfish({...input,sampling},{uploadImage:unexpected,request:unexpected}),/requires sampling\.rho > 0/);
 }
 const graph=await buildGoldfishGraph({...input,sampling:{upscaler_model:'none',rho:.6,w_min:1,w_max:1}},{uploadImage:async()=> 'ref.png'});
 assert.equal(graph['397'].inputs.upscaler_model,'none');assert.equal(graph['397'].inputs.rho,.6);
});
test('individual reference switches preserve native picture numbers, including prepared job payloads',async()=>{
 const g=await buildGoldfishGraph({...input,reference_slots:{images:[true,false,true]}},{uploadImage:async()=> 'i.png'});
 assert.equal(g['49'],undefined);assert.equal(g['265'].inputs['ref_images.ref_image_1'],undefined);assert.deepEqual(g['265'].inputs['ref_images.ref_image_2'],['50',0]);
 const prepared=await buildGoldfishGraph({...input,reference_images_b64:[Buffer.from('one'),Buffer.from('three')],reference_images_slots:[0,2],reference_slots:{images:[true,false,true]}},{uploadImage:async()=> 'i.png'});
 assert.deepEqual(g,prepared);
});
