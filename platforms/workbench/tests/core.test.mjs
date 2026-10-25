import test from 'node:test';
import assert from 'node:assert/strict';
import {Coordinator,pause} from '../lib/core.mjs';
function fake(){return {models:{llm:[],media:[]},calls:[],busy:false,async ensure(model){this.calls.push(model);},async idle(){return !this.busy;}};}
test('loaded LLM batches a later shared request before switching to waiting media',async()=>{
  const b=fake(),c=new Coordinator(b),first=await c.acquire('llm',{timeout:2}),order=[];
  const media=c.acquire('media',{timeout:2}).then(async t=>{order.push('media');await c.release(t.token);});await pause(10);
  const llm=c.acquire('llm',{timeout:2}).then(async t=>{order.push('llm');await c.release(t.token);});await pause(20);
  assert.deepEqual(b.calls,['llm']);assert.equal(c.status().queued,1);assert.deepEqual(order,['llm']);await c.release(first.token);await Promise.all([media,llm]);assert.deepEqual(order,['llm','media']);
});
test('shared leases avoid reload and final busy lease is retained',async()=>{
  const b=fake(),c=new Coordinator(b),a=await c.acquire('llm',{timeout:2}),d=await c.acquire('llm',{timeout:2,profileId:'qwen38-27b-128k'});assert.deepEqual(b.calls,['llm']);b.busy=true;
  await c.release(a.token);await assert.rejects(c.release(d.token),/still busy/);assert.equal(c.status().active_leases,1);b.busy=false;await c.release(d.token);
});
test('expired busy ownership cannot be reclaimed',async()=>{
  const b=fake();let now=0;const c=new Coordinator(b,{clock:()=>now,leaseSeconds:1}),a=await c.acquire('media');now=2;b.busy=true;await c.recover();assert.equal(c.status().leased,true);
  b.busy=false;await c.recover();assert.equal(c.status().leased,false);await assert.rejects(c.release(a.token),/Invalid/);
});
test('renewal during idle check prevents expired ownership reclamation',async()=>{
  const b=fake();let now=0;const c=new Coordinator(b,{clock:()=>now,leaseSeconds:1}),a=await c.acquire('llm',{exclusive:true});now=2;
  b.idle=async()=>{c.renew(a.token);return true;};await c.recover();assert.equal(c.status().leased,true);
});
test('queue timeout removes ticket and preserves ownership',async()=>{
  const c=new Coordinator(fake()),a=await c.acquire('media');await assert.rejects(c.acquire('llm',{timeout:.03,exclusive:true}),/timeout/);assert.equal(c.status().queued,0);assert.equal(c.status().leased,true);await c.release(a.token);
});
test('failed load clears target and queue, allows subsequent acquisition',async()=>{
  const b=fake(),c=new Coordinator(b);b.ensure=async()=>{assert.equal(c.status().switching_target,'media');throw new Error('load failed');};await assert.rejects(c.acquire('media'),/load failed/);assert.equal(c.status().queued,0);assert.equal(c.status().switching_target,null);assert.equal(c.status().leased,false);b.ensure=async()=>{};await c.release((await c.acquire('llm',{exclusive:true})).token);
});
test('shared limit queues additional requests',async()=>{
  const c=new Coordinator(fake(),{sharedLimit:1}),a=await c.acquire('llm',{timeout:2}),pending=c.acquire('llm',{timeout:2});await pause(20);assert.equal(c.status().queued,1);await c.release(a.token);await c.release((await pending).token);
});
test('unknown models and tokens cannot change ownership',async()=>{
  const c=new Coordinator(fake());await assert.rejects(c.acquire('__proto__'),/Unknown/);const a=await c.acquire('media');assert.throws(()=>c.renew('wrong'),/Invalid/);await assert.rejects(c.release('wrong'),/Invalid/);assert.equal(c.status().leased,true);await c.release(a.token);
});
test('different public profiles share one unified backend without reload',async()=>{
 const b=fake(),c=new Coordinator(b),a=await c.acquire('llm',{timeout:2}),second=await c.acquire('llm',{timeout:2,profileId:'qwen38-27b-65k-8way'});
 assert.equal(c.status().active_leases,2);assert.deepEqual(b.calls,['llm']);assert.equal(c.status().llm_mode,'196608:2:bf16:8589934592:graph');
 await c.release(a.token);await c.release(second.token);
});
test('configuration drains leases and rejects new requests before loading selected limits',async()=>{
 const b=fake(),c=new Coordinator(b),a=await c.acquire('llm',{timeout:2}),second=await c.acquire('llm',{timeout:2});
 let loaded;b.ensure=async(model,deadline,clock,policy)=>{loaded=policy;b.calls.push(model);};
 const switching=c.selectLlmMode('throughput');await pause(20);
 assert.equal(c.modeSwitch.phase,'draining');assert.equal(loaded,undefined);
 await assert.rejects(c.acquire('llm',{timeout:2}),/in progress/);
 await c.release(a.token);assert.equal(loaded,undefined);await c.release(second.token);
 await switching;assert.equal(loaded.context_tokens,65536);assert.equal(loaded.concurrency,8);
 assert.equal(loaded.kv_budget_bytes,8859648000);assert.equal(c.pendingLlmMode,null);
 const ticket=await c.acquire('llm',{timeout:2});await c.release(ticket.token);
});
test('a final release racing with new shared requests frees its slot',async()=>{
 const b=fake(),c=new Coordinator(b);await c.selectLlmMode('throughput');const first=await c.acquire('llm',{timeout:2,profileId:'qwen38-27b-65k-8way'});
 let finishIdle;
 b.idle=()=>new Promise(resolve=>{finishIdle=resolve;});
 const releasing=c.release(first.token);
 const tickets=[];for(let i=0;i<7;i++)tickets.push(await c.acquire('llm',{timeout:2,profileId:'qwen38-27b-65k-8way'}));
 finishIdle(true);await releasing;
 assert.equal(c.status().llm_slots['64k'],7);
 tickets.push(await c.acquire('llm',{timeout:.2,profileId:'qwen38-27b-65k-8way'}));
 assert.equal(c.status().active_leases,8);
 b.idle=async()=>true;for(const ticket of tickets)await c.release(ticket.token);
});
test('failed engine restart does not publish or save the new policy',async()=>{
 const b=fake(),c=new Coordinator(b);let persisted=false;
 b.ensure=async()=>{throw Error('engine failed');};c.onModeSelected=async()=>{persisted=true;};
 await assert.rejects(c.selectLlmMode('long-single'),/engine failed/);
 assert.equal(c.policy.context_tokens,196608);assert.equal(persisted,false);
 assert.equal(c.switching,false);assert.equal(c.modeSwitch.phase,'error');c.assertAcceptingRequests();
});
test('custom overbudget policies retain fixed KV and load the requested engine',async()=>{
 const b=fake();b.capacityTokens=390000;const c=new Coordinator(b);let persisted;
 c.onModeSelected=async(mode,policy)=>{persisted=policy;};
 const result=await c.selectLlmMode('custom',262144,8);
 assert.equal(result.budget.risk,true);assert.equal(persisted.kv_budget_bytes,8589934592);assert.deepEqual(b.calls,['llm']);
 await assert.rejects(c.selectLlmMode('custom',262145,8),/Context/);
 await assert.rejects(c.selectLlmMode('custom',65536,9),/Concurrency/);
});
test('duplicate policy writes are blocked; failed persistence preserves old policy',async()=>{
 const c=new Coordinator(fake());let finish;c.onModeSelected=()=>new Promise(r=>finish=r);
 const pending=c.selectLlmMode('throughput');assert.throws(()=>c.assertAcceptingRequests(),/in progress/);
 await assert.rejects(c.selectLlmMode('long-single'),/already in progress/);finish();await pending;
 c.onModeSelected=async()=>{throw Error('disk failed');};await assert.rejects(c.selectLlmMode('long'),/disk failed/);
 assert.equal(c.policy.context_tokens,65536);c.assertAcceptingRequests();
});
test('KV reservations wait for actual capacity and are released with leases',async()=>{
 const b=fake();b.capacityTokens=100;const c=new Coordinator(b),a=await c.acquire('llm',{timeout:2}),d=await c.acquire('llm',{timeout:2});
 await c.reserveTokens(a.token,70);let acquired=false;const waiting=c.reserveTokens(d.token,50,.5).then(()=>{acquired=true;});await pause(20);assert.equal(acquired,false);
 await c.release(a.token);await waiting;assert.equal(acquired,true);assert.equal(c.owner.reservations.get(d.token),50);
 await assert.rejects(c.reserveTokens(d.token,101),/capacity/);await c.release(d.token);
});

test('disconnected GPU waiters leave the queue without starting another engine',async()=>{
 const backend=fake(),c=new Coordinator(backend),owner=await c.acquire('media');
 const controller=new AbortController(),pending=c.acquire('llm',{timeout:5,signal:controller.signal});
 await pause(10);controller.abort();await assert.rejects(pending,{code:'CLIENT_REQUEST_CANCELLED'});
 assert.equal(c.status().queued,0);assert.deepEqual(backend.calls,['media']);assert.equal(c.status().active_leases,1);
 await c.release(owner.token);
});
test('TTS shares one resident model up to its topology concurrency; other media stays exclusive',async()=>{
  const b=fake();b.models.tts=[];const c=new Coordinator(b,{sharedEngines:{tts:3}});
  const leases=await Promise.all([1,2,3].map(()=>c.acquire('tts',{timeout:2})));
  assert.equal(c.status().active_leases,3);assert.deepEqual(b.calls,['tts']);
  let fourth=null;const pending=c.acquire('tts',{timeout:2}).then(t=>fourth=t);await pause(20);assert.equal(fourth,null);assert.equal(c.status().queued,1);
  await c.release(leases[0].token);await pending;assert.equal(c.status().active_leases,3);
  for(const t of [...leases.slice(1),fourth])await c.release(t.token);assert.equal(c.status().leased,false);
  const m=await c.acquire('media',{timeout:2});let second=null;const queued=c.acquire('media',{timeout:2}).then(t=>second=t);await pause(20);
  assert.equal(second,null);await c.release(m.token);await c.release((await queued).token);
});
