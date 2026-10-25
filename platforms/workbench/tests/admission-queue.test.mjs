import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {AccessKeys,secureApi,linkCoordinator} from '../lib/access-keys.mjs';
import {Coordinator,pause} from '../lib/core.mjs';
import {enginePolicyKey} from '../lib/llm.mjs';
async function fixture(t,limits={},{sharedEngines={tts:3},models={tts:[],flux:[],llm:[]}}={}){
 const dir=await mkdtemp(join(tmpdir(),'admission-queue-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await AccessKeys.open(join(dir,'keys.json'));
 const created=await store.mutate({action:'create',name:'share',maxConcurrent:1,maxQueued:8,requestsPerMinute:300,...limits});
 const backend={models,calls:[],async ensure(m){this.calls.push(m);},async idle(){return true;}};
 const c=new Coordinator(backend,{sharedEngines});linkCoordinator(store,c);
 return {store,c,backend,key:store.authenticate('Bearer '+created.secret),secret:created.secret};
}
async function addKey(store,name,limits={}){
 const created=await store.mutate({action:'create',name,maxQueued:8,requestsPerMinute:300,...limits});return store.authenticate('Bearer '+created.secret);
}
async function listen(t,handler){
 const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 return 'http://127.0.0.1:'+server.address().port;
}
const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};};
async function until(check){for(let i=0;i<100;i++){if(check())return;await pause(10);}assert.ok(check(),'expected state was not reached');}
const settled=promise=>{const box={value:undefined,done:false};promise.then(v=>{box.value=v;box.done=true;},()=>{box.done=true;});return box;};

test('key concurrency counts held leases only: one slot runs TTS serially, three slots fill the engine',async t=>{
 const {store,c,key}=await fixture(t);
 const leases=[0,1,2].map(()=>settled(c.acquire('tts',{key:key.id,timeout:2})));await pause(20);
 assert.equal(c.status().active_leases,1);assert.equal(c.status().queued,2);
 assert.deepEqual(store.snapshot().keys[0].active,1);assert.deepEqual(store.snapshot().keys[0].queued,2);
 await store.mutate({action:'update',id:key.id,maxConcurrent:3});await pause(20);
 assert.equal(c.status().active_leases,3);assert.equal(c.status().queued,0);assert.ok(leases.every(l=>l.done));
 for(const l of leases)await c.release(l.value.token);assert.equal(c.status().leased,false);
});

test('engine capacity bounds every key together; the next free slot goes to the key holding fewest leases',async t=>{
 const {store,c,key}=await fixture(t,{maxConcurrent:3});const bob=await addKey(store,'Bob',{maxConcurrent:3});
 const alice=[0,1,2,3,4].map(()=>settled(c.acquire('tts',{key:key.id,timeout:2})));await pause(20);
 assert.equal(c.status().active_leases,3);
 const bobs=settled(c.acquire('tts',{key:bob.id,timeout:2}));await pause(20);assert.equal(bobs.done,false);
 await c.release(alice[0].value.token);await pause(20);
 assert.equal(bobs.done,true);assert.equal(alice[3].done,false);
 await c.release(alice[1].value.token);await pause(20);assert.equal(alice[3].done,true);
 for(const l of [alice[2],alice[3],bobs])await c.release(l.value.token);await pause(20);
 await c.release(alice[4].value.token);assert.equal(c.status().leased,false);
});

test('waiting for another engine does not block the same key on the loaded engine',async t=>{
 const {store,c,key}=await fixture(t,{maxConcurrent:2});
 const flux=await c.acquire('flux',{key:key.id,timeout:2});
 const tts=settled(c.acquire('tts',{key:key.id,timeout:2}));await pause(20);
 assert.equal(tts.done,false);assert.equal(store.snapshot().keys[0].active,1);assert.equal(store.snapshot().keys[0].queued,1);
 await c.release(flux.token);await until(()=>tts.done);await c.release(tts.value.token);
});

test('key and global overflow have distinct codes; zero queue rejects at the concurrency limit',async t=>{
 const {store,c,key}=await fixture(t,{maxQueued:1});
 const hold=await c.acquire('flux',{key:key.id,timeout:2}),waiting=settled(c.acquire('flux',{key:key.id,timeout:2}));
 await assert.rejects(c.acquire('flux',{key:key.id}),{code:'API_KEY_QUEUE_FULL',details:{current:1,limit:1}});
 await store.mutate({action:'update',id:key.id,maxQueued:0});
 await assert.rejects(c.acquire('flux',{key:key.id}),e=>e.code==='API_KEY_CONCURRENCY_LIMIT_EXCEEDED'&&e.retryAfterSeconds===5);
 await c.release(hold.token);await until(()=>waiting.done);await c.release(waiting.value.token);
 await store.mutate({action:'update',id:key.id,maxQueued:8});await store.mutate({action:'settings',maxConcurrent:1,maxQueued:1});
 const bob=await addKey(store,'Bob'),first=await c.acquire('flux',{key:key.id,timeout:2}),second=settled(c.acquire('flux',{key:bob.id,timeout:2}));
 await assert.rejects(c.acquire('flux',{key:key.id}),{code:'GLOBAL_QUEUE_FULL'});
 await c.release(first.token);await until(()=>second.done);await c.release(second.value.token);
});

test('queued requests expire, cancel and are removed immediately on revocation',async t=>{
 const {store,c,key}=await fixture(t);const hold=await c.acquire('flux',{key:key.id,timeout:2});
 await assert.rejects(c.acquire('flux',{key:key.id,timeout:.05}),{code:'ADMISSION_QUEUE_WAIT_TIMEOUT'});assert.equal(c.status().queued,0);
 const controller=new AbortController(),cancelled=c.acquire('flux',{key:key.id,signal:controller.signal});await pause(5);controller.abort();
 await assert.rejects(cancelled,{code:'CLIENT_REQUEST_CANCELLED'});assert.equal(c.status().queued,0);
 const revoked=c.acquire('flux',{key:key.id}),check=assert.rejects(revoked,{code:'API_KEY_INVALID'});
 await store.mutate({action:'update',id:key.id,enabled:false});await check;
 assert.equal(c.status().queued,0);await c.release(hold.token);assert.equal(store.snapshot().active,0);
});

test('a lease kept through a client disconnect keeps the key slot until the backend finishes',async t=>{
 const {c,key,backend}=await fixture(t);let busy=true;backend.idle=async()=>!busy;
 const running=await c.acquire('flux',{key:key.id,timeout:2}),next=settled(c.acquire('flux',{key:key.id,timeout:2}));
 await assert.rejects(c.release(running.token),/busy/);await pause(20);assert.equal(next.done,false);
 busy=false;await c.release(running.token);await until(()=>next.done);await c.release(next.value.token);
});

test('trusted local calls are not limited by key quotas but share engine capacity',async t=>{
 const {store,c,key}=await fixture(t,{maxQueued:0});await store.mutate({action:'settings',maxConcurrent:1,maxQueued:0});
 const keyed=await c.acquire('tts',{key:key.id,timeout:2}),locals=[await c.acquire('tts',{timeout:2}),await c.acquire('tts',{timeout:2})];
 assert.equal(c.status().active_leases,3);assert.equal(store.snapshot().active,1);
 const fourth=settled(c.acquire('tts',{timeout:2}));await pause(20);assert.equal(fourth.done,false);
 await c.release(keyed.token);await until(()=>fourth.done);for(const l of [...locals,fourth.value])await c.release(l.token);
});

test('changed settings persist and validate; legacy stores gain queue defaults',async t=>{
 const {store,key}=await fixture(t);
 await store.mutate({action:'update',id:key.id,maxConcurrent:2,maxQueued:3});
 await store.mutate({action:'settings',maxQueued:256,queueWaitSeconds:120});
 const reopened=await AccessKeys.open(store.file);assert.equal(reopened.state.settings.maxQueued,256);assert.equal(reopened.state.settings.queueWaitSeconds,120);assert.equal(reopened.state.keys[0].maxQueued,3);
 await assert.rejects(store.mutate({action:'settings',maxQueued:257}));await assert.rejects(store.mutate({action:'update',id:key.id,maxQueued:-1}));
 const state=JSON.parse(await readFile(store.file,'utf8'));
 delete state.settings.maxQueued;delete state.settings.queueWaitSeconds;delete state.keys[0].maxQueued;state.keys[0].maxConcurrent=1;
 await writeFile(store.file,JSON.stringify(state));const legacy=await AccessKeys.open(store.file);
 assert.equal(legacy.state.keys[0].maxConcurrent,1);assert.equal(legacy.state.keys[0].maxQueued,8);assert.equal(legacy.state.settings.maxQueued,32);assert.equal(legacy.state.settings.queueWaitSeconds,900);
});

test('rate limits reject at entry before any queue slot is taken',async t=>{
 const {store,c,key}=await fixture(t,{requestsPerMinute:1});store.admit(key);
 assert.throws(()=>store.admit(key),{code:'API_KEY_REQUEST_RATE_LIMIT_EXCEEDED'});
 assert.equal(c.status().queued,0);assert.equal(store.snapshot().keys[0].requests,1);
});

test('production HTTP batches mixed engines for a key with concurrency one',async t=>{
 const {handlers}=await import('../lib/http.mjs'),{Metrics}=await import('../lib/metrics.mjs');
 const dir=await mkdtemp(join(tmpdir(),'admission-http-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await AccessKeys.open(join(dir,'keys.json')),{secret}=await store.mutate({action:'create',name:'share',maxConcurrent:1,maxQueued:8,requestsPerMinute:300});
 t.mock.method(console,'info',()=>{});
 const first=gate(),entered=gate(),order=[],switches=[];t.after(()=>first.resolve());
 const backend={models:{llm:[],flux:[],'qwen-image':[]},async ensure(model,_deadline,_clock,policy){if(model==='llm')this.loadedLlmMode=enginePolicyKey(policy);if(switches.at(-1)!==model)switches.push(model);},async idle(){return true;}};
 const c=new Coordinator(backend),raw=handlers(c,new Metrics(),{draining:false}).api,networkFetch=globalThis.fetch;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  const target=new URL(url);
  if(!['18983','8191','7861','7862'].includes(target.port))return networkFetch(url,options);
  if(target.pathname==='/tokenize')return Response.json({count:2});
  if(target.pathname==='/unload')return Response.json({ok:true});
  const model=target.port==='18983'?'llm':target.port==='8191'?'qwen-image':'flux';order.push(model);
  if(order.length===1){entered.resolve();await first.promise;}
  return Response.json(model==='llm'?{choices:[]}:{image:'fake-image',data:[]});
 });
 const base=await listen(t,secureApi(raw,store,{coordinator:c})),requests=[];
 const submit=(model)=>fetch(base+(model==='llm'?'/v1/chat/completions':'/v1/images/generations'),{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify({model:{llm:'qwen38-27b-w3a4',flux:'flux2-klein','qwen-image':'qwen-image21'}[model],messages:[{role:'user',content:'x'}],prompt:'x',max_tokens:8})});
 requests.push(submit('llm'));await entered.promise;
 for(const model of ['flux','llm','qwen-image','flux','llm','qwen-image','llm','llm']){requests.push(submit(model));await until(()=>c.status().queued===requests.length-1);}
 assert.equal(store.snapshot().active,1);assert.equal(c.status().active_leases,1);
 assert.deepEqual(c.status().engine_scheduling.waiting_by_engine,{flux:2,llm:4,'qwen-image':2});
 first.resolve();const responses=await Promise.all(requests);assert.ok(responses.every(r=>r.status===200));
 await Promise.all(responses.map(r=>r.json()));await until(()=>store.snapshot().active===0&&store.preparedBytes===0);
 assert.deepEqual(order,['llm','llm','llm','llm','flux','flux','qwen-image','qwen-image','llm']);assert.deepEqual(switches,['llm','flux','qwen-image','llm']);
 assert.equal(c.status().active_leases,0);assert.equal(store.preparing.size,0);
});

test('prepared request bodies have a global byte bound and idempotent cleanup',async t=>{
 const {store,key}=await fixture(t),a=store.reservePreparation(key,32*2**20),b=store.reservePreparation(key,undefined);
 assert.equal(store.snapshot().prepared_body_bytes,64*2**20);
 assert.throws(()=>store.reservePreparation(key,1),{code:'ADMISSION_BODY_BUDGET_EXCEEDED'});
 a();a();b();assert.equal(store.preparedBytes,0);assert.equal(store.preparing.size,0);
});

test('HTTP disconnect while queued cancels before generation and releases the prepared body budget',async t=>{
 const {handlers}=await import('../lib/http.mjs'),{Metrics}=await import('../lib/metrics.mjs');
 const {store,c,key,secret,backend}=await fixture(t,{},{models:{flux:[]}});
 t.mock.method(console,'info',()=>{});t.mock.method(console,'warn',()=>{});
 const hold=await c.acquire('flux',{key:key.id,timeout:2});backend.calls.length=0;
 const base=await listen(t,secureApi(handlers(c,new Metrics(),{draining:false}).api,store,{coordinator:c})),controller=new AbortController();
 const discovery=await fetch(base+'/v1/models',{headers:{Authorization:'Bearer '+secret}});assert.equal(discovery.status,200);await discovery.text();
 const pending=fetch(base+'/v1/images/generations',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify({model:'flux2-klein',prompt:'x'}),signal:controller.signal});
 const rejected=assert.rejects(pending);await until(()=>c.status().queued===1);controller.abort();await rejected;
 await until(()=>c.status().queued===0&&store.preparedBytes===0);await c.release(hold.token);assert.deepEqual(backend.calls,[]);assert.equal(store.snapshot().active,0);
});
