import {comfyRuntime} from './comfy-runtime.mjs';
import {KV_CALIBRATION,VRAM_DEFAULTS} from './llm.mjs';
import {runtimeTopology} from './runtime-topology.mjs';
export const NAMES={llm:'Qwen3.8 · 27B W3A4','qwen-image':'Qwen-Image · 2.1',flux:'FLUX.2 · klein',h3:'ComfyUI',tts:'CosyVoice 3 · RL'};
const selector='{job="llm",model_name="qwen38-27b-w3a4"}';
const llmUp='(min(min_over_time(up{job="llm"}[30s])) == 1)';
const input=`sum(increase(vllm:prompt_tokens_total${selector}[1m])) and on() ${llmUp}`;
const visionUp='(min(up{job="cpu_vision"}) == 1)';
const visionMetric=expr=>`${expr} and on() ${visionUp}`;
export const SAMPLING={scrape_seconds:5,refresh_seconds:5,output_window_seconds:30,input_window_seconds:60,latency_window_seconds:300};
export async function monitoring(coordinator,metrics,minutes,windowSeconds=30,requestedModel) {
  const fast=`sum(irate(vllm:generation_tokens_total${selector}[30s])) and on() ${llmUp}`;
  const chartUp=`(min(min_over_time(up{job="llm"}[${Math.max(30,windowSeconds)}s])) == 1)`;
  const chartOutput=windowSeconds===5?fast:`sum(rate(vllm:generation_tokens_total${selector}[${windowSeconds}s])) and on() ${chartUp}`;
  const peak=`max_over_time((${fast})[1m:5s]) and on() ${llmUp}`;
  const s=coordinator.status(),model=requestedModel??s.switching_target??s.current,sel=`{model="${model}"}`,now=Math.floor(Date.now()/5000)*5;
  const queries={vram:'sum(lab_gpu_vram_used_bytes)',vram_total:'sum(lab_gpu_vram_total_bytes)',gpu:'max(lab_gpu_busy_percent)',temperature:'max(lab_gpu_temperature_celsius)',memory:'node_memory_MemAvailable_bytes',memory_total:'node_memory_MemTotal_bytes',api:'lab_platform_health{service="gateway"}',comfy:'lab_platform_health{service="comfyui"}',last:'lab_gateway_last_request_seconds'+sel,wait:'lab_gateway_last_queue_seconds'+sel,last_completed:'lab_gateway_last_completed_timestamp_seconds'+sel,success:`sum(lab_gateway_requests_total{model="${model}",outcome="success"})`};
  if(model==='llm')Object.assign(queries,{output:chartOutput,peak,input,
    llm_up:'min(up{job="llm"})',sample_age:'time() - max(timestamp(up{job="llm"}))',
    ttft:`histogram_quantile(0.95,sum by(le)(rate(vllm:time_to_first_token_seconds_bucket${selector}[5m]))) and on() (sum(increase(vllm:time_to_first_token_seconds_count${selector}[5m])) > 0) and on() ${llmUp}`,
    kv:`100 * avg(vllm:kv_cache_usage_perc${selector}) and on() ${llmUp}`,
    running:`sum(vllm:num_requests_running${selector}) and on() ${llmUp}`,
    waiting:`sum(vllm:num_requests_waiting${selector}) and on() ${llmUp}`});
  Object.assign(queries,{
    vision_up:'min(up{job="cpu_vision"})',
    vision_threads:visionMetric('max(cpu_vision_threads)'),vision_active:visionMetric('sum(cpu_vision_active)'),vision_waiting:visionMetric('sum(cpu_vision_waiting)'),
    vision_cpu:visionMetric('100 * sum(rate(cpu_vision_process_cpu_seconds_total[1m])) / max(cpu_vision_threads)'),
    vision_memory:visionMetric('max(cpu_vision_container_memory_bytes)'),vision_memory_limit:visionMetric('max(cpu_vision_container_memory_limit_bytes)'),
    vision_cache:visionMetric('max(cpu_vision_cache_bytes)'),vision_cache_limit:visionMetric('max(cpu_vision_cache_limit_bytes)'),
    vision_cache_hit:visionMetric('100 * sum(increase(cpu_vision_hits_total[5m])) / sum(increase(cpu_vision_requests_total[5m]))'),
    vision_encode:visionMetric('sum(rate(cpu_vision_encode_seconds_sum[5m])) / sum(rate(cpu_vision_encodes_total[5m]))'),
    vision_last_encode:visionMetric('max(cpu_vision_last_encode_seconds) and on() (sum(cpu_vision_encodes_total) > 0)'),
    vision_encodes:visionMetric('sum(cpu_vision_encodes_total)'),vision_hits:visionMetric('sum(cpu_vision_hits_total)'),vision_failures:visionMetric('sum(cpu_vision_failures_total)'),
  });
  const trends={gpu:queries.gpu,vram:queries.vram,...(model==='llm'?{main:chartOutput,secondary:input,running:queries.running}:{})};
  const query=async(expr,range)=>{
    try{const params=new URLSearchParams({query:expr,...(range?{start:now-minutes*60,end:now,step:5}:{})});const r=await fetch('http://127.0.0.1:19090/api/v1/'+(range?'query_range':'query')+'?'+params,{signal:AbortSignal.timeout(3000)});const d=await r.json();if(d.status!=='success')return null;const row=d.data.result[0];const n=v=>Number.isFinite(Number(v))?Number(v):null;if(range){const byTime=new Map((row?.values??[]).map(([t,v])=>[t,n(v)]));return Array.from({length:minutes*12+1},(_,i)=>{const t=now-minutes*60+i*5;return [t,byTime.get(t)??null];});}return row?n(row.value[1]):null;}catch{return null;}
  };
  const [values,series]=await Promise.all([Promise.all(Object.entries(queries).map(async([k,v])=>[k,await query(v,false)])),Promise.all(Object.entries(trends).map(async([k,v])=>[k,await query(v,true)]))]);
  const currentValues=Object.fromEntries(values);
  // A sleeping or unloading LLM can still be scraped. Never label its samples as live.
  if(model==='llm'&&(s.current!=='llm'||s.switching))for(const key of ['output','peak','input','ttft','kv','running','waiting'])currentValues[key]=null;
  return {comfyui:model==='h3'?await comfyRuntime():null,runtime_topology:runtimeTopology(s),model,current_model:s.current??null,switching_target:s.switching_target??null,name:NAMES[model]??'待机',llm_mode:s.llm_mode,selected_llm_mode:s.selected_llm_mode,pending_llm_mode:s.pending_llm_mode,mode_switch:s.mode_switch,engine_switch:s.engine_switch,llm_policy:s.llm_policy,llm_engine:s.llm_engine,kv_forecast:s.kv_forecast,kv_preview_plan:model==='llm'?await coordinator.backend.previewPlan?.()??null:null,kv_budget:s.kv_budget,llm_slots:s.llm_slots,switching:s.switching,queued:s.queued,active:metrics.active[model]??0,error:s.last_error,recent:[...metrics.state.recent].reverse(),values:currentValues,trends:Object.fromEntries(series),timestamp:now,minutes,sampling:{...SAMPLING,output_window_seconds:windowSeconds,peak_window_seconds:60,peak_interval_seconds:5},kv_calibration:KV_CALIBRATION,vram_defaults:VRAM_DEFAULTS,residency:await coordinator.backend.residency()};
}
