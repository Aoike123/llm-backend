import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import sharp from 'sharp';
import {MediaStore,atomic} from '../lib/media-store.mjs';
import {MediaJobs} from '../lib/media-jobs.mjs';
import {AccessKeys} from '../lib/access-keys.mjs';
import {Coordinator,pause} from '../lib/core.mjs';
import {McpInfo,localManagement} from '../lib/mcp-routes.mjs';
const image=await sharp({create:{width:16,height:16,channels:4,background:{r:200,g:20,b:10,alpha:0.5}}}).png().toBuffer();
async function fixture(t,execute){
  const root=await mkdtemp(join(tmpdir(),'media-jobs-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=await new MediaStore({root,maxBytes:2**30,minFreeBytes:0}).open(),keys=await AccessKeys.open(join(root,'keys.json'),{defaults:{maxConcurrent:8,requestsPerMinute:600}});
  const created=await keys.mutate({action:'create',name:'test',requestsPerMinute:600,maxConcurrent:2}),key=keys.authenticate('Bearer '+created.secret);
  const backend={models:{flux:[],h3:[],'qwen-image':[]},idle:async()=>true,ensure:async()=>{}},coordinator=new Coordinator(backend);
  keys.clock=coordinator.clock;keys.selectWaitingRequest=rows=>coordinator.selectWaitingRequest(rows);const metrics={start(){},finish(){}},lifecycle={draining:false};
  const jobs=await new MediaJobs(store,keys,coordinator,metrics,lifecycle,{execute:execute??(async()=>({data:[{b64_json:image.toString('base64')}]}))}).open();await jobs.recovery;
  t.after(()=>Promise.all([...jobs.workers]));return {root,store,keys,key,coordinator,metrics,lifecycle,jobs};
}
const input={request_id:'once',model:'qwen-image21',prompt:'A cup'};
async function finished(jobs,id){for(let i=0;i<200;i++){const job=jobs.jobs.get(id);if(['succeeded','failed','cancelled','unknown'].includes(job.state))return job;await pause(10);}throw new Error('Job did not finish');}
test('durable jobs are idempotent and isolate owners; normalized PNG preserves alpha',async t=>{
  let count=0;const f=await fixture(t,async()=>{count++;await pause(50);return {data:[{b64_json:image.toString('base64')}]};});
  const first=await f.jobs.create(f.key.id,'generate_image',input);assert.ok(JSON.parse(await readFile(join(f.store.jobs,first.job_id,'job.json'))));
  const duplicate=await f.jobs.create(f.key.id,'generate_image',{prompt:'A cup',model:'qwen-image21',request_id:'once'});assert.equal(duplicate.job_id,first.job_id);
  await assert.rejects(f.jobs.create(f.key.id,'generate_image',{...input,prompt:'Other'}),e=>e.status===409);
  assert.throws(()=>f.jobs.get('other',first.job_id),e=>e.status===404);assert.equal(f.jobs.list('other').total,0);
  const done=await finished(f.jobs,first.job_id);assert.equal(done.state,'succeeded');assert.equal(count,1);
  const artifact=f.jobs.artifact(f.key.id,done.artifacts[0].artifact_id);assert.ok(artifact.local_path.startsWith(f.root));assert.equal((await sharp(artifact.local_path).metadata()).hasAlpha,true);
  assert.throws(()=>f.jobs.artifact('other',artifact.artifact_id),e=>e.status===404);assert.equal(f.jobs.public(done).request,undefined);
  await Promise.all([...f.jobs.workers]);const reopened=await new MediaJobs(f.store,f.keys,f.coordinator,f.metrics,f.lifecycle,{execute:async()=>{throw new Error('must not retry');}}).open();await reopened.recovery;assert.equal(reopened.get(f.key.id,first.job_id).state,'succeeded');
});
test('queued cancellation is durable and never dispatches; running cancellation refused',async t=>{
  let finish,calls=0;const f=await fixture(t,async()=>{calls++;return new Promise(r=>{finish=()=>r({data:[{b64_json:image.toString('base64')}]});});});
  const first=await f.jobs.create(f.key.id,'generate_image',input);while(!finish)await pause(5);
  await assert.rejects(f.jobs.cancel(f.key.id,first.job_id),e=>e.status===409);
  const second=await f.jobs.create(f.key.id,'generate_image',{...input,request_id:'second'});await f.jobs.cancel(f.key.id,second.job_id);finish();
  await finished(f.jobs,first.job_id);await Promise.all([...f.jobs.workers]);assert.equal(calls,1);assert.equal(f.jobs.get(f.key.id,second.job_id).state,'cancelled');
});
test('backend response loss becomes unknown and holds lease until idle',async t=>{
  const f=await fixture(t,async()=>{f.coordinator.backend.idle=async()=>false;throw new Error('connection reset');});
  const accepted=await f.jobs.create(f.key.id,'generate_image',input);const done=await finished(f.jobs,accepted.job_id);assert.equal(done.state,'unknown');assert.equal(f.coordinator.status().leased,true);assert.equal(f.keys.active,1);
  f.coordinator.backend.idle=async()=>true;await Promise.all([...f.jobs.workers]);assert.equal(f.coordinator.status().leased,false);
});
test('restart after dispatch blocks model switching and does not retry ambiguous image',async t=>{
  const f=await fixture(t);const job={job_id:'job_'+'a'.repeat(32),owner_id:f.key.id,request_id:'lost',state:'dispatching',engine:'qwen-image',kind:'image',artifacts:[]};await atomic(join(f.store.jobs,job.job_id,'job.json'),job);
  let busy=true;f.coordinator.backend.idle=async()=>!busy;const manager=await new MediaJobs(f.store,f.keys,f.coordinator,f.metrics,f.lifecycle,{execute:async()=>assert.fail('must not retry')}).open();
  assert.equal(manager.recoveryPending,true);assert.throws(()=>f.coordinator.assertAcceptingRequests(),/recovery/);await assert.rejects(f.coordinator.selectLlmMode('throughput'),/recovery/);
  busy=false;await manager.recovery;assert.equal(manager.get(f.key.id,job.job_id).state,'unknown');assert.equal(manager.recoveryPending,false);
});
test('asset imports verify decoded media and owner; model constraints reject before GPU',async t=>{
  const f=await fixture(t),asset=await f.store.import(f.key.id,'image',Readable.from(image));assert.equal(asset.has_alpha,true);assert.equal(asset.file,undefined);assert.equal((await stat(f.store.getAsset(f.key.id,asset.asset_id).file)).mode&0o777,0o600);
  await assert.rejects(f.store.import(f.key.id,'image',Readable.from(Buffer.from('garbage'))));
  await assert.rejects(f.jobs.create('other','edit_image',{request_id:'a',prompt:'Blue',reference_asset_ids:[asset.asset_id]}),e=>e.status===404);
  await assert.rejects(f.jobs.create(f.key.id,'generate_image',{...input,model:'flux2-klein',size:'1024x1024'}),/FLUX/);
  await assert.rejects(f.jobs.create(f.key.id,'generate_video',{request_id:'video-model',prompt:'cup',model:'minimax-h3'}),/Unsupported parameter: model/);
  await assert.rejects(f.jobs.create(f.key.id,'generate_video',{request_id:'video-long',prompt:'cup',duration_seconds:20}),/duration_seconds is invalid/);
  const accepted=await f.jobs.create(f.key.id,'edit_image',{request_id:'edit',prompt:'Blue',reference_asset_ids:[asset.asset_id]});const payload=await f.jobs.payload(f.jobs.get(f.key.id,accepted.job_id));assert.equal(payload.steps,40);assert.equal(payload.guidance,1);assert.equal(payload.num_inference_steps,undefined);await finished(f.jobs,accepted.job_id);
});
test('job quota and revoked owner prevent backend execution',async t=>{
  let calls=0;const f=await fixture(t,async()=>{calls++;return {data:[{b64_json:image.toString('base64')}]};});
  f.store.maxBytes=1;await assert.rejects(f.jobs.create(f.key.id,'generate_image',input),e=>e.status===507);assert.equal(calls,0);
});
test('telemetry deduplicates ordered events and strips sensitive input; same-origin guard',async t=>{
  const f=await fixture(t),info=await new McpInfo(f.store).open(),event={instance_id:'instance_'+'c'.repeat(32),sequence:1,type:'call',tool:'generate_image',status:'success',duration_ms:12,prompt:'SECRET',api_key:'SECRET'};
  await info.event(f.key.id,event);await info.event(f.key.id,event);await info.event(f.key.id,{...event,sequence:0});assert.equal(info.state.calls.length,1);assert.equal(JSON.stringify(info.state).includes('SECRET'),false);
  assert.equal(info.overview(f.jobs,f.lifecycle).instances[0].initialized_at,undefined);assert.equal(info.authorized(info.secret),true);assert.equal(info.authorized('wrong'),false);
  assert.equal(localManagement({headers:{host:'127.0.0.1:13000',origin:'http://127.0.0.1:13000'}}),true);assert.equal(localManagement({headers:{host:'attacker.test'}}),false);assert.equal(localManagement({headers:{host:'localhost:13000',origin:'https://attacker.test'}}),false);
});

test('media routes require real owner identity; console and telemetry remain separate',async t=>{
  const {default:http}=await import('node:http');const {mcpRoutes}=await import('../lib/mcp-routes.mjs');
  const f=await fixture(t),info=await new McpInfo(f.store).open(),routes=mcpRoutes(f.jobs,info,f.keys,f.lifecycle);
  const server=http.createServer((req,res)=>{if(req.url.startsWith('/api/mcp/'))return routes.admin(req,res);return routes.media(req,res);});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port,created=await f.keys.mutate({action:'create',name:'second',requestsPerMinute:600}),other=created.secret;
  const first=await f.keys.mutate({action:'create',name:'route-owner',requestsPerMinute:600}),auth={Authorization:'Bearer '+first.secret};
  assert.equal((await fetch(base+'/v1/media/jobs')).status,401);assert.equal((await fetch(base+'/v1/media/jobs',{headers:{Authorization:'Bearer local'}})).status,401);
  assert.equal((await fetch(base+'/v1/media/jobs',{headers:{...auth,'x-workbench-public':'1'}})).status,404);
  assert.equal((await fetch(base+'/api/mcp/overview',{headers:{Origin:'https://example.com'}})).status,403);
  assert.equal((await fetch(base+'/api/mcp/config')).status,200);
  assert.equal((await fetch(base+'/internal/mcp/events',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:'{}'})).status,401);
  const accept=await fetch(base+'/v1/media/jobs',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({tool:'generate_image',arguments:input})});assert.equal(accept.status,202);const job=await accept.json();await finished(f.jobs,job.job_id);
  assert.equal((await fetch(base+'/v1/media/jobs/'+job.job_id,{headers:{Authorization:'Bearer '+other}})).status,404);
  const managed=await(await fetch(base+'/api/mcp/jobs')).json();assert.equal(managed.jobs[0].job_id,job.job_id);assert.equal(managed.jobs[0].owner_id,undefined);assert.equal(managed.jobs[0].request,undefined);
  assert.equal((await fetch(base+'/api/mcp/jobs',{headers:{Origin:'https://example.com'}})).status,403);
  assert.equal((await fetch(base+'/api/mcp/jobs?offset=-1')).status,400);
  const details=await (await fetch(base+'/v1/media/jobs/'+job.job_id,{headers:auth})).json(),artifact=details.artifacts[0];
  assert.equal((await fetch(base+'/v1/media/artifacts/'+artifact.artifact_id+'/content',{headers:{Authorization:'Bearer '+other}})).status,404);
  assert.equal((await fetch(base+'/v1/media/artifacts/'+artifact.artifact_id+'/content',{headers:auth})).headers.get('content-type'),'image/png');
  const uploaded=await fetch(base+'/v1/media/assets?kind=image',{method:'POST',headers:{...auth,'Content-Type':'application/octet-stream'},body:image});assert.equal(uploaded.status,201);
  const asset=await uploaded.json();assert.equal(asset.kind,'image');
  const createdOwner=f.keys.authenticate(auth.Authorization);await f.keys.mutate({action:'update',id:createdOwner.id,enabled:false});assert.equal((await fetch(base+'/v1/media/jobs',{headers:auth})).status,401);
});

test('Qwen prompts stop at 4000 characters and the error names the real length',async t=>{
  const f=await fixture(t);
  const accepted=await f.jobs.create(f.key.id,'generate_image',{request_id:'qwen-long',model:'qwen-image21',prompt:'字'.repeat(4000)});await finished(f.jobs,accepted.job_id);
  await assert.rejects(f.jobs.create(f.key.id,'generate_image',{request_id:'qwen-over',model:'qwen-image21',prompt:'字'.repeat(4001)}),/Qwen prompt is limited to 4000 characters \(got 4001\)/);
});
test('job body accepts 32000-character prompts end to end and overflow names the limit',async t=>{
  const {default:http}=await import('node:http');const {mcpRoutes}=await import('../lib/mcp-routes.mjs');
  const f=await fixture(t),info=await new McpInfo(f.store).open(),routes=mcpRoutes(f.jobs,info,f.keys,f.lifecycle);
  const server=http.createServer((req,res)=>routes.media(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port,created=await f.keys.mutate({action:'create',name:'long-prompt',requestsPerMinute:600}),headers={Authorization:'Bearer '+created.secret,'Content-Type':'application/json'};
  const send=(prompt,request_id)=>fetch(base+'/v1/media/jobs',{method:'POST',headers,body:JSON.stringify({tool:'generate_image',arguments:{request_id,model:'flux2-klein',prompt}})});
  const accepted=await send('字'.repeat(32000),'long-accepted');assert.equal(accepted.status,202);
  const job=await accepted.json();await finished(f.jobs,job.job_id);
  assert.equal(JSON.parse(await readFile(join(f.store.jobs,job.job_id,'job.json'),'utf8')).request.prompt.length,32000);
  const overflow=await send('字'.repeat(32001),'long-overflow'),error=await overflow.json();
  assert.equal(overflow.status,400);assert.match(error.error,/exceeds 32000 characters \(got 32001\)/);
});

test('known video history is recovered without resubmission and unknown jobs retain restart barrier',async t=>{
  const {default:http}=await import('node:http');const f=await fixture(t);let requests=0;
  const {execFileSync}=await import('node:child_process');const sample=join(f.root,'sample.mp4');execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=red:s=64x64:r=24','-t','2','-c:v','libx264','-threads','1','-y',sample]);const bytes=await readFile(sample);
  const backend=http.createServer((req,res)=>{requests++;if(req.url.startsWith('/history/')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({'prompt-existing':{status:{status_str:'success'},outputs:{17:{images:[{filename:'output.mp4',type:'output'}]}}}}));}else{res.end(bytes);}});
  await new Promise(r=>backend.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>backend.close(r)));
  const job={job_id:'job_'+'d'.repeat(32),owner_id:f.key.id,request_id:'video-lost',state:'running',engine:'h3',model:'minimax-h3',kind:'video',request:{prompt:'cup'},artifacts:[],backend:{base:'http://127.0.0.1:'+backend.address().port,prompt_id:'prompt-existing'},recovery_required:true};
  await atomic(join(f.store.jobs,job.job_id,'job.json'),job);
  const manager=await new MediaJobs(f.store,f.keys,f.coordinator,f.metrics,f.lifecycle,{execute:async()=>assert.fail('must not submit')}).open();await manager.recovery;
  const recovered=manager.get(f.key.id,job.job_id);assert.equal(recovered.state,'succeeded');assert.equal(recovered.recovery_required,false);assert.equal(requests,2);assert.equal(recovered.effective_parameters.frames,124);
  await manager.change(recovered,'unknown',{recovery_required:true});let busy=true;f.coordinator.backend.idle=async()=>!busy;
  // Remove known history marker to exercise unknown completion across another restart.
  await manager.change(recovered,'unknown',{backend:null});const again=await new MediaJobs(f.store,f.keys,f.coordinator,f.metrics,f.lifecycle).open();assert.equal(again.recoveryPending,true);busy=false;await again.recovery;assert.equal(again.get(f.key.id,job.job_id).recovery_required,false);
});
test('incomplete import/job directories survive restart without becoming accepted work',async t=>{
  const {mkdir}=await import('node:fs/promises');const f=await fixture(t);
  await mkdir(join(f.store.assets,'asset_'+'e'.repeat(32)));await writeFile(join(f.store.assets,'asset_'+'e'.repeat(32),'upload'),Buffer.alloc(100));await mkdir(join(f.store.jobs,'job_'+'f'.repeat(32)));
  const store=await new MediaStore({root:f.root,minFreeBytes:0}).open();assert.ok(store.usedBytes>=100);assert.equal(store.assetIndex.size,0);
  const jobs=await new MediaJobs(store,f.keys,f.coordinator,f.metrics,f.lifecycle).open();await jobs.recovery;assert.equal(jobs.jobs.size,0);
});
test('Goldfish creates a durable workflow job with owned references and validated controls',async t=>{
 const f=await fixture(t);f.jobs.launch=()=>{};
 const asset=await f.store.import(f.key.id,'image',Readable.from(image));
 const args={request_id:'goldfish',prompt:'A scene',reference_asset_ids:[asset.asset_id,asset.asset_id,asset.asset_id]};
 const created=await f.jobs.create(f.key.id,'run_goldfish_workflow',args);assert.equal(created.model,'yz-h3-ultimate-original');assert.equal(created.engine,'h3');assert.equal(created.kind,'video');
 const payload=await f.jobs.payload(f.jobs.get(f.key.id,created.job_id));assert.equal(payload.workflow,'yz-h3-ultimate-original');assert.equal(payload.reference_images_b64.length,3);assert.equal(payload.seed,undefined);assert.equal(payload.prompt,args.prompt);
 const controlled=await f.jobs.create(f.key.id,'run_goldfish_workflow',{...args,request_id:'controls',loras:{combat:{enabled:true}},output:{include_audio:false}});const controls=await f.jobs.payload(f.jobs.get(f.key.id,controlled.job_id));assert.equal(controls.loras.combat.enabled,true);assert.equal(controls.output.include_audio,false);
 const again=await f.jobs.create(f.key.id,'run_goldfish_workflow',args);assert.equal(again.job_id,created.job_id);
 await assert.rejects(f.jobs.create('other','run_goldfish_workflow',args),e=>e.status===404);
 await assert.rejects(f.jobs.create(f.key.id,'run_goldfish_workflow',{...args,request_id:'bad',reference_asset_ids:Array(10).fill(asset.asset_id)}),/count/);
});
test('Goldfish imports owned audio, preserves controls and rejects audio-only or over-duration reference groups',async t=>{
 const f=await fixture(t);f.jobs.launch=()=>{};
 const pcm=Buffer.alloc(44+32000*2*2);pcm.write('RIFF');pcm.writeUInt32LE(pcm.length-8,4);pcm.write('WAVEfmt ',8);pcm.writeUInt32LE(16,16);pcm.writeUInt16LE(1,20);pcm.writeUInt16LE(1,22);pcm.writeUInt32LE(32000,24);pcm.writeUInt32LE(64000,28);pcm.writeUInt16LE(2,32);pcm.writeUInt16LE(16,34);pcm.write('data',36);pcm.writeUInt32LE(pcm.length-44,40);
 const audio=await f.store.import(f.key.id,'audio',Readable.from(pcm)),picture=await f.store.import(f.key.id,'image',Readable.from(image));
 assert.equal(audio.kind,'audio');assert.equal(audio.seconds,2);assert.equal(audio.sample_rate,32000);
 const args={request_id:'sound',prompt:'Dialogue',reference_asset_ids:[picture.asset_id,picture.asset_id,picture.asset_id],reference_slots:{images:[true,false,true]},reference_audio_asset_ids:[audio.asset_id],loras:{combat:{enabled:true}}};
 const accepted=await f.jobs.create(f.key.id,'run_goldfish_workflow',args),payload=await f.jobs.payload(f.jobs.get(f.key.id,accepted.job_id));
 assert.deepEqual(accepted.reference_mapping.images,[{input_slot:1,tag:'<Picture 1>'},{input_slot:3,tag:'<Picture 2>'}]);
 assert.deepEqual(payload.reference_images_slots,[0,2]);assert.equal(payload.reference_images_b64.length,2);assert.equal(payload.reference_audios_b64.length,1);assert.equal(payload.loras.combat.enabled,true);
 await assert.rejects(f.jobs.create(f.key.id,'run_goldfish_workflow',{...args,request_id:'audio-only',use_image_references:false}),/require image/);
 await assert.rejects(f.jobs.create(f.key.id,'run_goldfish_workflow',{...args,request_id:'bad-steps',sampling:{steps:5}}),/transition_step/);
 await assert.rejects(f.jobs.create('other','run_goldfish_workflow',args),e=>e.status===404);
 await assert.rejects(f.store.import(f.key.id,'audio',Readable.from(Buffer.from('invalid'))),/Invalid audio/);
});
