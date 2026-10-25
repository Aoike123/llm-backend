import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateVideoRequest,buildH3Graph,videoOutputFiles} from '../lib/media.mjs';
import {prepareH3Videos} from '../lib/h3-references.mjs';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
const body={prompt:'Use <Picture 1> for identity and <Video 1> for motion.'};
test('nine pictures and three videos wire to Ref2VA in stable per-type order',async()=>{
 const request={...body,reference_images_b64:Array(9).fill(png),reference_videos_b64:Array(3).fill('AAAA')};
 const {graph,reference,preset}=await buildH3Graph(request,{uploadImage:async()=> 'image.png',uploadVideo:async()=> 'clip.mp4',preparedVideos:Array.from({length:3},()=>({bytes:Buffer.from('video'),seconds:2,effective_frames:39,has_audio:true}))});
 assert.equal(reference,true);assert.equal(preset,'reference');
 assert.match(graph['1'].inputs.unet_name,/ref2va/);assert.equal(graph['5'].class_type,'MiniMaxH3ReferenceToVideo');assert.equal(graph['11'].inputs.steps,20);assert.equal(graph['6'],undefined);
 for(let i=0;i<9;i++)assert.deepEqual(graph['5'].inputs['ref_images.ref_image_'+i],[String(100+i),0]);
 for(let i=0;i<3;i++){
  assert.deepEqual(graph['5'].inputs['ref_videos.ref_video_'+i],[String(201+i*2),0]);
  assert.deepEqual(graph['5'].inputs['ref_video_audios.ref_video_audio_'+i],[String(201+i*2),1]);
 }
 assert.equal(graph['8'].inputs.engine,'paiton');
});
test('reference turbo uses only its matching LoRA and four-step schedule',async()=>{
 const {graph}=await buildH3Graph({...body,reference_images_b64:[png],preset:'reference-turbo4'},{uploadImage:async()=> 'image.png'});
 assert.match(graph['6'].inputs.lora_name,/ref2v_turbo_4step/);assert.equal(graph['11'].inputs.steps,4);
});
test('first/last frame path retains existing model and eight-step preset',async()=>{
 const {graph,reference}=await buildH3Graph({...body,first_frame_b64:png,last_frame_b64:png},{uploadImage:async()=> 'image.png'});
 assert.equal(reference,false);assert.match(graph['1'].inputs.unet_name,/fl2va/);assert.equal(graph['11'].inputs.steps,8);assert.deepEqual(graph['5'].inputs.first_frame,['100',0]);assert.deepEqual(graph['5'].inputs.last_frame,['101',0]);
});
test('invalid reference counts, incompatible presets and malformed media fail before GPU work',()=>{
 for(const extra of [
  {reference_images_b64:Array(10).fill(png)},
  {reference_videos_b64:Array(4).fill('AAAA')},
  {reference_images_b64:'bad'},
  {reference_images_b64:[png],first_frame_b64:png},
  {reference_images_b64:[png],preset:'turbo8'},
  {reference_images_b64:['not an image']},
  {reference_videos_b64:['http://example.com/clip.mp4']},
  {reference_images_b64:[png],preset:'reference-turbo4',steps:20},
  {preset:'reference'},
 ])assert.throws(()=>validateVideoRequest('h3',{...body,...extra}));
 assert.throws(()=>validateVideoRequest('wan',{...body,reference_videos_b64:['AAAA']}));
 validateVideoRequest('h3',{...body,reference_images_b64:[png],width:1344,height:768,frames:360,steps:25});
 validateVideoRequest('h3',{...body,reference_images_b64:[png],width:768,height:1344,frames:362});
});
test('real 30fps video is decoded, normalized to 24fps, preserves optional sound and rejects truncation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'h3-test-'));
 try {
  const source=join(directory,'source.mp4');
  execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=320x192:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=32000','-t','2','-c:v','libx264','-threads','1','-c:a','aac','-y',source]);
  const encoded=(await readFile(source)).toString('base64');
  const [result]=await prepareH3Videos({...body,reference_videos_b64:[encoded],reference_video_audio:true});
  assert.equal(result.has_audio,true);assert.equal(result.seconds,2);
  const normalized=join(directory,'normalized.mp4');await writeFile(normalized,result.bytes);
  const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',normalized],{encoding:'utf8'}));
  assert.equal(info.streams.find(s=>s.codec_type==='video').r_frame_rate,'24/1');
  assert.ok(info.streams.some(s=>s.codec_type==='audio'));
  const [silent]=await prepareH3Videos({...body,reference_videos_b64:[encoded]});assert.equal(silent.has_audio,false);
  await assert.rejects(prepareH3Videos({...body,reference_videos_b64:[encoded],frames:5}),/longer than the output/);
  await assert.rejects(prepareH3Videos({...body,reference_videos_b64:['AAAA']}),/cannot be decoded/);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('input MP4 previews cannot be returned instead of newly generated video',()=>{
 const input={filename:'reference.mp4',type:'input'},output={filename:'generated.mp4',type:'output'};
 assert.deepEqual(videoOutputFiles({outputs:{200:{images:[input]},17:{images:[output]}}}),[output]);
 assert.deepEqual(videoOutputFiles({outputs:{200:{images:[input]}}}),[]);
});
