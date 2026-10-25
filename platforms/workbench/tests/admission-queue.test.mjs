import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {AccessKeys,secureApi} from '../lib/access-keys.mjs';
import {Coordinator,pause} from '../lib/core.mjs';
import {enginePolicyKey} from '../lib/llm.mjs';
async function fixture(t,limits={}){
 const dir=await mkdtemp(join(tmpdir(),'admission-queue-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await AccessKeys.open(join(dir,'keys.json'));
 const created=await store.mutate({action:'create',name:'share',maxConcurrent:1,maxQueued:8,requestsPerMinute:300,...limits});
 return {store,key:store.authenticate('Bearer '+created.secret),secret:created.secret};
}
async function listen(t,handler){
 const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 return 'http://127.0.0.1:'+server.address().port;
}
const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};};
async function until(check){for(let i=0;i<100;i++){if(check())return;await pause(10);}assert.ok(check(),'expected state was not reached');}
test('shared key queues a burst across every engine without exceeding its execution limit',async t=>{
 const {store,secret}=await fixture(t);t.mock.method(console,'info',()=>{});
 const first=gate(),entered=gate(),order=[];let running=0,peak=0;
 const backend={models:{llm:[],flux:[],'qwen-image':[],h3:[],wan:[]},async ensure(){},async idle(){return true;}};
 const c=new Coordinator(backend);
 const base=await listen(t,secureApi(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const {model}=JSON.parse(raw);
  const ticket=await c.acquire(model,2,model==='llm');running++;peak=Math.max(peak,running);order.push(model);
  try{if(order.length===1){entered.resolve();await first.promise;}res.end(model);}
  finally{running--;await c.release(ticket.token);}
 },store));
 const paths={llm:'/v1/chat/completions',flux:'/v1/images/generations','qwen-image':'/v1/images/edits',h3:'/v1/videos/generations',wan:'/v1/videos/generations'},requests=[];
 t.after(()=>first.resolve());
 for(const [model,path] of Object.entries(paths)){
  requests.push(fetch(base+path,{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify({model})}));
  if(requests.length===1)await entered.promise;else await until(()=>store.queue.length===requests.length-1);
 }
 assert.equal(store.snapshot().active,1);assert.equal(store.snapshot().queued,4);assert.equal(store.snapshot().keys[0].queued,4);
 first.resolve();const responses=await Promise.all(requests);
 assert.ok(responses.every(response=>response.status===200));assert.deepEqual(await Promise.all(responses.map(r=>r.text())),Object.keys(paths));
 await until(()=>store.active===0);assert.equal(store.queue.length,0);assert.equal(peak,1);assert.deepEqual(order,Object.keys(paths));
});
test('key and global queues have distinct overflow codes',async t=>{
 const {store,key}=await fixture(t,{maxQueued:1});const release=store.admit(key),pending=store.waitForAdmission(key);
 assert.equal(store.queue.length,1);await assert.rejects(store.waitForAdmission(key),{code:'API_KEY_QUEUE_FULL'});
 release();(await pending)();assert.equal(store.active,0);
 await store.mutate({action:'settings',maxConcurrent:1,maxQueued:1});
 const b=await store.mutate({action:'create',name:'Bob'}),bk=store.authenticate('Bearer '+b.secret),hold=store.admit(key),wait=store.waitForAdmission(bk);
 await assert.rejects(store.waitForAdmission(key),{code:'GLOBAL_QUEUE_FULL'});
 hold();(await wait)();assert.equal(store.queue.length,0);
});
test('oldest eligible key proceeds without blocked-key head of line stalls',async t=>{
 const {store,key}=await fixture(t);await store.mutate({action:'settings',maxConcurrent:2});
 const b=await store.mutate({action:'create',name:'Bob'}),bk=store.authenticate('Bearer '+b.secret);
 const aRelease=store.admit(key),bRelease=store.admit(bk),order=[];
 const a1=store.waitForAdmission(key).then(release=>{order.push('a1');return release;});
 const a2=store.waitForAdmission(key).then(release=>{order.push('a2');return release;});
 const b1=store.waitForAdmission(bk).then(release=>{order.push('b1');return release;});
 bRelease();const releaseB1=await b1;assert.deepEqual(order,['b1']);
 aRelease();const releaseA1=await a1;assert.deepEqual(order,['b1','a1']);
 releaseA1();const releaseA2=await a2;assert.deepEqual(order,['b1','a1','a2']);
 releaseA2();releaseB1();assert.equal(store.active,0);
});
test('queued requests expire, cancel and are removed immediately on revocation',async t=>{
 const {store,key}=await fixture(t);await store.mutate({action:'settings',queueWaitSeconds:1});
 const hold=store.admit(key);await assert.rejects(store.waitForAdmission(key),{code:'ADMISSION_QUEUE_WAIT_TIMEOUT'});assert.equal(store.queue.length,0);
 const controller=new AbortController(),cancelled=store.waitForAdmission(key,{signal:controller.signal});controller.abort();
 await assert.rejects(cancelled,{code:'CLIENT_REQUEST_CANCELLED'});assert.equal(store.queue.length,0);
 const revoked=store.waitForAdmission(key),check=assert.rejects(revoked,{code:'API_KEY_INVALID'});
 await store.mutate({action:'update',id:key.id,enabled:false});await check;
 assert.equal(store.queue.length,0);hold();assert.equal(store.active,0);
});
test('changed concurrency promotes waiters; queue settings persist and validate',async t=>{
 const {store,key}=await fixture(t);const hold=store.admit(key),waiting=store.waitForAdmission(key);
 await store.mutate({action:'update',id:key.id,maxConcurrent:2,maxQueued:3});const release=await waiting;
 assert.equal(store.active,2);assert.equal(store.queue.length,0);release();hold();
 await store.mutate({action:'settings',maxQueued:256,queueWaitSeconds:120});
 const reopened=await AccessKeys.open(store.file);assert.equal(reopened.state.settings.maxQueued,256);assert.equal(reopened.state.settings.queueWaitSeconds,120);assert.equal(reopened.state.keys[0].maxQueued,3);
 await assert.rejects(store.mutate({action:'settings',maxQueued:257}));await assert.rejects(store.mutate({action:'update',id:key.id,maxQueued:-1}));
});
test('legacy stores gain queue defaults without raising concurrent execution',async t=>{
 const {store}=await fixture(t);const state=JSON.parse(await readFile(store.file,'utf8'));
 delete state.settings.maxQueued;delete state.settings.queueWaitSeconds;delete state.keys[0].maxQueued;
 await writeFile(store.file,JSON.stringify(state));const reopened=await AccessKeys.open(store.file);
 assert.equal(reopened.state.keys[0].maxConcurrent,1);assert.equal(reopened.state.keys[0].maxQueued,8);assert.equal(reopened.state.settings.maxQueued,32);assert.equal(reopened.state.settings.queueWaitSeconds,900);
});
test('HTTP disconnect removes queued work before backend execution; discovery stays responsive',async t=>{
 const {store,key,secret}=await fixture(t);t.mock.method(console,'info',()=>{});const hold=store.admit(key);let calls=0;
 const base=await listen(t,secureApi(async(req,res)=>{calls++;res.end('ok');},store)),headers={Authorization:'Bearer '+secret},controller=new AbortController();
 const pending=fetch(base+'/v1/videos/generations',{method:'POST',headers,body:'{}',signal:controller.signal}),check=assert.rejects(pending);
 await until(()=>store.queue.length===1);
 const discovery=await fetch(base+'/v1/models',{headers});assert.equal(discovery.status,200);await discovery.text();
 assert.equal(store.active,1);assert.equal(store.queue.length,1);assert.equal(calls,1);
 controller.abort();await check;await until(()=>store.queue.length===0);hold();await pause(20);assert.equal(calls,1);assert.equal(store.active,0);
});
test('rate limits are rechecked at promotion and rejection never leaks execution slots',async t=>{
 const {store,key}=await fixture(t,{requestsPerMinute:1});const hold=store.admit(key),waiting=store.waitForAdmission(key);
 const check=assert.rejects(waiting,{code:'API_KEY_REQUEST_RATE_LIMIT_EXCEEDED'});hold();await check;
 assert.equal(store.active,0);assert.equal(store.queue.length,0);assert.equal(store.snapshot().keys[0].requests,1);
});

test('disconnect during generation cannot promote queued work until backend completion',async t=>{
 const {store,secret}=await fixture(t);t.mock.method(console,'info',()=>{});
 const backendDone=gate();t.after(()=>backendDone.resolve());let started=0;
 const base=await listen(t,secureApi(async(req,res)=>{
  started++;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: started\n\n');
  if(started===1)await backendDone.promise;if(!res.destroyed)res.end('data: [DONE]\n\n');
 },store));
 const headers={Authorization:'Bearer '+secret},first=await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:'{}'}),reader=first.body.getReader();await reader.read();
 const next=fetch(base+'/v1/videos/generations',{method:'POST',headers,body:'{}'});await until(()=>store.queue.length===1);
 await reader.cancel();await pause(30);assert.equal(started,1);assert.equal(store.active,1);assert.equal(store.queue.length,1);
 backendDone.resolve();const response=await next;assert.equal(response.status,200);await response.text();await until(()=>store.active===0);assert.equal(started,2);assert.equal(store.queue.length,0);
});

test('production HTTP admission batches mixed engines with share concurrency one',async t=>{
 const {handlers}=await import('../lib/http.mjs'),{Metrics}=await import('../lib/metrics.mjs');
 const {store,secret}=await fixture(t);t.mock.method(console,'info',()=>{});
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
 for(const model of ['flux','llm','qwen-image','flux','llm','qwen-image','llm','llm']){requests.push(submit(model));await until(()=>store.queue.length===requests.length-1);}
 assert.equal(store.active,1);assert.equal(c.status().active_leases,1);
 assert.deepEqual(c.status().engine_scheduling.admission.waiting_by_engine,{flux:2,llm:4,'qwen-image':2});
 first.resolve();const responses=await Promise.all(requests);assert.ok(responses.every(r=>r.status===200));
 await Promise.all(responses.map(r=>r.json()));await until(()=>store.active===0&&store.preparedBytes===0);
 assert.deepEqual(order,['llm','llm','llm','llm','flux','flux','qwen-image','qwen-image','llm']);assert.deepEqual(switches,['llm','flux','qwen-image','llm']);
 assert.equal(c.status().active_leases,0);assert.equal(store.preparing.size,0);
});
test('prepared request bodies have a global byte bound and idempotent cleanup',async t=>{
 const {store,key}=await fixture(t),a=store.reservePreparation(key,32*2**20),b=store.reservePreparation(key,undefined);
 assert.equal(store.snapshot().prepared_body_bytes,64*2**20);
 assert.throws(()=>store.reservePreparation(key,1),{code:'ADMISSION_BODY_BUDGET_EXCEEDED'});
 a();a();b();assert.equal(store.preparedBytes,0);assert.equal(store.preparing.size,0);
});
test('deferred HTTP admission cancels before generation and releases prepared body budget',async t=>{
 const {handlers}=await import('../lib/http.mjs'),{Metrics}=await import('../lib/metrics.mjs');
 const {store,key,secret}=await fixture(t),calls=[],c=new Coordinator({models:{flux:[]},async ensure(m){calls.push(m);},async idle(){return true;}});
 t.mock.method(console,'info',()=>{});t.mock.method(console,'warn',()=>{});
 const hold=store.admit(key),base=await listen(t,secureApi(handlers(c,new Metrics(),{draining:false}).api,store,{coordinator:c})),controller=new AbortController();
 const pending=fetch(base+'/v1/images/generations',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify({model:'flux2-klein',prompt:'x'}),signal:controller.signal});
 const rejected=assert.rejects(pending);await until(()=>store.queue.length===1);controller.abort();await rejected;
 await until(()=>store.queue.length===0&&store.preparedBytes===0);hold();assert.deepEqual(calls,[]);assert.equal(store.active,0);
});
