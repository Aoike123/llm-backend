import test from 'node:test';
import assert from 'node:assert/strict';
import {monitoring} from '../lib/monitoring.mjs';
test('declared rate windows preserve missing samples as chart gaps',async()=>{
 const saved=globalThis.fetch,queries=[],now=Math.floor(Date.now()/5000)*5;
 globalThis.fetch=async url=>{const u=new URL(url),q=u.searchParams.get('query');queries.push(q);return {json:async()=>({status:'success',data:{result:u.pathname.endsWith('query_range')?[{values:[[now-10,'12'],[now,'0']]}]:[{value:[now,q.includes('up{job="cpu_vision"}')?'NaN':'0']}]}})};};
 try{
  const d=await monitoring({status:()=>({current:'llm',llm_engine:{kv_budget_bytes:7*2**30}}),backend:{residency:async()=>({})}},{active:{},state:{recent:[]}},15);
  assert.ok(queries.some(q=>q.includes('rate(vllm:generation_tokens_total')&&q.includes('[30s]')));
  assert.ok(queries.some(q=>q.includes('increase(vllm:prompt_tokens_total')&&q.includes('[1m]')));
  assert.ok(queries.some(q=>q.includes('min_over_time(up{job="llm"}[30s])')));
  assert.ok(queries.some(q=>q.includes('max_over_time(')&&q.includes('[1m:5s]')));
  assert.equal(d.trends.main.length,181);
  assert.deepEqual(d.trends.main.slice(-3),[[now-10,12],[now-5,null],[now,0]]);
  assert.equal(d.values.vision_encode,null);
  assert.equal(d.sampling.output_window_seconds,30);
  assert.equal(d.llm_engine.kv_budget_bytes,7*2**30);
 }finally{globalThis.fetch=saved;}
});
test('unavailable Prometheus never invents idle zeroes',async()=>{
 const saved=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('offline');};
 try{const d=await monitoring({status:()=>({current:'llm'}),backend:{residency:async()=>({})}},{active:{},state:{recent:[]}},15);assert.equal(d.values.output,null);assert.equal(d.values.vision_up,null);assert.equal(d.trends.main,null);}finally{globalThis.fetch=saved;}
});

test('chart selection changes the curve while keeping the peak window fixed',async()=>{
 const saved=globalThis.fetch;let queries=[];
 globalThis.fetch=async url=>{queries.push(new URL(url).searchParams.get('query'));return {json:async()=>({status:'success',data:{result:[]}})};};
 try{for(const window of [5,15,30,60]){queries=[];const d=await monitoring({status:()=>({current:'llm'}),backend:{residency:async()=>({})}},{active:{},state:{recent:[]}},15,window);assert.equal(d.sampling.output_window_seconds,window);assert.ok(queries.some(q=>q.startsWith(window===5?'sum(irate(vllm:generation_tokens_total':'sum(rate(vllm:generation_tokens_total')&&q.includes(`[${window===5?30:window}s]`)));assert.ok(queries.some(q=>q.includes('max_over_time(')&&q.includes('[1m:5s]')));}}finally{globalThis.fetch=saved;}
});

test('requested service metrics remain separate from the actual and switching engines',async()=>{
 const saved=globalThis.fetch,queries=[];
 globalThis.fetch=async url=>{const u=new URL(url);queries.push(u.searchParams.get('query'));return {json:async()=>({status:'success',data:{result:u.pathname.endsWith('query_range')?[]:[{value:[0,'42']}]}})};};
 try{
  const coordinator={status:()=>({current:'llm',switching:true,switching_target:'wan'}),backend:{residency:async()=>({})}};
  const metrics={active:{flux:2},state:{recent:[]}};
  const flux=await monitoring(coordinator,metrics,15,30,'flux');
  assert.equal(flux.model,'flux');assert.equal(flux.current_model,'llm');assert.equal(flux.switching_target,'wan');assert.equal(flux.active,2);
  assert.ok(queries.some(q=>q==='lab_gateway_last_request_seconds{model="flux"}'));
  assert.equal(flux.trends.main,undefined);assert.equal(flux.values.kv,undefined);
  queries.length=0;
  const llm=await monitoring(coordinator,metrics,15,30,'llm');
  assert.equal(llm.values.output,null);assert.equal(llm.values.kv,null);assert.equal(llm.values.running,null);
  assert.equal(llm.values.gpu,42);
 }finally{globalThis.fetch=saved;}
});
