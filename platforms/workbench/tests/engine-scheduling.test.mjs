import test from 'node:test';
import assert from 'node:assert/strict';
import {EngineScheduling} from '../lib/engine-scheduling.mjs';
import {Coordinator,pause} from '../lib/core.mjs';
const job=(engine,enqueuedAt=0)=>({engine,enqueuedAt});
test('loaded engine is reused with FIFO inside its batch and no artificial hold',()=>{
 const s=new EngineScheduling(),media=job('flux'),a=job('llm',1),b=job('llm',2);
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
 const s=new EngineScheduling(),old=job('llm',0),same=job('flux',1);
 s.granted('llm',0);s.granted('flux',400);
 assert.equal(s.choose([old,same],'flux',401).request,same);
 s.granted('flux',401);
 assert.equal(s.choose([old,same],'flux',402).request,old);
 assert.equal(s.turn.startedAt,400);
 assert.throws(()=>new EngineScheduling({minBatchRequests:5,maxBatchRequests:4}));
 assert.throws(()=>new EngineScheduling({maxWaitSeconds:NaN}));
});
test('all five engines group alternating work while preserving each engine FIFO',async()=>{
 const models=['llm','qwen-image','flux','h3','wan'],order=[],switches=[];
 const backend={models:Object.fromEntries(models.map(m=>[m,[]])),async ensure(model){if(switches.at(-1)!==model)switches.push(model);},async idle(){return true;}};
 const c=new Coordinator(backend),hold=await c.acquire('llm',{timeout:3,exclusive:true});
 const input=['flux','llm','h3','flux','wan','h3','qwen-image','wan','qwen-image'];
 const pending=input.map((model,index)=>c.acquire(model,{timeout:4,exclusive:model==='llm'}).then(async ticket=>{order.push([model,index]);await c.release(ticket.token);}));
 await pause(10);await c.release(hold.token);await Promise.all(pending);
 assert.deepEqual(order.map(([m])=>m),['llm','flux','flux','h3','h3','wan','wan','qwen-image','qwen-image']);
 assert.deepEqual(switches,['llm','flux','h3','wan','qwen-image']);
 for(const model of models){const indices=order.filter(([m])=>m===model).map(([,i])=>i);assert.deepEqual(indices,[...indices].sort((a,b)=>a-b));}
});
test('batch limit drains active shared leases before switching; busy lease stays protected',async()=>{
 let busy=false;const calls=[],backend={models:{llm:[],flux:[]},async ensure(m){calls.push(m);},async idle(){return !busy;}};
 const c=new Coordinator(backend,{engineScheduling:{minBatchRequests:1,maxBatchRequests:2}});
 const a=await c.acquire('llm',{timeout:3}),b=await c.acquire('llm',{timeout:3}),order=[];
 const other=c.acquire('flux',{timeout:3}).then(async ticket=>{order.push('flux');await c.release(ticket.token);});
 const same=c.acquire('llm',{timeout:3}).then(async ticket=>{order.push('llm');await c.release(ticket.token);});
 await pause(20);assert.equal(c.status().queued,2);assert.equal(c.status().engine_scheduling.reason,'batch_request_limit');
 await c.release(a.token);busy=true;await assert.rejects(c.release(b.token),/busy/);await pause(20);assert.deepEqual(calls,['llm']);
 busy=false;await c.release(b.token);await Promise.all([other,same]);assert.deepEqual(order,['flux','llm']);
});
