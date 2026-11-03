import test from 'node:test';
import assert from 'node:assert/strict';
import {EngineScheduling} from '../lib/engine-scheduling.mjs';
import {Coordinator,pause} from '../lib/core.mjs';
const job=(engine,enqueuedAt=0)=>({engine,enqueuedAt});
test('loaded engine is reused with FIFO inside its batch and no artificial hold',()=>{
 const s=new EngineScheduling(),media=job('anima'),a=job('llm',1),b=job('llm',2);
 s.granted('llm',0);
 assert.equal(s.choose([media,b,a],'llm',3).request,a);
 assert.equal(s.choose([media],'llm',3).request,media);
 assert.equal(s.choose([],'llm',3).request,null);
});
test('request count, turn duration and waiting age independently yield to other engines',()=>{
 for(const [now,count,queuedAt,reason] of [[1,4,0,'batch_request_limit'],[120,2,0,'batch_time_limit'],[120,1,0,'batch_time_limit'],[1,2,-300,'waiting_engine_aged']]){
  const s=new EngineScheduling();for(let i=0;i<count;i++)s.granted('llm',0);
  const other=job('wan',queuedAt);
  assert.deepEqual(s.choose([other,job('llm')],'llm',now),{request:other,reason});
 }
});
test('aged queues do not cause one-request engine ping-pong; next turn starts after loading',()=>{
 const s=new EngineScheduling(),old=job('llm',0),same=job('anima',1);
 s.granted('llm',0);s.granted('anima',400);
 assert.equal(s.choose([old,same],'anima',401).request,same);
 s.granted('anima',401);
 assert.equal(s.choose([old,same],'anima',402).request,old);
 assert.equal(s.turn.startedAt,400);
 assert.throws(()=>new EngineScheduling({minBatchRequests:5,maxBatchRequests:4}));
 assert.throws(()=>new EngineScheduling({maxWaitSeconds:NaN}));
});
test('alternating work is grouped per runtime; engines sharing one keep FIFO as a single batch',async()=>{
 // H3 and Anima share the ComfyUI runtime; tts and qwen-image each have their own.
 const models=['llm','qwen-image','anima','h3','tts'],order=[],switches=[];
 const backend={models:Object.fromEntries(models.map(m=>[m,[]])),async ensure(model){if(switches.at(-1)!==model)switches.push(model);},async idle(){return true;}};
 const c=new Coordinator(backend),hold=await c.acquire('llm',{timeout:3,exclusive:true});
 const input=['anima','llm','h3','anima','tts','h3','qwen-image','tts','qwen-image'];
 const pending=input.map((model,index)=>c.acquire(model,{timeout:4,exclusive:model==='llm'}).then(async ticket=>{order.push([model,index]);await c.release(ticket.token);}));
 await pause(10);await c.release(hold.token);await Promise.all(pending);
 assert.deepEqual(order.map(([m])=>m),['llm','anima','h3','anima','h3','tts','tts','qwen-image','qwen-image']);
 assert.deepEqual(switches,['llm','anima','h3','anima','h3','tts','qwen-image']);
 for(const model of models){const indices=order.filter(([m])=>m===model).map(([,i])=>i);assert.deepEqual(indices,[...indices].sort((a,b)=>a-b));}
});
test('a sibling engine on the loaded runtime is reuse, and the batch counts the runtime',()=>{
 const runtime={h3:'comfy',anima:'comfy','fish-drama3':'audiocpp','qwen3-asr':'audiocpp'};
 const s=new EngineScheduling({},{groupOf:engine=>runtime[engine]}),sibling=job('anima',5),other=job('llm',0);
 s.granted('h3',0);
 // The older llm request waits: anima runs in the ComfyUI process that is already loaded.
 assert.deepEqual(s.choose([other,sibling],'h3',1),{request:sibling,reason:'minimum_engine_batch'});
 s.granted('anima',1);assert.equal(s.turn.requests,2);assert.equal(s.turn.runtime,'comfy');
 s.granted('anima',2);s.granted('h3',3);
 assert.deepEqual(s.choose([other,job('h3',6)],'h3',4),{request:other,reason:'batch_request_limit'});
 assert.equal(s.status([job('qwen3-asr',1)],'fish-drama3',4).reason,'reuse_only_waiting_engine');
 assert.equal(s.status([job('qwen3-asr',1)],'fish-drama3',4).next_runtime,'audiocpp');
});
test('batch limit drains active shared leases before switching; busy lease stays protected',async()=>{
 let busy=false;const calls=[],backend={models:{llm:[],anima:[]},async ensure(m){calls.push(m);},async idle(){return !busy;}};
 const c=new Coordinator(backend,{engineScheduling:{minBatchRequests:1,maxBatchRequests:2}});
 const a=await c.acquire('llm',{timeout:3}),b=await c.acquire('llm',{timeout:3}),order=[];
 const other=c.acquire('anima',{timeout:3}).then(async ticket=>{order.push('anima');await c.release(ticket.token);});
 const same=c.acquire('llm',{timeout:3}).then(async ticket=>{order.push('llm');await c.release(ticket.token);});
 await pause(20);assert.equal(c.status().queued,2);assert.equal(c.status().engine_scheduling.reason,'batch_request_limit');
 await c.release(a.token);busy=true;await assert.rejects(c.release(b.token),/busy/);await pause(20);assert.deepEqual(calls,['llm']);
 busy=false;await c.release(b.token);await Promise.all([other,same]);assert.deepEqual(order,['anima','llm']);
});
test('ui.works categories are validated against what the package provides',async()=>{
  const {validatePackage}=await import('../lib/registry.mjs');
  const pkg=works=>({file:'engine.json',manifest:{category:'audio',platform:{engine:'demo',runtime:{id:'r',name:'r',port:1,container:'c',launch:['x']},ui:{name:'D',description:'d',symbol:'D',accent:'#fff',panel:'media',works},models:[{id:'demo',capabilities:['speech.synthesize','speech.voice']}]}}});
  validatePackage(pkg([{id:'works',label:'作品',capabilities:['speech.synthesize'],kinds:['audio']},{id:'voices',label:'音色',view:'voices',capabilities:['speech.voice']}]));
  assert.throws(()=>validatePackage(pkg([{id:'tasks',label:'x',capabilities:['speech.voice']}])),/unique lowercase id/);
  assert.throws(()=>validatePackage(pkg([{id:'a',label:'x',capabilities:['image.generate']}])),/capabilities this engine provides/);
  assert.throws(()=>validatePackage(pkg([{id:'a',label:'x',view:'grid',capabilities:['speech.voice']}])),/view must be/);
  assert.throws(()=>validatePackage(pkg([{id:'a',label:'x',capabilities:['speech.voice'],kinds:['pdf']}])),/kinds must list/);
});
