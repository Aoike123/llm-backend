import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {Registry,registry} from '../lib/registry.mjs';
import {tools,candidates,routes} from '../lib/capabilities.mjs';
import {MediaStore} from '../lib/media-store.mjs';
import {MediaJobs} from '../lib/media-jobs.mjs';
import {AccessKeys} from '../lib/access-keys.mjs';
import {Coordinator,pause} from '../lib/core.mjs';

const manifest=(engine,models,extra={})=>({name:engine,category:'image',platform:{engine,default_enabled:true,adapter:'adapter.mjs',
  runtime:{id:engine,name:engine,port:9000+engine.charCodeAt(0),container:'c-'+engine,launch:[engine,'start']},
  ui:{name:engine,description:'d',symbol:'X',accent:'#fff',panel:'media'},models,...extra}});
async function packages(t,rows){
  const root=await mkdtemp(join(tmpdir(),'registry-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const [id,body] of rows){await mkdir(join(root,'engines/image',id),{recursive:true});await writeFile(join(root,'engines/image',id,'engine.json'),JSON.stringify(body));await writeFile(join(root,'engines/image',id,'adapter.mjs'),'export default {idle:async()=>true,ready:async()=>true};\n');}
  return {enginesDir:join(root,'engines'),statePath:join(root,'state.json')};
}
// Routing changes stay in memory so tests never touch the operator's state file.
function withRouting(t,routing){const saved=registry.state.routing;registry.state.routing=routing;t.after(()=>{registry.state.routing=saved;});}

test('engine packages register from their manifest, validate it and persist enable flags',async t=>{
  const paths=await packages(t,[['a',manifest('a',[{id:'model-a',priority:1,capabilities:['image.generate']}])],['b',manifest('b',[{id:'model-b',priority:2,capabilities:['image.generate']}])]]);
  const r=new Registry(paths);
  assert.deepEqual(Object.keys(r.engines()).sort(),['a','b']);assert.deepEqual(r.routing('image.generate'),{capability:'image.generate',primary:'model-a',fallbacks:['model-b'],providers:['model-a','model-b'],fallback_on_backend_error:false});
  assert.deepEqual(r.runtimes().a.engines,['a']);assert.equal(r.services()[0].type,'image');
  await r.setEnabled('b',false);assert.deepEqual(r.routing('image.generate').providers,['model-a']);
  assert.equal(JSON.parse(await readFile(paths.statePath,'utf8')).engines.b.enabled,false);assert.equal(new Registry(paths).package('b').enabled,false);
  r.setRouting('image.generate',{primary:'model-a',fallbacks:[]});assert.throws(()=>r.setRouting('image.generate',{primary:'model-b',fallbacks:[]}),/does not provide/);
  await r.setEnabled('b',true);assert.deepEqual(r.routing('image.generate').fallbacks,[],'a saved chain is not silently extended');
});
test('conflicting or incomplete manifests fail with the file that caused them',async t=>{
  const duplicate=await packages(t,[['a',manifest('a',[{id:'same',capabilities:['image.generate']}])],['b',manifest('b',[{id:'same',capabilities:['image.generate']}])]]);
  assert.throws(()=>new Registry(duplicate),/model same is already declared by a/);
  const broken=manifest('c',[]);delete broken.platform.runtime.port;
  const incomplete=await packages(t,[['c',broken]]);
  assert.throws(()=>new Registry(incomplete),/engine\.json: platform\.runtime\.port is required/);
});
test('tools are generated per capability with the union of model parameters and an auto default',async()=>{
  const image=(await tools()).find(t=>t.name==='generate_image');
  assert.deepEqual(image.inputSchema.properties.model.enum,['auto','qwen-image21','flux2-klein']);assert.equal(image.inputSchema.properties.model.default,'auto');
  for(const key of ['mode','size','engine'])assert.ok(image.inputSchema.properties[key],key);
  assert.deepEqual(image.inputSchema.required,['request_id','prompt']);assert.match(image.description,/qwen-image21 \(primary\)/);
  assert.ok(routes().some(r=>r.capability==='video.generate'&&r.primary==='minimax-h3'));
});
test('model parameters narrow the chain and a pinned model never falls back',async t=>{
  withRouting(t,{});
  assert.deepEqual((await candidates('image.generate',{request_id:'a',prompt:'cup'})).models.map(m=>m.id),['qwen-image21','flux2-klein']);
  assert.deepEqual((await candidates('image.generate',{request_id:'a',prompt:'cup',engine:'stock'})).models.map(m=>m.id),['flux2-klein']);
  // Qwen refuses long prompts; FLUX can still serve them.
  assert.deepEqual((await candidates('image.generate',{request_id:'a',prompt:'x'.repeat(4001)})).models.map(m=>m.id),['flux2-klein']);
  await assert.rejects(candidates('image.generate',{request_id:'a',prompt:'x'.repeat(4001),model:'qwen-image21'}),/4000 characters/);
  await assert.rejects(candidates('image.generate',{request_id:'a',prompt:'cup',model:'flux2-klein',size:'1024x1024'}),/flux2-klein does not accept size/);
  withRouting(t,{'image.generate':{primary:'flux2-klein',fallbacks:['qwen-image21']}});
  assert.deepEqual((await candidates('image.generate',{request_id:'a',prompt:'cup'})).models.map(m=>m.id),['flux2-klein','qwen-image21']);
});
test('Goldfish rejects disabled lift routes using effective sampling defaults',async()=>{
  const input={request_id:'selflift',prompt:'A continuous shot'};
  for(const sampling of [{upscaler_model:'none'},{upscaler_model:'none',rho:0}])
    await assert.rejects(candidates('video.generate',{...input,sampling}),/sampling\.upscaler_model=none requires sampling\.rho > 0/);
  for(const sampling of [undefined,{},{rho:0},{rho:0,upscaler_model:'h3_upscaler_lms_v0.1.safetensors'},{rho:.6,upscaler_model:'none',w_min:1,w_max:1}])
    assert.equal((await candidates('video.generate',{...input,...(sampling===undefined?{}:{sampling})})).models[0].id,'minimax-h3');
});

const image=await sharp({create:{width:8,height:8,channels:3,background:'#c00'}}).png().toBuffer();
async function jobs(t,execute){
  const root=await mkdtemp(join(tmpdir(),'fallback-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=await new MediaStore({root,maxBytes:2**30,minFreeBytes:0}).open(),keys=await AccessKeys.open(join(root,'keys.json'),{defaults:{maxConcurrent:8,requestsPerMinute:600}});
  const key=keys.authenticate('Bearer '+(await keys.mutate({action:'create',name:'test',requestsPerMinute:600,maxConcurrent:2})).secret);
  const coordinator=new Coordinator({models:{flux:[],'qwen-image':[],h3:[]},idle:async()=>true,ensure:async()=>{}});
  keys.clock=coordinator.clock;keys.selectWaitingRequest=rows=>coordinator.selectWaitingRequest(rows);
  const manager=await new MediaJobs(store,keys,coordinator,{start(){},finish(){}},{draining:false},{execute}).open();await manager.recovery;
  t.after(()=>Promise.all([...manager.workers]));return {manager,key};
}
async function done(manager,id){for(let i=0;i<300;i++){const job=manager.jobs.get(id);if(['succeeded','failed','cancelled','unknown'].includes(job.state))return job;await pause(10);}throw new Error('Job did not finish');}
test('a primary that never received the work falls back in order and the job names who served it',async t=>{
  withRouting(t,{});const seen=[];
  const {manager,key}=await jobs(t,async engine=>{seen.push(engine);if(engine==='qwen-image')throw Object.assign(new Error('Qwen worker refused the request'),{code:'NOT_SUBMITTED'});return {data:[{b64_json:image.toString('base64')}]};});
  const job=await done(manager,(await manager.create(key.id,'generate_image',{request_id:'auto',prompt:'cup'})).job_id);
  assert.equal(job.state,'succeeded');assert.equal(job.served_by,'flux2-klein');assert.deepEqual(seen,['qwen-image','flux']);
  assert.deepEqual(job.fallback_from.map(f=>[f.model,f.code]),[['qwen-image21','NOT_SUBMITTED']]);
  await Promise.all([...manager.workers]);assert.equal(job.recovery_required,false);
});
test('a pinned model fails alone and a backend error does not fall back unless routing opts in',async t=>{
  withRouting(t,{});
  const failing=async engine=>{throw Object.assign(new Error(engine+' failed'),{code:engine==='qwen-image'?'BACKEND_FAILED':'NOT_SUBMITTED'});};
  const {manager,key}=await jobs(t,failing);
  const pinned=await done(manager,(await manager.create(key.id,'generate_image',{request_id:'pinned',prompt:'cup',model:'flux2-klein'})).job_id);
  assert.equal(pinned.state,'failed');assert.equal(pinned.fallback_from,undefined);
  const backend=await done(manager,(await manager.create(key.id,'generate_image',{request_id:'backend',prompt:'cup'})).job_id);
  assert.equal(backend.state,'failed');assert.equal(backend.error.code,'BACKEND_FAILED');assert.equal(backend.fallback_from,undefined);
  withRouting(t,{'image.generate':{primary:'qwen-image21',fallbacks:['flux2-klein'],fallback_on_backend_error:true}});
  const opted=await done(manager,(await manager.create(key.id,'generate_image',{request_id:'opted',prompt:'cup'})).job_id);
  assert.deepEqual(opted.fallback_from.map(f=>f.model),['qwen-image21']);assert.equal(opted.error.code,'JOB_FAILED');
});
