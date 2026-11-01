// Qwen3.8 27B W3A4 on vLLM. Chat is served by the gateway's OpenAI-compatible route; this adapter
// covers the engine lifecycle: CPU residency instead of unloading, policy-driven launch arguments
// and verification that the loaded engine matches the selected serving policy.
import {call} from '../../../platforms/workbench/lib/engine-sdk.mjs';
import {enginePolicyKey} from '../../../platforms/workbench/lib/llm.mjs';
const counted=(text,metric)=>[...text.matchAll(new RegExp('^vllm:'+metric+'(?:\\{[^\\n]*\\})?\\s+([\\d.eE+-]+)','gm'))];
export default {
  async idle(ctx){
    const r=await fetch(ctx.base+'/metrics',{signal:AbortSignal.timeout(5000)});if(!r.ok)return false;const text=await r.text();
    return ['num_requests_running','num_requests_waiting'].every(metric=>{const values=counted(text,metric);return values.length>0&&values.every(v=>Number(v[1])===0);});
  },
  async ready(ctx){if(await ctx.backend.sleeping())return false;return (await fetch(ctx.base+'/health',{signal:AbortSignal.timeout(5000)})).ok;},
  // Weights parked in CPU memory are not a running GPU engine.
  parked:ctx=>ctx.backend.sleeping(),
  matches:async(ctx,policy)=>await ctx.backend.llmMode()===enginePolicyKey(policy),
  // Leaving for another engine: keep the weights in CPU memory when residency allows.
  async park(ctx,report){
    report('unloading','将 Qwen 权重迁移到 CPU');
    try{const preserved=await ctx.backend.sleep();if(preserved)report('unloading','Qwen 权重已保留在 CPU');return preserved;}
    catch(e){report('unloading',`CPU 保留失败，改为释放容器：${e.message}`);return false;}
  },
  // Coming back: wake parked weights of the same policy, otherwise clear any leftover container.
  async resume(ctx,policy,report){
    const backend=ctx.backend;
    if(await backend.sleeping()&&await backend.llmMode()===enginePolicyKey(policy)){
      report('loading','从 CPU 唤醒 Qwen 权重');
      try{await call(ctx.base,'/wake_up',{},(await backend.config()).transition_timeout_seconds*1000);if(!await backend.sleeping()&&await backend.ready(ctx.engine))return true;}catch(e){report('loading',`唤醒失败，改为冷启动：${e.message}`);}
      await backend.stop(ctx.engine);
    }
    if(await backend.labelled()||(await backend.rows()).includes(ctx.runtime.container))await backend.stop(ctx.engine);
    return false;
  },
  launchArgs:(ctx,policy)=>['--context',String(policy.context_tokens),'--max-num-seqs',String(policy.concurrency),'--kv-cache-memory-bytes',String(policy.kv_budget_bytes),'--lm-head','bf16','--eager-mode',policy.eager?'on':'off'],
  launchEnv:(ctx,{cold})=>cold?{LAB_LLM_RESIDENCY_DISABLE:'1'}:{},
  async startupCheck(ctx){
    if(await ctx.backend.labelled()&&!['running','created'].includes(await ctx.backend.run('docker',['inspect','--format','{{.State.Status}}',ctx.runtime.container])))throw new Error('Resident LLM exited during startup');
  },
  async verify(ctx,policy){if(await ctx.backend.llmMode()!==enginePolicyKey(policy))throw new Error('LLM started with an unexpected context or concurrency configuration');},
  // A failed resident start is retried once as a plain cold start.
  retryCold:async ctx=>(await ctx.backend.config()).enabled,
  onStop(ctx){Object.assign(ctx.backend,{loadedLlmMode:null,capacityTokens:null,capacityContainer:null,llmConfiguration:null,kvForecast:null});},
  startupLogs:ctx=>ctx.backend.startupLogs(),
};
