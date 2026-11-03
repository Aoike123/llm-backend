import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {listJobs,listArtifacts,jobRow,promptOf,streamFile,thumbnail} from '../lib/media-library.mjs';
import {parseRoute,formatRoute} from '../app/use-route.mjs';

const id=n=>'job_'+String(n).padStart(32,'0');
const art=(n,kind)=>({artifact_id:'artifact_'+String(n).padStart(32,'0'),kind,mime_type:kind==='image'?'image/png':'audio/wav',bytes:10,local_path:'/x'});
function fixture(){
  const rows=[
    {job_id:id(1),engine:'h3',kind:'video',tool:'generate_video',state:'succeeded',created_at:'2026-11-01T00:00:00Z',request:{prompt:'a  cat\nwalks'},artifacts:[{...art(1,'video'),mime_type:'video/mp4'}]},
    {job_id:id(2),engine:'tts',kind:'audio',tool:'generate_audio',state:'succeeded',created_at:'2026-11-02T00:00:00Z',request:{text:'你好',instruct:'轻声'},artifacts:[art(2,'audio')]},
    {job_id:id(3),engine:'qwen-image',kind:'image',tool:'generate_image',state:'failed',created_at:'2026-11-03T00:00:00Z',request:{prompt:'x'},artifacts:[]},
    {job_id:id(4),engine:'qwen-image',kind:'image',tool:'generate_image',state:'running',created_at:'2026-11-04T00:00:00Z',request:{prompt:'y'},artifacts:[]},
    {job_id:id(5),engine:'qwen-image',kind:'image',tool:'edit_image',state:'succeeded',created_at:'2026-11-05T00:00:00Z',request:{prompt:'z'},artifacts:[art(5,'image'),art(6,'image')]},
  ];
  return {jobs:new Map(rows.map(r=>[r.job_id,r])),public:({request,owner_id,...v})=>v};
}
const url=q=>new URL('http://x/?'+q);

test('job lists are newest first, filter by state group, engine and kind, and count each facet under the other filters',()=>{
  const jobs=fixture();
  const all=listJobs(jobs,url(''));
  assert.deepEqual(all.jobs.map(j=>j.job_id),[id(5),id(4),id(3),id(2),id(1)]);
  assert.deepEqual(all.facets.state,{succeeded:3,active:1,failed:1});
  const image=listJobs(jobs,url('engine=qwen-image&state=active'));
  assert.deepEqual(image.jobs.map(j=>j.job_id),[id(4)]);
  // The state facet ignores the state filter but keeps the engine filter.
  assert.deepEqual(image.facets.state,{succeeded:1,failed:1,active:1});
  assert.deepEqual(image.facets.engine,{'qwen-image':1});
  assert.equal(all.jobs[0].request,undefined);assert.equal(all.jobs.at(-1).prompt,'a cat walks');
  assert.throws(()=>listJobs(jobs,url('state=bogus')),/Invalid state/);
  assert.throws(()=>listJobs(jobs,url('limit=500')),/Invalid pagination/);
});

test('the asset library flattens artifacts of succeeded jobs, keeps removed engines and pages',()=>{
  const jobs=fixture();
  const page=listArtifacts(jobs,url('limit=2'));
  assert.equal(page.total,4);assert.equal(page.has_more,true);
  assert.deepEqual(page.artifacts.map(a=>[a.job_id,a.kind]),[[id(5),'image'],[id(5),'image']]);
  assert.deepEqual(page.facets.engine,{'qwen-image':2,tts:1,h3:1});
  assert.deepEqual(listArtifacts(jobs,url('kind=audio')).artifacts.map(a=>[a.engine,a.prompt]),[['tts','你好']]);
  assert.deepEqual(listArtifacts(jobs,url('engine=h3')).facets.kind,{video:1});
});

test('the console detail carries the full request; lists only an excerpt',()=>{
  const jobs=fixture(),job=jobs.jobs.get(id(2));
  assert.deepEqual(jobRow(jobs,job,{full:true}).input,{text:'你好',instruct:'轻声'});
  assert.equal(jobRow(jobs,job).input,undefined);
  assert.equal(promptOf({request:{prompt:'x'.repeat(400)}}).length,280);
  assert.equal(promptOf({request:{prompt:'x'.repeat(400)}},{full:true}).length,400);
  assert.equal(promptOf({request:{audio_asset_id:'a'}}),null);
});

test('artifacts stream with byte ranges and immutable caching',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'library-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'a.bin');await writeFile(file,'0123456789');
  const server=http.createServer((req,res)=>streamFile(req,res,{path:file,mime_type:'application/octet-stream',bytes:10}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const base='http://127.0.0.1:'+server.address().port;
  const part=await fetch(base,{headers:{Range:'bytes=2-4'}});
  assert.equal(part.status,206);assert.equal(await part.text(),'234');assert.equal(part.headers.get('content-range'),'bytes 2-4/10');
  assert.equal(await (await fetch(base,{headers:{Range:'bytes=-3'}})).text(),'789');
  assert.equal((await fetch(base,{headers:{Range:'bytes=20-'}})).status,416);
  const whole=await fetch(base);assert.equal(whole.status,200);assert.match(whole.headers.get('cache-control'),/immutable/);
});

test('image and video thumbnails are small WebP files cached on the state disk',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'thumbs-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const png=join(dir,'big.png');await sharp({create:{width:2000,height:1000,channels:3,background:'#336699'}}).png().toFile(png);
  const store={state:dir},image={artifact_id:'artifact_'+'a'.repeat(32),kind:'image',local_path:png};
  const first=await thumbnail(store,image,320);
  assert.equal(first.mime_type,'image/webp');assert.deepEqual(await sharp(first.path).metadata().then(m=>[m.width,m.height]),[320,160]);
  const again=await Promise.all([thumbnail(store,image,640),thumbnail(store,image,640)]);
  assert.equal(again[0].path,again[1].path);assert.equal((await stat(again[0].path)).size,again[0].bytes);
  const mp4=join(dir,'v.mp4');
  await promisify(execFile)('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=red:s=320x240:d=1','-pix_fmt','yuv420p','-y',mp4]);
  const video=await thumbnail(store,{artifact_id:'artifact_'+'b'.repeat(32),kind:'video',local_path:mp4},320);
  assert.equal((await sharp(video.path).metadata()).width,320);
  await assert.rejects(thumbnail(store,{...image,kind:'audio'},320),/images and videos/);
  await assert.rejects(thumbnail(store,image,100),/Invalid thumbnail width/);
});

test('the console route lives in the hash and round-trips',()=>{
  assert.deepEqual(parseRoute('#/services/h3/works?job=job_1'),{section:'services',service:'h3',view:'works',job:'job_1'});
  assert.deepEqual(parseRoute(''),{section:'overview',service:null,view:null,job:null});
  assert.equal(parseRoute('#/nowhere').section,'overview');
  assert.equal(formatRoute({section:'services',service:'qwen-image',view:'tasks'}),'#/services/qwen-image/tasks');
  // Only the services page carries a service in its path.
  assert.equal(formatRoute({section:'library',service:'h3',job:'job_2'}),'#/library?job=job_2');
});
test('a work category narrows artifacts and their facets to its capabilities and kinds',()=>{
  const jobs=fixture(),drama=(n,capability,artifacts)=>({job_id:id(n),engine:'fish-drama3',kind:'audio',tool:'generate_audio',capability,state:'succeeded',created_at:'2026-11-0'+n+'T00:00:00Z',request:{text:'句'+n},artifacts});
  for(const job of [drama(6,'speech.synthesize',[art(60,'audio'),{...art(61,'text'),name:'take'}]),drama(7,'speech.voice',[{...art(70,'text'),name:'voice'},{...art(71,'audio'),name:'clip'}])])jobs.jobs.set(job.job_id,job);
  const works=listArtifacts(jobs,url('engine=fish-drama3&capability=speech.synthesize&kinds=audio'));
  assert.deepEqual(works.artifacts.map(a=>a.artifact_id),[art(60).artifact_id]);assert.deepEqual(works.facets.kind,{audio:1});
  assert.equal(listArtifacts(jobs,url('engine=fish-drama3')).total,4);
  assert.throws(()=>listArtifacts(jobs,url('kinds=audio,bogus')),/Invalid kind/);
});
