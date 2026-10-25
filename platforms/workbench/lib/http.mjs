import {once} from 'node:events';
import {ApiError} from './api-errors.mjs';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {prepareH3Videos} from './h3-references.mjs';
import {ARTIFACTS,video,validateVideoRequest,H3_REFERENCE_LIMITS} from './media.mjs';
import {call} from './backend.mjs';
import {executeMedia} from './media-executor.mjs';
import {MODELS as MEDIA_MODELS,runtimeTopology} from './media-manifest.mjs';
import {pause} from './core.mjs';
import {monitoring,NAMES} from './monitoring.mjs';
import {LLM_PROFILES, llmProfile, completionBudget, activeModelId, LLM_REASONING_EFFORTS, LLM_DEFAULT_REASONING_EFFORT, reasoningEffort} from './llm.mjs';
export const MODELS={...Object.fromEntries(Object.keys(LLM_PROFILES).map(id=>[id,'llm'])),'qwen-image21':'qwen-image','flux2-klein':'flux','minimax-h3':'h3','cosyvoice3-rl':'tts'};
const localOrigin=origin=>/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
export function send(res,status,data){if(res.destroyed)return;const raw=JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(raw),'Cache-Control':'no-store'});res.end(raw);}
async function body(req,limit){
  if(req.headers['content-type']?.split(';')[0]!=='application/json')throw new Error('Use application/json');
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw new Error('Request body too large');chunks.push(chunk);}
  if(!size)throw new Error('JSON object required');const data=JSON.parse(Buffer.concat(chunks));if(!data||Array.isArray(data)||typeof data!=='object')throw new Error('JSON object required');return data;
}
export function handlers(coordinator,metrics,lifecycle,{llmBase='http://127.0.0.1:18983'}={}) {
  const status=async()=>({...coordinator.status(),...metrics.snapshot(),draining:lifecycle.draining,residency:await coordinator.backend.residency()});
  async function control(req,res) {
    const path=new URL(req.url,'http://localhost').pathname;
    if(req.method==='GET'&&path==='/status')return send(res,200,await status());
    if(req.method!=='POST')return send(res,404,{error:'Not found'});
    if(req.headers.origin)return send(res,403,{error:'Local JSON clients only'});
    try {if(process.env.WORKBENCH_READ_ONLY==='1')return send(res,403,{error:'Preview is read-only'});
      const d=await body(req,4096);let result={ok:true};
      if(path==='/acquire'){coordinator.assertAcceptingRequests();if(lifecycle.draining)return send(res,503,{error:'Scheduler draining'});const timeout=Number(d.timeout??900);if(!Number.isFinite(timeout))throw new Error('Invalid timeout');if(d.model==='llm')coordinator.assertLlmMode(llmProfile(coordinator.selectedLlmMode==='throughput'?'qwen38-27b-w3a4-64k':coordinator.selectedLlmMode==='long-single'?'qwen38-27b-w3a4-256k':'qwen38-27b-w3a4-192k'));result=await coordinator.acquire(d.model,Math.min(900,Math.max(1,timeout)),d.shared,coordinator.selectedLlmMode==='throughput'?'qwen38-27b-w3a4-64k':coordinator.selectedLlmMode==='long-single'?'qwen38-27b-w3a4-256k':'qwen38-27b-w3a4-192k');}
      else if(path==='/renew')coordinator.renew(d.token);
      else if(path==='/release')await coordinator.release(d.token);
      else if(path==='/workflow-event')metrics.workflow(d);
      else return send(res,404,{error:'Not found'});
      send(res,200,result);
    }catch(e){send(res,e instanceof ApiError?e.status:409,e instanceof ApiError?e.toJSON():{error:e.message});}
  }
  async function api(req,res,{admit,keyId}={}) {
    const url=new URL(req.url,'http://localhost'),path=url.pathname,origin=req.headers.origin;
    if(origin&&!localOrigin(origin))return send(res,403,{error:'Only local browser origins are allowed'});
    if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
    if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET, POST, OPTIONS'});return res.end();}
    if(req.method==='GET'){
      if(path==='/status')return send(res,200,await status());
      if(path==='/api/engine-logs'||path==='/api/llm-mode/logs'){
        const requested=url.searchParams.get('model');
        if(requested!==null&&!Object.hasOwn(NAMES,requested))return send(res,400,{error:'Invalid model'});
        const status=coordinator.status(),model=requested??(status.pending_llm_mode?'llm':status.switching_target??status.lease_model??status.current);
        const transition=status.engine_switch?.target===model&&!(model==='llm'&&status.pending_llm_mode&&status.engine_switch.started_at<status.mode_switch?.started_at)?status.engine_switch:null;
        const activeSwitch=status.switching&&status.switching_target===model;
        const engine=await coordinator.backend.engineLogs?.(model,{since:activeSwitch&&transition?new Date(transition.started_at).toISOString():undefined,includeProbes:url.searchParams.get('include_probes')==='1'})??{model,output:'引擎日志暂不可用。',available:false};
        if(model==='llm'&&status.pending_llm_mode&&(status.mode_switch?.phase==='draining'||engine.container_id===status.mode_switch?.previous_container)){
          engine.startup_output=null;engine.startup_complete=false;
        }
        return send(res,200,{...engine,model,policy:model==='llm'?status.llm_policy:null,engine_policy:model==='llm'?status.llm_engine:null,
          target_policy:model==='llm'&&status.pending_llm_mode?status.mode_switch?.policy:null,
          mode_switch:model==='llm'?status.mode_switch:null,model_id:model==='llm'?activeModelId(status.llm_policy):null,
          engine_switch:transition,events:model==='llm'?(status.mode_switch?.events??[]):[],current_model:status.current??null,
          switching:(status.switching&&status.switching_target===model)||(model==='llm'&&!!status.pending_llm_mode)});
      }
      if(path==='/health')return send(res,lifecycle.draining?503:200,{status:lifecycle.draining?'draining':'ready',gateway:true,gpu:coordinator.status()});
      if(path==='/data'){
        const minutes=Number(url.searchParams.get('minutes')??30),windowSeconds=Number(url.searchParams.get('window')??30);if(![15,30,60].includes(minutes))return send(res,400,{error:'Invalid time range'});
        if(![5,15,30,60].includes(windowSeconds))return send(res,400,{error:'Invalid sampling window'});
        const model=url.searchParams.get('model');
        if(model!==null&&!Object.hasOwn(NAMES,model))return send(res,400,{error:'Invalid model'});
        return send(res,200,await monitoring(coordinator,metrics,minutes,windowSeconds,model??undefined));
      }
      if(path==='/v1/models'){
        const policy=coordinator.policy,id=activeModelId(policy),profile=coordinator.requestProfile(id);
        return send(res,200,{object:'list',data:[{id,object:'model',owned_by:'local-workbench',tasks:['chat'],max_model_len:policy.context_tokens,contextWindow:policy.context_tokens,context_length:policy.context_tokens,inputModalities:['text','image'],input:['text','image'],max_concurrent_requests:policy.concurrency,mode:coordinator.selectedLlmMode,vision:profile.vision,vision_device:profile.visionDevice,reasoning:true,reasoningEfforts:LLM_REASONING_EFFORTS,default_reasoning_effort:LLM_DEFAULT_REASONING_EFFORT,compat:{supportsReasoningEffort:true}}]});
      }
      if(path==='/v1/media/models')return send(res,200,{object:'list',runtime_topology:runtimeTopology(),data:Object.entries(MODELS).filter(([,model])=>model!=='llm').map(([id,model])=>({id,object:'model',owned_by:'local-workbench',tasks:[MEDIA_MODELS.find(entry=>entry.id===id)?.kind??'video'],capabilities:MEDIA_MODELS.find(entry=>entry.id===id),...(model==='h3'?{reference_limits:H3_REFERENCE_LIMITS,reference_presets:['reference','reference-turbo4']}: {})}))});
      if(path==='/metrics'){res.writeHead(200,{'Content-Type':'text/plain; version=0.0.4'});return res.end(metrics.prometheus(coordinator));}
      if(/^\/artifacts\/[a-f0-9]{32}\.mp4$/.test(path)){
        try{const file=ARTIFACTS+path.split('/').at(-1),info=await stat(file);res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':info.size});const stream=createReadStream(file);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return;}catch{return send(res,404,{error:'Artifact not found'});}
      }
      return send(res,404,{error:'Unknown API endpoint'});
    }
    if(req.method!=='POST')return send(res,405,{error:'Method not allowed'});
    if(lifecycle.draining)return send(res,503,{error:'Gateway draining'});
    if(process.env.WORKBENCH_READ_ONLY==='1')return send(res,403,{error:'Preview is read-only'});
    const started=performance.now();let model,profile,effort,queue=0,outcome='error',counted=false,ticket,timer,phase='reading_request';
    const client=new AbortController();
    const clientDisconnected=()=>{
      if(res.writableFinished)return;
      client.abort();
      console.warn(JSON.stringify({event:'api_client_disconnected',code:phase==='waiting_for_admission'?'CLIENT_REQUEST_CANCELLED':'CLIENT_CONNECTION_CLOSED',path,model,phase,elapsed_seconds:(performance.now()-started)/1000}));
    };
    res.once('close',clientDisconnected);
    try {
      const d=await body(req,32*2**20);
      if(path==='/api/llm-mode'){const result=await coordinator.selectLlmMode(d.mode,d.context_tokens,d.concurrency,d.eager,d.kv_budget_bytes);return send(res,200,result);}
      if(path==='/v1/chat/completions'){
        profile=coordinator.requestProfile(d.model);if(!profile)throw new Error('Choose an LLM model from /v1/models');
        coordinator.assertLlmMode(profile);
        if(!Array.isArray(d.messages)||!d.messages.length)throw new Error('messages required');model='llm';
        // Before the GPU lease: a refusal here is a bad request, not a busy
        // engine, and an unusable value must not cost a ticket first.
        effort=reasoningEffort(d.reasoning_effort);
        if(!profile.vision&&d.messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type!=='text')))throw new Error('The eight-way model supports text only');
        const output=d.max_completion_tokens??d.max_tokens;
        if(output!==undefined&&(!Number.isInteger(output)||output<1||output>profile.maxModelLen))throw new Error('Invalid output token limit');
      }else if(['/v1/images/generations','/v1/images/edits'].includes(path)){
        model=MODELS[d.model??'qwen-image21'];if(!['qwen-image','flux'].includes(model))throw new Error('Choose qwen-image21 or flux2-klein');
        if(model==='flux'&&path.endsWith('/edits'))throw new Error('FLUX API supports text generation only');
      }else if(path==='/v1/videos/generations'){
        model=MODELS[d.model??'minimax-h3'];if(model!=='h3')throw new Error('Choose minimax-h3');
        validateVideoRequest(model,d);
      }else return send(res,404,{error:'Unknown API endpoint'});
      coordinator.assertAcceptingRequests();
      if(model!=='llm'&&(typeof d.prompt!=='string'||!d.prompt.trim()))throw new Error('prompt required');
      phase='waiting_for_admission';
      const admission=await admit?.(model,client.signal);
      const preparedVideos=model==='h3'?await prepareH3Videos(d):undefined;
      if(client.signal.aborted)throw new ApiError('CLIENT_REQUEST_CANCELLED');
      metrics.start(model);counted=true;
      phase='waiting_for_engine';
      ticket=await coordinator.acquire(model,900,model==='llm',d.model,false,{signal:client.signal,enqueuedAt:admission?.enqueuedAt});
      timer=setInterval(()=>{try{coordinator.renew(ticket.token);}catch{}},30000);
      if(client.signal.aborted)throw new ApiError('CLIENT_REQUEST_CANCELLED');
      queue=(performance.now()-started)/1000;
      if(model==='llm'){
        // Validated before the lease; `high` is the one level the engine serves
        // under another name, and the response header reports what it got.
        if(effort==='high')effort='xhigh';
        res.setHeader('X-Reasoning-Effort',effort);
        const payload={...d,model:'qwen38-27b-w3a4',reasoning_effort:effort,
          chat_template_kwargs:{...d.chat_template_kwargs,enable_thinking:effort!=='none',reasoning_effort:effort}};
        phase='tokenizing_request';
        const tokens=await call(llmBase,'/tokenize',{...payload,add_generation_prompt:true},120000);
        try{payload.max_tokens=completionBudget(d,profile,tokens.count);}catch(e){e.status=400;throw e;}
        delete payload.max_completion_tokens;
        phase='waiting_for_kv_capacity';
        await coordinator.reserveTokens(ticket.token,tokens.count+payload.max_tokens,900,{signal:client.signal});
        if(client.signal.aborted)throw new ApiError('CLIENT_REQUEST_CANCELLED');
        queue=(performance.now()-started)/1000;
        if(d.stream)payload.stream_options={...d.stream_options,include_usage:d.stream_options?.include_usage??true};
        phase='generating_response';
        const upstream=await fetch(llmBase+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer local'},body:JSON.stringify(payload),signal:AbortSignal.timeout(1800000)});
        if(!upstream.ok){send(res,upstream.status,await upstream.json());return;}
        if(d.stream){
          res.writeHead(upstream.status,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});res.flushHeaders();
          for await(const chunk of upstream.body){
            // Keep consuming after disconnect so GPU ownership covers backend completion.
            if(!res.destroyed&&!res.write(Buffer.from(chunk)))await Promise.race([once(res,'drain'),once(res,'close')]);
          }
          if(res.destroyed)outcome='disconnected';else res.end();
        }else {const result=await upstream.json();result.model=d.model;send(res,upstream.status,result);}
      }else {
        phase='generating_response';
        const result=await executeMedia(model,d,{path,preparedVideos});
        result.metrics={...result.metrics,gateway_queue_seconds:queue,gateway_total_seconds:(performance.now()-started)/1000};send(res,200,result);
      }
      if(outcome!=='disconnected')outcome=res.destroyed?'disconnected':'success';
    }catch(e){if(e.retryAfterSeconds&&!res.headersSent&&!res.destroyed)res.setHeader('Retry-After',String(e.retryAfterSeconds));if(e.code==='CLIENT_REQUEST_CANCELLED')outcome='disconnected';else if(e instanceof ApiError)console.warn(JSON.stringify({event:'api_request_rejected',code:e.code,status:e.status,path,model,key_id:keyId,...e.details,retry_after_seconds:e.retryAfterSeconds}));if(!res.headersSent)send(res,e.status??(ticket?503:400),e instanceof ApiError?e.toJSON():e.data??{error:e.message});else if(!res.destroyed)res.destroy();}
    finally {
      clearInterval(timer);
      if(ticket)for(let i=0;i<20;i++){try{await coordinator.release(ticket.token);break;}catch(e){if(e.message==='Invalid lease token')break;await pause(500);}}
      if(counted)metrics.finish(model,outcome,(performance.now()-started)/1000,queue);
    }
  }
  return {api,control};
}
