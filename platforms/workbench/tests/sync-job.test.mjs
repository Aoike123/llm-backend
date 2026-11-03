import '../lib/registry.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mcpRoutes} from '../lib/mcp-routes.mjs';
import {syncViaJob} from '../lib/media-tools.mjs';
import {apiCatalog} from '../lib/api-catalog.mjs';
import {PublicExposure} from '../lib/public-exposure.mjs';
// Engines are off in a test run; the routes are what an enabled speech and image engine would report.
const routes=()=>[['speech.synthesize','generate_speech','speech','语音合成','fish-drama3'],['image.generate','generate_image','generate','生图','qwen-image21']].map(([capability,tool,task,label,model])=>({capability,tool,task,label,primary:model,fallbacks:[],providers:[model]}));

process.env.WORKBENCH_SYNC_WAIT_SECONDS='1';
// A stand-in for the job system: the job finishes (or not) on the second look.
function fixture(t,{outcome='succeeded',file}={}){
  const created=[];let looks=0;
  const job={job_id:'job_'+'a'.repeat(32),state:'queued',served_by:'fish-drama3',metrics:{rtf:0.5},artifacts:[{artifact_id:'artifact_'+'b'.repeat(32),kind:'audio',mime_type:'audio/wav',bytes:4,name:null,local_path:file,media:{seconds:1}},{artifact_id:'artifact_'+'c'.repeat(32),kind:'text',mime_type:'application/json',bytes:2,name:'take',local_path:'/secret/path'}],error:{code:'BACKEND_FAILED'}};
  const jobs={create:async(owner,tool,input)=>{created.push({owner,tool,input});return {job_id:job.job_id};},
    get:()=>{if(++looks>1&&outcome!=='running')job.state=outcome;else job.state='running';return job;},public:j=>({...j,poll_after_seconds:5,artifacts:undefined,local_path:undefined})};
  const keys={authenticate:header=>header==='Bearer good'?{id:'key_1'}:null};
  const {syncJob}=mcpRoutes(jobs,{},keys,{});
  const server=http.createServer(syncJob);return new Promise(r=>server.listen(0,'127.0.0.1',()=>{t.after(()=>new Promise(done=>server.close(done)));r({created,base:'http://127.0.0.1:'+server.address().port});}));
}
const post=(base,body,headers={})=>fetch(base+'/v1/audio/speech',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer good',...headers},body:JSON.stringify(body)});

test('audio capabilities declare job-backed sync routes, private until switched on',async t=>{
  for(const path of ['/v1/audio/speech','/v1/audio/voices','/v1/audio/separations','/v1/audio/transcriptions'])assert.ok(syncViaJob(path),path);
  assert.ok(!syncViaJob('/v1/images/generations'));
  const catalog=apiCatalog(routes(),[]),sync=catalog.groups.find(g=>g.id==='sync').routes;
  assert.ok(sync.some(r=>r.path==='/v1/audio/speech'&&/等待任务完成/.test(r.purpose)));
  const dir=await mkdtemp(join(tmpdir(),'sync-job-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const exposure=await PublicExposure.open(join(dir,'e.json'),{routes,root:dir});
  assert.equal(exposure.catalog().find(r=>r.path==='/v1/audio/speech').exposed,false,'declared sync_public: false');
  assert.equal(exposure.catalog().find(r=>r.path==='/v1/images/generations').exposed,true);
  await exposure.mutate({action:'set',id:'POST /v1/audio/speech',exposed:true});assert.ok(exposure.allows('/v1/audio/speech'));
  const again=await PublicExposure.open(join(dir,'e.json'),{routes,root:dir});assert.ok(again.allows('/v1/audio/speech'),'the opt-in persists');
  await again.mutate({action:'set',id:'POST /v1/audio/speech',exposed:false});assert.ok(!again.allows('/v1/audio/speech'));
});
test('a job-backed sync call submits the capability job for the caller, waits and describes the artifacts',async t=>{
  const {base,created}=await fixture(t),response=await post(base,{text:'你好'});
  assert.equal(response.status,200);const body=await response.json();
  assert.equal(body.state,'succeeded');assert.equal(body.served_by,'fish-drama3');assert.deepEqual(body.artifacts.map(a=>a.kind),['audio','text']);
  assert.ok(!JSON.stringify(body).includes('/secret/path'),'local paths are not part of the answer');
  assert.equal(created[0].owner,'key_1');assert.equal(created[0].tool,'generate_speech');assert.equal(created[0].input.task,'speech');assert.match(created[0].input.request_id,/^sync-/);
  assert.equal((await post(base,{text:'x',request_id:'mine'}).then(r=>r.status)),200);assert.equal(created[1].input.request_id,'mine');
});
test('Accept: audio/* returns the audio itself; failures are 502; a job still running is 202; no key is 401',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sync-audio-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,'o.wav');await writeFile(file,'RIFF');
  const ok=await fixture(t,{file}),audio=await post(ok.base,{text:'x'},{Accept:'audio/wav'});
  assert.equal(audio.status,200);assert.equal(audio.headers.get('content-type'),'audio/wav');assert.equal(await audio.text(),'RIFF');assert.match(audio.headers.get('x-job-id'),/^job_/);
  const failed=await fixture(t,{outcome:'failed'}),bad=await post(failed.base,{text:'x'});assert.equal(bad.status,502);assert.equal((await bad.json()).state,'failed');
  const slow=await fixture(t,{outcome:'running'}),pending=await post(slow.base,{text:'x'});assert.equal(pending.status,202);assert.match((await pending.json()).job_id,/^job_/);
  assert.equal((await post(ok.base,{text:'x'},{Authorization:'Bearer nope'})).status,401);
  assert.equal((await fetch(ok.base+'/v1/images/generations',{method:'POST'})).status,404,'only job-backed sync paths are served here');
});
