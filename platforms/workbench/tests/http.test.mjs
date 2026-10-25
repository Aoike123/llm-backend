import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Coordinator,pause} from '../lib/core.mjs';
import {Metrics} from '../lib/metrics.mjs';
import {handlers} from '../lib/http.mjs';
async function listen(handler){const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));return {server,base:'http://127.0.0.1:'+server.address().port};}
async function close(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
async function setup(options={}){
 const backend={models:{llm:[],flux:[],h3:[],'qwen-image':[]},calls:[],async ensure(m){this.calls.push(m);},async idle(){return true;},async residency(){return {enabled:false,llm:'cold'};}};
 const c=new Coordinator(backend),metrics=new Metrics(),lifecycle={draining:false},h=handlers(c,metrics,lifecycle,options),api=await listen(h.api),control=await listen(h.control);return {backend,c,metrics,lifecycle,api,control,async close(){await close(api.server);await close(control.server);}};
}
const post=(base,path,data,headers={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
test('switch logs show target settings and hide the previous engine startup',async()=>{
 const s=await setup();let id='old';
 s.backend.engineLogs=async()=>({container_id:id,startup_output:'startup '+id,startup_complete:id==='old',available:true});
 try{
  s.c.pendingLlmMode='custom';s.c.modeSwitch={phase:'draining',previous_container:'old',policy:{context_tokens:65536,concurrency:4},events:[]};
  const logs=async()=>(await(await fetch(s.api.base+'/api/engine-logs')).json());
  let result=await logs();assert.equal(result.model,'llm');assert.equal(result.target_policy.concurrency,4);assert.equal(result.startup_output,null);assert.equal(result.switching,true);
  s.c.modeSwitch.phase='loading';result=await logs();assert.equal(result.startup_output,null);
  id='new';result=await logs();assert.equal(result.startup_output,'startup new');assert.equal(result.startup_complete,false);
 }finally{await s.close();}
});

test('service log browsing cannot load an engine or inherit another service switch events',async()=>{
 const s=await setup(),seen=[];
 s.backend.engineLogs=async model=>{seen.push(model);return {available:true,output:'logs '+model,startup_output:'startup '+model};};
 try{
  s.c.current='llm';s.c.pendingLlmMode='custom';s.c.modeSwitch={phase:'draining',policy:{context_tokens:65536},events:[{message:'LLM switching'}]};
  const response=await fetch(s.api.base+'/api/engine-logs?model=flux');assert.equal(response.status,200);
  const logs=await response.json();assert.equal(logs.model,'flux');assert.equal(logs.current_model,'llm');assert.equal(logs.switching,false);assert.equal(logs.policy,null);assert.deepEqual(logs.events,[]);assert.equal(logs.startup_output,'startup flux');
  assert.equal((await fetch(s.api.base+'/api/engine-logs?model=tts')).status,200);assert.equal((await fetch(s.api.base+'/data?model=tts')).status,200);
  assert.equal((await fetch(s.api.base+'/api/engine-logs?model=unknown')).status,400);
  assert.equal((await fetch(s.api.base+'/data?model=unknown')).status,400);
  assert.deepEqual(seen,['flux','tts']);assert.deepEqual(s.backend.calls,[]);assert.equal(s.c.status().leased,false);
 }finally{await s.close();}
});
test('invalid model never starts GPU; nonlocal Origin rejected',async()=>{
 const s=await setup();try{assert.equal((await post(s.api.base,'/v1/chat/completions',{model:'wrong'})).status,400);assert.deepEqual(s.backend.calls,[]);assert.deepEqual(s.metrics.active,{});assert.equal((await post(s.api.base,'/api/switch',{model:'llm'},{Origin:'https://evil.example'})).status,403);assert.equal((await post(s.control.base,'/acquire',{model:'llm'},{Origin:'http://localhost:13000'})).status,403);}finally{await s.close();}
});
test('SSE forwards first chunk before completion and retains GPU ownership',async()=>{
 let finish;const gate=new Promise(r=>finish=r);const upstream=await listen(async(req,res)=>{for await(const chunk of req){}if(req.url==='/tokenize'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({count:8}));}res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: hello\n\n');await gate;res.end('data: [DONE]\n\n');});
 const s=await setup({llmBase:upstream.base});try{
 const response=await post(s.api.base,'/v1/chat/completions',{model:'qwen38-27b-w3a4',messages:[{role:'user',content:'x'}],stream:true});const reader=response.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/hello/);assert.equal(s.c.status().leased,true);finish();let rest='';while(true){const next=await reader.read();if(next.done)break;rest+=new TextDecoder().decode(next.value);}assert.match(rest,/DONE/);for(let i=0;i<50&&s.c.status().leased;i++)await pause(10);assert.equal(s.c.status().leased,false);assert.equal(s.metrics.active.llm,0);
 }finally{finish();await s.close();await close(upstream.server);}
});
test('disconnected stream keeps ownership until upstream completion',async()=>{
 let finish;const gate=new Promise(r=>finish=r);const upstream=await listen(async(req,res)=>{for await(const chunk of req){}if(req.url==='/tokenize'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({count:8}));}res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: hello\n\n');await gate;res.end('data: [DONE]\n\n');});const s=await setup({llmBase:upstream.base});
 try{const controller=new AbortController();const r=await fetch(s.api.base+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'qwen38-27b-w3a4',messages:[{}],stream:true}),signal:controller.signal});await r.body.getReader().read();controller.abort();await pause(30);assert.equal(s.c.status().leased,true);finish();for(let i=0;i<100&&s.c.status().leased;i++)await pause(10);assert.equal(s.c.status().leased,false);assert.equal(s.metrics.state.recent.at(-1).outcome,'disconnected');}finally{finish();await s.close();await close(upstream.server);}
});
test('draining rejects new work; status and model catalog stay available',async()=>{
 const s=await setup();try{s.lifecycle.draining=true;assert.equal((await post(s.control.base,'/acquire',{model:'llm'})).status,503);assert.equal((await post(s.api.base,'/api/switch',{model:'llm'})).status,503);assert.equal((await fetch(s.api.base+'/status')).status,200);assert.equal((await (await fetch(s.api.base+'/v1/models')).json()).data.length,1);assert.equal((await fetch(s.api.base+'/data?minutes=999')).status,400);}finally{await s.close();}
});

test('browser switch endpoint is removed and cannot acquire GPU',async()=>{
 const s=await setup();try{assert.equal((await post(s.api.base,'/api/switch',{model:'llm'})).status,404);assert.deepEqual(s.backend.calls,[]);assert.equal(s.c.status().leased,false);}finally{await s.close();}
});
test('model catalog advertises profiles and token limits reject oversized short-slot prompts',async()=>{
 let sent;
 const upstream=await listen(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;res.setHeader('Content-Type','application/json');
 if(req.url==='/tokenize')return res.end(JSON.stringify({count:196550}));sent=JSON.parse(raw);res.end(JSON.stringify({model:sent.model,choices:[]}));});
 const s=await setup({llmBase:upstream.base});try{
 const catalog=(await (await fetch(s.api.base+'/v1/models')).json()).data;
 assert.deepEqual(catalog.map(m=>m.id),['qwen38-27b-w3a4']);
 assert.ok(catalog.every(m=>m.tasks.length===1&&m.tasks[0]==='chat'));
 assert.deepEqual(catalog.map(m=>m.contextWindow),[196608]);
 assert.ok(catalog.every(m=>m.context_length===m.max_model_len&&m.inputModalities.includes('image')&&m.input.includes('image')));
 const media=(await (await fetch(s.api.base+'/v1/media/models')).json()).data;
 assert.deepEqual(media.map(m=>m.id),['qwen-image21','flux2-klein','minimax-h3','cosyvoice3-rl']);
 assert.deepEqual(media.map(m=>m.tasks[0]),['image','image','video','audio']);
 assert.ok(media.every(m=>!m.tasks.includes('chat')));
 assert.deepEqual(s.backend.calls,[]);
 assert.equal(catalog.find(m=>m.id==='qwen38-27b-w3a4').max_concurrent_requests,2);

 const response=await post(s.api.base,'/v1/chat/completions',{model:'qwen38-27b-128k',messages:[{role:'user',content:'x'}],max_tokens:100});assert.equal(response.status,400);assert.equal(sent,undefined);
 const ok=await post(s.api.base,'/v1/chat/completions',{model:'qwen38-27b-128k',messages:[{role:'user',content:'x'}],max_tokens:50});assert.equal(ok.status,200);assert.equal((await ok.json()).model,'qwen38-27b-128k');assert.equal(sent.model,'qwen38-27b-w3a4');assert.equal(ok.headers.get('x-reasoning-effort'),'medium');
 assert.equal(catalog[0].vision,true);
 assert.equal(sent.reasoning_effort,'medium');assert.equal(sent.chat_template_kwargs.reasoning_effort,'medium');assert.equal(sent.chat_template_kwargs.enable_thinking,true);
 const high=await post(s.api.base,'/v1/chat/completions',{model:'qwen38-27b-128k',messages:[{role:'user',content:'x'}],max_tokens:50,reasoning_effort:'high'});assert.equal(high.status,200);await high.json();
 assert.equal(sent.reasoning_effort,'xhigh');assert.equal(sent.chat_template_kwargs.reasoning_effort,'xhigh');assert.equal(sent.chat_template_kwargs.enable_thinking,true);
 const none=await post(s.api.base,'/v1/chat/completions',{model:'qwen38-27b-128k',messages:[{role:'user',content:'x'}],max_tokens:50,reasoning_effort:'none',chat_template_kwargs:{enable_thinking:true}});assert.equal(none.status,200);await none.json();
 assert.equal(sent.reasoning_effort,'none');assert.equal(sent.chat_template_kwargs.reasoning_effort,'none');assert.equal(sent.chat_template_kwargs.enable_thinking,false);
 // A value this deployment cannot serve is refused before any GPU lease; the
 // catalog's own key spelling and OpenAI's two extra levels map onto it instead.
 const invalid=await post(s.api.base,'/v1/chat/completions',{model:'qwen38-27b-128k',messages:[{role:'user',content:'x'}],max_tokens:50,reasoning_effort:'invalid'});assert.equal(invalid.status,400);assert.match((await invalid.json()).error,/Unsupported reasoning_effort/);assert.equal(s.c.status().leased,false);
 const clamped=await post(s.api.base,'/v1/chat/completions',{model:'qwen38-27b-128k',messages:[{role:'user',content:'x'}],max_tokens:50,reasoning_effort:' MAX '});assert.equal(clamped.status,200);await clamped.json();
 assert.equal(sent.reasoning_effort,'xhigh');assert.equal(clamped.headers.get('x-reasoning-effort'),'xhigh');
 const off=await post(s.api.base,'/v1/chat/completions',{model:'qwen38-27b-128k',messages:[{role:'user',content:'x'}],max_tokens:50,reasoning_effort:'off'});assert.equal(off.status,200);await off.json();
 assert.equal(sent.reasoning_effort,'none');assert.equal(sent.chat_template_kwargs.enable_thinking,false);
 }finally{await s.close();await close(upstream.server);}
});
test('panel loads custom configuration before discovery exposes the new limits',async()=>{
 const upstream=await listen(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;res.setHeader('Content-Type','application/json');const payload=JSON.parse(raw);res.end(JSON.stringify(req.url==='/tokenize'?{count:10}:{model:payload.model,choices:[]}));});
 const s=await setup({llmBase:upstream.base});try{
 assert.equal((await post(s.api.base,'/api/llm-mode',{mode:'wrong'})).status,400);
 const selected=await post(s.api.base,'/api/llm-mode',{mode:'custom',context_tokens:131072,concurrency:3});assert.equal(selected.status,200);assert.deepEqual(s.backend.calls,['llm']);
 const models=(await(await fetch(s.api.base+'/v1/models')).json()).data;assert.deepEqual(models.map(m=>m.id),['qwen38-27b-w3a4']);assert.ok(models.every(m=>m.contextWindow===131072&&m.max_concurrent_requests===3&&m.vision));
 assert.equal((await post(s.api.base,'/api/llm-mode',{mode:'custom',context_tokens:999999,concurrency:8})).status,400);
 assert.equal(s.c.policy.context_tokens,131072);
 const response=await post(s.api.base,'/v1/chat/completions',{model:models[0].id,messages:[{role:'user',content:'x'}],max_tokens:50});assert.equal(response.status,200);assert.equal((await response.json()).model,models[0].id);
 const selectedAgain=await post(s.api.base,'/api/llm-mode',{mode:'custom',context_tokens:135168,concurrency:2});assert.equal(selectedAgain.status,200);
 const updated=(await(await fetch(s.api.base+'/v1/models')).json()).data;assert.deepEqual(updated.map(m=>m.id),['qwen38-27b-w3a4']);assert.equal(updated[0].contextWindow,135168);
 for(const entry of [models[0],updated[0]]){assert.equal(entry.reasoning,true);assert.deepEqual(entry.reasoningEfforts,{off:'none',low:'low',medium:'medium',high:'high',xhigh:'xhigh'});assert.equal(entry.default_reasoning_effort,'medium');assert.equal(entry.compat.supportsReasoningEffort,true);}
 assert.equal((await post(s.api.base,'/v1/chat/completions',{model:updated[0].id,messages:[{role:'user',content:'x'}],max_tokens:50})).status,200);
 }finally{await s.close();await close(upstream.server);}
});

test('engine log source follows running and switching models and exposes applied LLM config events',async()=>{
 const s=await setup(),seen=[];s.backend.engineLogs=async model=>{seen.push(model);return {model,engine:model==='llm'?'vLLM':'ComfyUI',available:!!model,output:model?'raw '+model:'waiting'};};
 try{
  const logs=async path=>(await(await fetch(s.api.base+(path??'/api/engine-logs'))).json());
  const idle=await logs();assert.equal(idle.model,null);assert.equal(idle.available,false);
  s.c.current='llm';await s.c.selectLlmMode('custom',135168,3);
  const applied=await logs();assert.equal(applied.model,'llm');assert.equal(applied.model_id,'qwen38-27b-w3a4');assert.equal(applied.policy.concurrency,3);assert.equal(applied.events.length,3);assert.equal(applied.output,'raw llm');
  s.c.switching=true;s.c.target='flux';const switching=await logs();assert.equal(switching.model,'flux');assert.equal(switching.policy,null);assert.deepEqual(switching.events,[]);assert.equal(switching.switching,true);
  s.c.switching=false;s.c.target=null;s.c.current='h3';const media=await logs('/api/llm-mode/logs');assert.equal(media.model,'h3');assert.equal(media.model_id,null);assert.equal(media.output,'raw h3');
  assert.deepEqual(seen,[null,'llm','flux','h3']);assert.deepEqual(s.backend.calls,['llm']);
 }finally{await s.close();}
});

test('media switch exposes launcher, health and errors only for its target service',async()=>{
 const s=await setup();let finish,entered;const gate=new Promise(r=>finish=r),started=new Promise(r=>entered=r);const seen=[];
 s.backend.ensure=async(model,deadline,clock,policy,report)=>{report('loading','weights loading','launcher');report('health-check','checking worker');entered();await gate;throw Error('worker health failed');};
 s.backend.engineLogs=async(model,options)=>{seen.push({model,...options});return {model,available:false,output:'container not created'};};
 const task=s.c.acquire('flux').catch(e=>e);await started;
 try{
  const logs=await(await fetch(s.api.base+'/api/engine-logs')).json();assert.equal(logs.model,'flux');assert.equal(logs.switching,true);assert.equal(logs.engine_switch.phase,'health-check');assert.ok(logs.engine_switch.events.some(e=>e.source==='launcher'&&e.message==='weights loading'));assert.equal(seen[0].since,new Date(logs.engine_switch.started_at).toISOString());
  const other=await(await fetch(s.api.base+'/api/engine-logs?model=h3')).json();assert.equal(other.engine_switch,null);assert.equal(other.switching,false);
  finish();assert.match((await task).message,/worker health failed/);
  const failed=await(await fetch(s.api.base+'/api/engine-logs?model=flux')).json();assert.equal(failed.engine_switch.phase,'error');assert.match(failed.engine_switch.events.at(-1).message,/worker health failed/);assert.equal(seen.at(-1).since,undefined);
 }finally{finish();await task;await s.close();}
});

test('native workflow events record timing once and preserve active request counts',async()=>{
 const s=await setup(),id='46eac0d0-c530-4b22-9c6c-e6417950c1b5';
 try{
  const event={id,model:'h3',phase:'start'};
  assert.equal((await post(s.control.base,'/workflow-event',event,{Origin:'http://localhost:8188'})).status,403);
  for(let i=0;i<2;i++)assert.equal((await post(s.control.base,'/workflow-event',event)).status,200);
  assert.equal(s.metrics.active.h3,1);
  const finish={...event,phase:'finish',outcome:'success',seconds:85,queue_seconds:5,finished_at:Date.now()/1000};
  for(let i=0;i<2;i++)assert.equal((await post(s.control.base,'/workflow-event',finish)).status,200);
  assert.equal(s.metrics.active.h3,0);assert.equal(s.metrics.state.recent.length,1);
  assert.equal(s.metrics.state.recent[0].seconds,85);assert.equal(s.metrics.state.recent[0].queue_seconds,5);
  assert.equal(s.metrics.state.recent[0].source,'comfyui-native');
  assert.match(s.metrics.prometheus(s.c),/lab_gateway_last_request_seconds\{model="h3"\} 85/);
  assert.equal((await post(s.control.base,'/workflow-event',{...finish,id:'ad510d17-11b5-43a8-9572-c9d45d62d947',seconds:-1})).status,409);
  // A completion delivered after a controller restart can recover without a start event.
  assert.equal((await post(s.control.base,'/workflow-event',{...finish,id:'ad510d17-11b5-43a8-9572-c9d45d62d947',model:'h3',outcome:'error'})).status,200);
  assert.equal(s.metrics.active.h3,0);assert.equal(s.metrics.state.recent.at(-1).outcome,'error');
  assert.deepEqual(s.backend.calls,[]);
 }finally{await s.close();}
});

test('scheduler timeouts preserve their distinct codes and HTTP statuses',async()=>{
 const s=await setup();
 try{
  const ticket=await s.c.acquire('llm',{timeout:2});s.backend.capacityTokens=100;
  const second=await s.c.acquire('llm',{timeout:2});await s.c.reserveTokens(ticket.token,80);
  let capacityError;try{await s.c.reserveTokens(second.token,50,0);}catch(error){capacityError=error;}
  assert.equal(capacityError.code,'KV_CAPACITY_WAIT_TIMEOUT');
  s.c.reserveTokens=async()=>{throw capacityError;};
  // Use a separate API request with a free lease slot and a real tokenize response.
  await s.c.release(second.token);await s.c.release(ticket.token);
  const upstream=await listen(async(req,res)=>{for await(const chunk of req){}res.end(JSON.stringify({count:10}));});
  const h=handlers(s.c,s.metrics,s.lifecycle,{llmBase:upstream.base}),api=await listen(h.api);
  try{
   const response=await post(api.base,'/v1/chat/completions',{model:'qwen38-27b-w3a4',messages:[{}],max_tokens:20});
   assert.equal(response.status,429);assert.equal((await response.json()).error.code,'KV_CAPACITY_WAIT_TIMEOUT');
  }finally{await close(api.server);await close(upstream.server);}
  const owner=await s.c.acquire('h3');let queueError;
  try{await s.c.acquire('llm',{timeout:0,exclusive:true});}catch(error){queueError=error;}
  assert.equal(queueError.code,'GPU_LEASE_QUEUE_TIMEOUT');assert.equal(s.c.status().queued,0);
  s.c.acquire=async()=>{throw queueError;};
  const response=await post(s.api.base,'/v1/chat/completions',{model:'qwen38-27b-w3a4',messages:[{}]});
  assert.equal(response.status,503);assert.equal((await response.json()).error.code,'GPU_LEASE_QUEUE_TIMEOUT');
  await s.c.release(owner.token);
 }finally{await s.close();}
});

test('disconnect during engine wait records the observed phase and non-stream outcome',async t=>{
 const logs=[];t.mock.method(console,'warn',value=>logs.push(JSON.parse(value)));
 let ready,finish;const waiting=new Promise(r=>ready=r),gate=new Promise(r=>finish=r);
 const upstream=await listen(async(req,res)=>{for await(const chunk of req){}res.end(JSON.stringify(req.url==='/tokenize'?{count:8}:{choices:[]}));});
 const s=await setup({llmBase:upstream.base});s.backend.ensure=async()=>{ready();await gate;};
 try{
  const response=post(s.api.base,'/v1/chat/completions',{model:'qwen38-27b-w3a4',messages:[{}]});
  // The post helper has no AbortSignal; use the request's server connection for the disconnect.
  await waiting;s.api.server.closeAllConnections();await assert.rejects(response);
  for(let i=0;i<50&&!logs.length;i++)await pause(10);
  assert.equal(logs.length,1);assert.equal(logs[0].code,'CLIENT_CONNECTION_CLOSED');assert.equal(logs[0].phase,'waiting_for_engine');assert.ok(logs[0].elapsed_seconds>=0);
  finish();for(let i=0;i<100&&s.metrics.active.llm;i++)await pause(10);
  assert.equal(s.metrics.state.recent.at(-1).outcome,'disconnected');assert.equal(s.c.status().leased,false);
 }finally{finish();await s.close();await close(upstream.server);}
});

test('invalid H3 reference requests reject before switching any GPU engine',async()=>{
 const s=await setup();try {
  for(const extra of [{reference_images_b64:Array(10).fill('AAAA')},{reference_videos_b64:Array(4).fill('AAAA')},{reference_videos_b64:['AAAA']}]) {
   const response=await post(s.api.base,'/v1/videos/generations',{model:'minimax-h3',prompt:'test',...extra});
   assert.equal(response.status,400);assert.deepEqual(s.backend.calls,[]);assert.equal(s.c.status().leased,false);
  }
  const response=await fetch(s.api.base+'/v1/media/models'),catalog=await response.json();
  assert.equal(catalog.data.find(m=>m.id==='minimax-h3').reference_limits.images,9);
 }finally{await s.close();}
});
