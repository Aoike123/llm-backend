// Public names select a serving policy; all use the same loaded weights.
export const LLM_REASONING_EFFORTS = Object.freeze({off:'none',low:'low',medium:'medium',high:'high',xhigh:'xhigh'});
export const LLM_DEFAULT_REASONING_EFFORT = 'medium';
// Request spellings a client may reasonably send that this deployment does not
// serve: the catalog's own `off` key (an easy confusion, because the level is
// keyed `off` while the request value is `none`) and the two levels OpenAI names
// beyond this set. `off` must keep meaning "no thinking"; the other two clamp to
// their nearest served neighbour rather than collapsing into the default, which
// would silently think at a level nobody asked for.
const LLM_REASONING_ALIASES = Object.freeze({off:'none',minimal:'low',max:'xhigh'});
// Normalize a requested reasoning effort. Only a request carrying no effort at
// all — absent, or blank — takes LLM_DEFAULT_REASONING_EFFORT: an explicit value
// this deployment cannot serve is refused, because guessing at it would run
// thinking at a level the caller never asked for and never sees. Case and
// surrounding whitespace are not meaning, so those are normalized, not refused.
export function reasoningEffort(requested){
 if(requested===undefined||requested===null)return LLM_DEFAULT_REASONING_EFFORT;
 const asked=typeof requested==='string'?requested.trim().toLowerCase():undefined;
 if(asked==='')return LLM_DEFAULT_REASONING_EFFORT;
 if(asked!==undefined&&Object.values(LLM_REASONING_EFFORTS).includes(asked))return asked;
 if(asked!==undefined&&Object.hasOwn(LLM_REASONING_ALIASES,asked))return LLM_REASONING_ALIASES[asked];
 throw new Error(`Unsupported reasoning_effort ${JSON.stringify(requested)}; use ${
  Object.values(LLM_REASONING_EFFORTS).join(', ')}, or omit it for the default ${LLM_DEFAULT_REASONING_EFFORT}`);
}
export const LLM_PROFILES = {
  'qwen38-27b-w3a4-192k': {mode:'long', slot:'192k', maxModelLen:196608, limit:2, vision:true, visionDevice:'cpu'},
  'qwen38-27b-w3a4-256k': {mode:'long-single', slot:'256k', maxModelLen:262144, limit:1, vision:true, visionDevice:'cpu'},
  'qwen38-27b-w3a4-64k': {mode:'throughput', slot:'64k', maxModelLen:65536, limit:8, vision:true, visionDevice:'cpu'},
};
export const LLM_MODES = {long:{limit:2, name:'长上下文双路 · 每路 192K'}, 'long-single':{limit:1,name:'长上下文单路 · 256K'}, throughput:{limit:8, name:'高并发图文 · 64K · 最多八路'}};
const aliases={'qwen38-27b-w3a4':'qwen38-27b-w3a4-192k','qwen38-27b-256k':'qwen38-27b-w3a4-256k','qwen38-27b-65k-8way':'qwen38-27b-w3a4-64k'};
export function activeModelId() {
 return 'qwen38-27b-w3a4';
}
export function llmProfile(id) {
 if(id==='qwen38-27b-128k')return {...LLM_PROFILES['qwen38-27b-w3a4-192k'],maxModelLen:131072};
 const key=Object.hasOwn(aliases,id)?aliases[id]:id;
 if(Object.hasOwn(LLM_PROFILES,key))return LLM_PROFILES[key];
 const match=typeof id==='string'?/^qwen38-27b-w3a4-([1-9]\d*(?:\.\d+)?)k$/.exec(id):null;
 const context=match?Number(match[1])*1024:NaN;
 if(!Number.isInteger(context)||context<1024||context>262144||id!==`qwen38-27b-w3a4-${context/1024}k`)return undefined;
 return {mode:'custom',slot:match[1]+'k',maxModelLen:context,limit:8,vision:true,visionDevice:'cpu'};
}
export function completionBudget(data, profile, promptTokens) {
  if(!Number.isInteger(promptTokens)||promptTokens<0)throw new Error('Backend did not report a valid prompt token count');
  const requested=data.max_completion_tokens??data.max_tokens;
  if(requested!==undefined&&(!Number.isInteger(requested)||requested<1))throw new Error('Output token limit must be a positive integer');
  const remaining=profile.maxModelLen-promptTokens;
  if(remaining<1||requested!==undefined&&requested>remaining)throw new Error(`Input plus output exceeds ${profile.maxModelLen} tokens for this model`);
  return requested??Math.min(4096,remaining);
}

export const KV_BUDGET_BYTES=8859648000;
export function kvBudgetBytes(contextTokens) {return contextTokens<=65536?KV_BUDGET_BYTES:8*2**30;}
export const MAX_CONTEXT=262144;
export const MAX_CONCURRENCY=8;

// Measured per-token KV pool cost. A pool byte is spent per token of context, so
// the cost is read back from real startups instead of derived from bytes/GiB.
// Single-point startup constants (see workspace/reports/kv-calibration-20261014/SUMMARY.md).
// 权重与图捕获来自启动日志；buffer 由实测启动峰值反解，代表计算缓冲+桌面等不可再分配部分。
export const VRAM_DEFAULTS=Object.freeze({
  vramTotalBytes:31.86*2**30,
  peakBytes:31.58*2**30,
  weightsBytes:13.51*2**30,
  bufferBytes:(31.58-13.51-8.251190185546875-1.45)*2**30,
});
// Graph capture grows with concurrency; eager disables it entirely.
export function graphCaptureBytes(concurrency,eager=false){
  if(eager)return 0;
  const measured={1:0.71,2:0.91,6:1.45,8:1.73};
  if(measured[concurrency]!=null)return measured[concurrency]*2**30;
  const points=Object.keys(measured).map(Number).sort((a,b)=>a-b);
  const upper=points.find(n=>n>concurrency),lower=[...points].reverse().find(n=>n<concurrency);
  if(lower==null||upper==null)return measured[lower??upper??8]*2**30;
  return (measured[lower]+(measured[upper]-measured[lower])*(concurrency-lower)/(upper-lower))*2**30;
}
// [上下文, 并发, 整块分配池字节, 实测容量 tokens] —— 全部来自实际重启标定。
// 池字节取启动日志 "reserved X GiB"：8.25 GiB = 8859648000，8.00 GiB = 8589934592。
export const KV_CALIBRATION=Object.freeze([
  [49152,8,8859648000,365975],
  [65536,6,8859648000,393216],
  [196608,2,8589934592,393873],
  [262144,1,8589934592,412137],
]);
export function kvPoolBytesPerToken(contextTokens,concurrency,extras){
  const hit=(extras?.calibration??KV_CALIBRATION).find(row=>row[0]===contextTokens&&row[1]===concurrency);
  if(hit)return {bytes_per_token:hit[2]/hit[3],source:'measured',context_tokens:hit[0],concurrency:hit[1],allocated_pool_bytes:hit[2],capacity_tokens:hit[3]};
  return {bytes_per_token:null,source:'uncalibrated',context_tokens:contextTokens,concurrency,allocated_pool_bytes:null,capacity_tokens:null};
}
// Pool geometry comes from the running engine; target pool blocks must be
// recomputed from the selected byte budget, never borrowed from that engine.
export function planPreview(plan,contextTokens,concurrency,eager=false,kvBytes=kvBudgetBytes(contextTokens)){
 const sample=plan?.version===2?plan.matrix?.[`${contextTokens}:${concurrency}:${eager?'eager':'graph'}`]:null;
 if(!Number.isSafeInteger(sample?.block_bytes)||sample.block_bytes<=0||
    !Number.isSafeInteger(sample.blocks_per_request)||sample.blocks_per_request<=0||
    !Number.isSafeInteger(kvBytes)||kvBytes<=0)return null;
 const blocks=Math.floor(kvBytes/sample.block_bytes);
 return {source:'planned',block_bytes:sample.block_bytes,blocks_per_request:sample.blocks_per_request,
   gdn:sample.gdn,prefill_tokens:sample.prefill_tokens,pool_blocks:blocks,
   estimated_capacity_tokens:Math.floor(blocks*contextTokens/sample.blocks_per_request),
   required_pool_bytes:sample.block_bytes*sample.blocks_per_request*concurrency,
   planned_pool_bytes:blocks*sample.block_bytes};
}
// Actual pool size is the worker's allocated block count, not its byte ceiling.
export function allocatedPoolBytes(plan,policy){
 if(plan?.version!==2||plan.context_tokens!==policy?.context_tokens||plan.concurrency!==policy?.concurrency||
    plan.eager!==policy?.eager||plan.kv_budget_bytes!==policy?.kv_budget_bytes||
    !Number.isSafeInteger(plan.pool_blocks)||plan.pool_blocks<=0)return null;
 const block=plan.matrix?.[`${policy.context_tokens}:${policy.concurrency}:${policy.eager?'eager':'graph'}`]?.block_bytes;
 const bytes=plan.pool_blocks*block;
 return Number.isSafeInteger(block)&&block>0&&Number.isSafeInteger(bytes)?bytes:null;
}
export function vramBudget({contextTokens,concurrency,eager=false,kvBytes,capacityTokens,allocatedPoolBytes,preview,vramTotalBytes,weightsBytes,bufferBytes,extras}={}){
 const finite=n=>Number.isFinite(n)&&n>=0;
 const capture=eager?0:finite(extras?.graph_capture_bytes)?extras.graph_capture_bytes:graphCaptureBytes(concurrency,false);
 const total=finite(vramTotalBytes)?vramTotalBytes:finite(extras?.vram_total_bytes)?extras.vram_total_bytes:VRAM_DEFAULTS.vramTotalBytes;
 const weights=finite(weightsBytes)?weightsBytes:finite(extras?.weights_bytes)?extras.weights_bytes:VRAM_DEFAULTS.weightsBytes;
 const buffer=finite(bufferBytes)?bufferBytes:finite(extras?.buffer_bytes)?extras.buffer_bytes:VRAM_DEFAULTS.bufferBytes;
 // The fallback buffer is a startup residual, not a measured full-load peak.
 const verified=extras?.full_load_verified===true&&finite(extras?.buffer_bytes)&&finite(extras?.vram_total_bytes)&&
   finite(extras?.weights_bytes)&&(eager||finite(extras?.graph_capture_bytes));
 const feasible=Math.floor(total-weights-capture-buffer);
 const demand=contextTokens*concurrency;
 const budget=Number.isSafeInteger(kvBytes)?kvBytes:null;
 const allocated=Number.isSafeInteger(allocatedPoolBytes)?allocatedPoolBytes:null;
 const required=preview?.required_pool_bytes??null;
 const capacity=capacityTokens??preview?.estimated_capacity_tokens??null;
 const allocation=allocated??budget;
 const tokenShortfall=capacity==null?null:Math.max(0,demand-capacity);
 const violations=[];
 if(allocation!=null&&allocation>feasible)violations.push('allocation');
 if(required!=null&&required>feasible)violations.push('vram');
 if(required!=null&&budget!=null&&required>budget)violations.push('budget');
 if(tokenShortfall>0)violations.push('tokens');
 return {
   vram_total_bytes:total,weights_bytes:weights,graph_capture_bytes:capture,buffer_bytes:buffer,
   full_load_verified:verified,vram_source:verified?'load-measured':'startup-estimate',
   feasible_pool_bytes:feasible,required_pool_bytes:required,pool_budget_bytes:budget,pool_allocated_bytes:allocated,
   allocation_margin_bytes:allocation==null?null:feasible-allocation,
   budget_margin_bytes:budget==null?null:feasible-budget,
   usable_pool_margin_bytes:required==null||budget==null?null:Math.min(feasible,budget)-required,
   full_load_margin_bytes:required==null||budget==null?null:feasible-Math.max(required,budget),
   vram_margin_bytes:required==null?null:feasible-required,
   capacity_tokens:capacity,demand_tokens:demand,capacity_margin_tokens:capacity==null?null:capacity-demand,
   shortfall_tokens:tokenShortfall,factors:preview,violations,
   bottleneck:violations[0]??(required==null||capacity==null?'uncalibrated':'none'),
   source:capacityTokens!=null?'measured':preview?'planned':'uncalibrated',
 };
}
export function budgetStatus(budget){
 if(budget?.violations?.length)return 'exceeded';
 if(budget?.capacity_tokens==null||budget?.required_pool_bytes==null)return 'unknown';
 if(!budget.full_load_verified)return 'unverified';
 if(budget.vram_margin_bytes<0.5*2**30||budget.allocation_margin_bytes<0.5*2**30)return 'tight';
 return 'verified';
}

export function enginePolicyKey(policy) {
 return `${policy.context_tokens}:${policy.concurrency}:bf16:${policy.kv_budget_bytes??kvBudgetBytes(policy.context_tokens)}:${policy.eager?"eager":"graph"}`;
}
export function servingPolicy(mode='long',contextTokens,concurrency,eager=false,kvBytes) {
 const preset={'long':[196608,2],'long-single':[262144,1],throughput:[65536,8]};
 if(mode!=='custom'&&!Object.hasOwn(preset,mode))throw new Error('Unknown LLM mode');
 const context=contextTokens??preset[mode]?.[0],limit=concurrency??preset[mode]?.[1];
 if(!Number.isInteger(context)||context<1024||context>MAX_CONTEXT)throw new Error('Context must be between 1024 and 262144 tokens');
 if(!Number.isInteger(limit)||limit<1||limit>MAX_CONCURRENCY)throw new Error('Concurrency must be between 1 and 8');
 if(typeof eager!=='boolean')throw new Error('Eager must be a boolean');
 const bytes=kvBytes??kvBudgetBytes(context);
 if(!Number.isSafeInteger(bytes)||bytes<2**30||bytes>32*2**30)throw new Error('KV budget must be between 1 and 32 GiB');
 return {mode,context_tokens:context,concurrency:limit,eager,kv_budget_bytes:bytes};
}

// Full-load demand is context × concurrency. It is compared against the pool the
// engine actually allocated, never against the pool plus the configured ceiling.
export function policyBudget(policy,capacityTokens,measuredPolicy=enginePolicyKey(policy)) {
 if(measuredPolicy!==enginePolicyKey(policy))capacityTokens=null;
 const demand=policy.context_tokens*policy.concurrency;
 const margin=capacityTokens==null?null:capacityTokens-demand;
 return {capacity_tokens:capacityTokens??null,demand_tokens:demand,
   capacity_margin_tokens:margin,remaining_tokens:margin,
   shortfall_tokens:margin==null?null:Math.max(0,-margin),
   risk:capacityTokens==null?null:demand>capacityTokens,measured_policy:capacityTokens==null?null:measuredPolicy};
}
export function previewBudget(policy,contextTokens,concurrency,budget,pending=false) {
 const draft={...policy,context_tokens:contextTokens,concurrency};
 const matching=policy&&contextTokens===policy.context_tokens&&concurrency===policy.concurrency&&!pending;
 return policyBudget(draft,matching?budget?.capacity_tokens:null,budget?.measured_policy??null);
}
export function forecastBudget(policy,contextTokens,concurrency,budget,plan,pending=false,eager=policy?.eager??false,kvBytes=kvBudgetBytes(contextTokens),allocatedPoolBytes,extras) {
 const draft={...policy,context_tokens:contextTokens,concurrency,eager,kv_budget_bytes:kvBytes};
 const matching=policy&&enginePolicyKey(draft)===enginePolicyKey(policy)&&!pending;
 const result=policyBudget(draft,matching?budget?.capacity_tokens:null,budget?.measured_policy??null);
 // The engine only trusts a plan produced by the engine that is actually loaded.
 const valid=plan?.version===2&&plan.context_tokens===policy?.context_tokens&&plan.concurrency===policy?.concurrency&&
   plan.eager===(policy?.eager??false)&&plan.kv_budget_bytes===policy?.kv_budget_bytes;
 const livePreview=valid?planPreview(plan,contextTokens,concurrency,eager,kvBytes):null;
 const savedPlan=extras?.preview_plan?.preview_only===true?extras.preview_plan:null;
 const preview=livePreview??planPreview(savedPlan,contextTokens,concurrency,eager,kvBytes);
 const historical=!!preview&&!livePreview;
 const vram=vramBudget({contextTokens,concurrency,eager,kvBytes,capacityTokens:result.capacity_tokens,
   allocatedPoolBytes:matching?allocatedPoolBytes:undefined,preview,
   extras:{...extras,graph_capture_bytes:matching?extras?.graph_capture_bytes:undefined,
     full_load_verified:!historical&&matching&&extras?.full_load_verified===true}});
 const estimated=preview?.estimated_capacity_tokens??null;
 return {...result,...vram,source:historical&&result.capacity_tokens==null?'historical-plan':vram.source,preview_basis:historical?'historical-layout':preview?'engine-layout':null,estimated_capacity_tokens:estimated,
   estimated_capacity_margin_tokens:estimated==null?null:estimated-result.demand_tokens,
   estimated_remaining_tokens:estimated==null?null:estimated-result.demand_tokens,
   factors:preview?{gdn:preview.gdn,prefill_tokens:preview.prefill_tokens,block_bytes:preview.block_bytes,pool_blocks:preview.pool_blocks}:null};
}
