import test from 'node:test';
import assert from 'node:assert/strict';
import {llmProfile,completionBudget,servingPolicy,policyBudget,activeModelId,previewBudget,forecastBudget,enginePolicyKey,kvPoolBytesPerToken,vramBudget,graphCaptureBytes,kvBudgetBytes,planPreview,budgetStatus,allocatedPoolBytes,reasoningEffort} from '../lib/llm.mjs';
test('context budget counts output and defaults to remaining space',()=>{
 const p=llmProfile('qwen38-27b-128k');
 assert.equal(completionBudget({},p,131000),72);
 assert.throws(()=>completionBudget({max_tokens:100},p,131000),/exceeds/);
 assert.throws(()=>completionBudget({},p,131072),/exceeds/);
 assert.throws(()=>completionBudget({},p,undefined),/valid prompt/);
 assert.equal(completionBudget({max_completion_tokens:100},p,100),100);
 assert.equal(llmProfile('qwen38-27b-w3a4').slot,'192k');
});
test('192K long policy caps combined input and output at 196608 tokens',()=>{
 const p=llmProfile('qwen38-27b-w3a4-192k');assert.equal(p.maxModelLen,196608);assert.equal(p.limit,2);
 assert.equal(completionBudget({max_tokens:4096},p,192512),4096);
 assert.throws(()=>completionBudget({max_tokens:4097},p,192512),/196608/);
 assert.equal(llmProfile('qwen38-27b-w3a4-64k').maxModelLen,65536);
});

test('full-load capacity compares demand against the allocated pool, not the configured ceiling',()=>{
 const measured=policyBudget(servingPolicy('custom',65536,6),393216);
 assert.equal(measured.demand_tokens,393216);
 assert.equal(measured.capacity_margin_tokens,0);
 assert.equal(measured.shortfall_tokens,0);
 assert.equal(measured.risk,false);
 const short=policyBudget(servingPolicy('custom',49152,8),365975);
 assert.equal(short.shortfall_tokens,27241);
 assert.equal(short.risk,true);
 assert.equal(policyBudget(servingPolicy('long-single'),null).capacity_margin_tokens,null);
 assert.equal(policyBudget(servingPolicy('long-single'),null).risk,null);
});
test('new context or concurrency never borrows the old worker capacity',()=>{
 const policy=servingPolicy('custom',65536,6),budget=policyBudget(policy,393216);
 const current=previewBudget(policy,65536,6,budget);
 assert.equal(current.capacity_margin_tokens,0);
 for(const [context,concurrency] of [[196608,2],[49152,8]]){
  const preview=previewBudget(policy,context,concurrency,budget);
  assert.equal(preview.capacity_tokens,null);
 }
 assert.equal(previewBudget(policy,65536,6,budget,true).risk,null);
 assert.equal(policyBudget(policy,412137,enginePolicyKey(servingPolicy('custom',262144,1))).capacity_tokens,null);
});

test('public model identity is stable while legacy context aliases remain valid',()=>{
 for(const tokens of [1024,135168,131073,262144]){
  assert.equal(activeModelId({context_tokens:tokens}),'qwen38-27b-w3a4');
  assert.equal(llmProfile(`qwen38-27b-w3a4-${tokens/1024}k`).maxModelLen,tokens);
 }
 assert.equal(activeModelId(servingPolicy('custom',135168,2)),'qwen38-27b-w3a4');
 for(const id of ['qwen38-27b-w3a4-0k','qwen38-27b-w3a4-257k','qwen38-27b-w3a4-0132k','qwen38-27b-w3a4-1.1k','other-132k'])assert.equal(llmProfile(id),undefined);
});
const policy=servingPolicy('custom',65536,6);
const sample={block_bytes:14336000,blocks_per_request:103,gdn:'lazy',prefill_tokens:4096};
const plan={version:2,context_tokens:65536,concurrency:6,eager:false,kv_budget_bytes:8859648000,pool_blocks:618,matrix:{
 '65536:6:graph':sample,'65536:8:graph':sample,
 '65536:6:eager':{...sample,blocks_per_request:139,gdn:'eager'},
 '262144:1:graph':{...sample,blocks_per_request:381}}};

test('capacity follows target byte budget and target block geometry',()=>{
 const budget=policyBudget(policy,393216);
 const current=forecastBudget(policy,65536,6,budget,plan,false,false,8859648000,8859648000);
 assert.equal(current.capacity_tokens,393216);assert.equal(current.source,'measured');
 const larger=forecastBudget(policy,65536,6,budget,plan,false,false,10*2**30,8859648000);
 assert.equal(larger.capacity_tokens,Math.floor(Math.floor(10*2**30/sample.block_bytes)*65536/103));
 assert.ok(larger.capacity_tokens>current.capacity_tokens);
 assert.equal(larger.pool_allocated_bytes,null);assert.equal(larger.source,'planned');
 assert.ok(larger.violations.includes('allocation'));
 const smaller=forecastBudget(policy,65536,6,budget,plan,false,false,2**30);
 assert.ok(smaller.shortfall_tokens>0);assert.ok(smaller.violations.includes('budget'));
 assert.equal(budgetStatus(smaller),'exceeded');
 // Changing layouts must not reuse the old 618 blocks.
 const geometry={...plan,matrix:{'65536:8:graph':{...sample,block_bytes:2*sample.block_bytes}}};
 assert.equal(planPreview(geometry,65536,8,false,8859648000).pool_blocks,309);
});
test('full-load demand remains distinct from current pool allocation after apply',()=>{
 const p=servingPolicy('custom',65536,8);
 const localPlan={...plan,concurrency:8};
 const f=forecastBudget(p,65536,8,policyBudget(p,393216),localPlan,false,false,8859648000,8859648000);
 assert.equal(f.required_pool_bytes,14336000*103*8);
 assert.equal(f.pool_allocated_bytes,8859648000);
 assert.equal(f.shortfall_tokens,131072);
 assert.ok(f.violations.includes('tokens'));assert.ok(f.violations.includes('budget'));
 assert.equal(budgetStatus(f),'exceeded');
});
test('startup estimates never claim full-load verification, and graph measurements are scoped',()=>{
 const f=forecastBudget(policy,65536,6,policyBudget(policy,393216),plan,false,false,8859648000,8859648000,
  {graph_capture_bytes:1.2*2**30});
 assert.equal(f.graph_capture_bytes,1.2*2**30);
 assert.equal(f.vram_source,'startup-estimate');assert.equal(budgetStatus(f),'unverified');
 const changed=forecastBudget(policy,65536,8,policyBudget(policy,393216),plan,false,false,8859648000,undefined,
  {graph_capture_bytes:1.2*2**30,full_load_verified:true});
 assert.equal(changed.graph_capture_bytes,graphCaptureBytes(8));assert.equal(changed.full_load_verified,false);
 const eager=forecastBudget(policy,65536,6,policyBudget(policy,393216),plan,false,true);
 assert.equal(eager.graph_capture_bytes,0);assert.equal(eager.estimated_capacity_tokens,291375);
 assert.ok(eager.shortfall_tokens>0);
});
test('stale matrices and historical calibration cannot invent draft capacity',()=>{
 for(const stale of [null,{...plan,version:1},{...plan,concurrency:4},{...plan,eager:true},{...plan,kv_budget_bytes:1}]){
  const result=forecastBudget(policy,65536,8,policyBudget(policy,393216),stale);
  assert.equal(result.capacity_tokens,null);assert.equal(result.estimated_capacity_tokens,null);
 }
 const knownHistorical=forecastBudget(policy,262144,1,policyBudget(policy,393216),null);
 assert.equal(knownHistorical.capacity_tokens,null);assert.equal(knownHistorical.source,'uncalibrated');
 assert.notEqual(enginePolicyKey(policy),enginePolicyKey({...policy,eager:true}));
 assert.throws(()=>servingPolicy('custom',65536,6,'true'),/boolean/);
 assert.throws(()=>servingPolicy('custom',65536,6,true,0),/KV budget/);
});
test('live layouts reproduce startup capacity with integer pool rounding',()=>{
 // Independent captured block counts and reported capacities, no one-context tolerance.
 for(const [ctx,bpr,bytes,measured] of [[65536,103,8859648000,393216],
  [196608,299,8589934592,393873],[262144,381,8589934592,412137]]){
  const layout={version:2,matrix:{[`${ctx}:1:graph`]:{...sample,blocks_per_request:bpr}}};
  assert.equal(planPreview(layout,ctx,1,false,bytes).estimated_capacity_tokens,measured);
 }
});

test('full-load margin includes reservation without hiding a demand deficit',()=>{
 const args={contextTokens:65536,concurrency:6,eager:true,vramTotalBytes:32*2**30,weightsBytes:12*2**30,bufferBytes:8*2**30,preview:{required_pool_bytes:8*2**30,estimated_capacity_tokens:393216}};
 const small=vramBudget({...args,kvBytes:7*2**30}),large=vramBudget({...args,kvBytes:10*2**30});
 assert.equal(large.full_load_margin_bytes,2*2**30);
 assert.equal(large.budget_margin_bytes,2*2**30);
 assert.equal(small.budget_margin_bytes,5*2**30);
 assert.equal(small.full_load_margin_bytes,4*2**30);
 assert.ok(small.violations.includes('budget'));
 assert.equal(vramBudget({...args,preview:null,kvBytes:8*2**30}).full_load_margin_bytes,null);
});

test('offline draft preview uses saved geometry and never claims live or verified capacity',()=>{
 const saved={...plan,preview_only:true};
 const offline=policyBudget(policy,null);
 const preview=forecastBudget(policy,65536,8,offline,null,false,false,8859648000,undefined,{preview_plan:saved,full_load_verified:true});
 assert.equal(preview.source,'historical-plan');
 assert.equal(preview.preview_basis,'historical-layout');
 assert.equal(preview.required_pool_bytes,sample.block_bytes*sample.blocks_per_request*8);
 assert.equal(preview.capacity_tokens,393216);
 assert.equal(preview.pool_allocated_bytes,null);
 assert.equal(preview.full_load_verified,false);
 const smaller=forecastBudget(policy,65536,8,offline,null,false,false,2**30,undefined,{preview_plan:saved});
 assert.ok(smaller.capacity_tokens<preview.capacity_tokens);
 const eager=forecastBudget(policy,65536,6,offline,null,false,true,8859648000,undefined,{preview_plan:saved});
 assert.ok(eager.required_pool_bytes>sample.block_bytes*sample.blocks_per_request*6);
 assert.equal(eager.graph_capture_bytes,0);
 const missing=forecastBudget(policy,54272,6,offline,null,false,false,8859648000,undefined,{preview_plan:saved});
 assert.equal(missing.capacity_tokens,null);
 assert.equal(missing.required_pool_bytes,null);
});

test('interpolated graph estimates never decrease from two to three or other lane counts',()=>{
 const captures=Array.from({length:8},(_,i)=>graphCaptureBytes(i+1));
 for(let i=1;i<captures.length;i++)assert.ok(captures[i]>=captures[i-1]);
 assert.ok(Math.abs(captures[2]/2**30-1.045)<1e-9);
 const saved={version:2,preview_only:true,matrix:Object.fromEntries(Array.from({length:8},(_,i)=>[`65536:${i+1}:graph`,sample]))};
 const results=Array.from({length:8},(_,i)=>forecastBudget(policy,65536,i+1,null,null,false,false,8859648000,undefined,{preview_plan:saved,vram_total_bytes:34208743424}));
 for(let i=1;i<results.length;i++){assert.ok(results[i].required_pool_bytes>results[i-1].required_pool_bytes);assert.ok(results[i].feasible_pool_bytes<=results[i-1].feasible_pool_bytes);assert.ok(results[i].full_load_margin_bytes<=results[i-1].full_load_margin_bytes);}
 assert.ok(Math.abs(results[1].full_load_margin_bytes/2**30-.819375)<1e-8);
 assert.ok(Math.abs(results[2].full_load_margin_bytes/2**30-.684375)<1e-8);
});
test('actual allocated pool uses engine block count and rejects mismatched layouts',()=>{
 const actual={...plan,pool_blocks:617};
 assert.equal(allocatedPoolBytes(actual,policy),617*14336000);
 assert.notEqual(allocatedPoolBytes(actual,policy),policy.kv_budget_bytes);
 assert.equal(allocatedPoolBytes({...actual,kv_budget_bytes:1},policy),null);
 assert.equal(allocatedPoolBytes({...actual,pool_blocks:undefined},policy),null);
});

test('lower context increases demand-based headroom while a fixed budget keeps its reservation',()=>{
 const saved={...plan,preview_only:true,matrix:{...plan.matrix,'32768:6:graph':{...sample,blocks_per_request:63}}};
 const lower=forecastBudget(policy,32768,6,null,null,false,false,policy.kv_budget_bytes,undefined,{preview_plan:saved});
 const higher=forecastBudget(policy,65536,6,null,null,false,false,policy.kv_budget_bytes,undefined,{preview_plan:saved});
 assert.ok(lower.vram_margin_bytes>higher.vram_margin_bytes);
 assert.equal(lower.budget_margin_bytes,higher.budget_margin_bytes);
 assert.ok(lower.required_pool_bytes<higher.required_pool_bytes);
 const resized=forecastBudget(policy,32768,6,null,null,false,false,lower.required_pool_bytes,undefined,{preview_plan:saved});
 assert.ok(resized.budget_margin_bytes>lower.budget_margin_bytes);
});

test('usable pool margin turns negative for KV deficits even with positive physical headroom',()=>{
 const args={contextTokens:218112,concurrency:2,eager:true,vramTotalBytes:32*2**30,weightsBytes:12*2**30,bufferBytes:8*2**30,kvBytes:8.251190185546875*2**30};
 const deficit=vramBudget({...args,preview:{required_pool_bytes:8.732*2**30}});
 assert.ok(deficit.vram_margin_bytes>0);assert.ok(deficit.usable_pool_margin_bytes<0);
 assert.ok(Math.abs(deficit.usable_pool_margin_bytes/2**30+.480809814453125)<1e-9);
 const equal=vramBudget({...args,preview:{required_pool_bytes:args.kvBytes}});assert.equal(equal.usable_pool_margin_bytes,0);
 const lower=vramBudget({...args,preview:{required_pool_bytes:5*2**30}});assert.ok(lower.usable_pool_margin_bytes>0);
 const vramDeficit=vramBudget({...args,kvBytes:16*2**30,preview:{required_pool_bytes:13*2**30}});assert.equal(vramDeficit.usable_pool_margin_bytes,-(2**30));
 assert.equal(vramBudget({...args,preview:null}).usable_pool_margin_bytes,null);
});

test('only a missing reasoning effort takes the default; an unusable one is refused',()=>{
 assert.equal(reasoningEffort(undefined),'medium');
 assert.equal(reasoningEffort(null),'medium');
 assert.equal(reasoningEffort(''),'medium');
 assert.equal(reasoningEffort('   '),'medium');
 assert.equal(reasoningEffort('none'),'none');
 assert.equal(reasoningEffort(' High '),'high');
 assert.equal(reasoningEffort('XHIGH'),'xhigh');
 // The catalog keys the level `off` while the request value is `none`, and
 // OpenAI names two levels beyond this deployment's set: the first must keep
 // meaning "no thinking", the other two clamp to their nearest neighbour.
 assert.equal(reasoningEffort('off'),'none');
 assert.equal(reasoningEffort('minimal'),'low');
 assert.equal(reasoningEffort('max'),'xhigh');
 assert.throws(()=>reasoningEffort('invalid'),/Unsupported reasoning_effort/);
 assert.throws(()=>reasoningEffort(3),/Unsupported reasoning_effort/);
 assert.throws(()=>reasoningEffort('constructor'),/Unsupported reasoning_effort/);
});
