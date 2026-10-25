import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, readdir,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {pause} from './core.mjs';
import {EngineLogBuffer} from './engine-logs.mjs';
import {modelBackends,sameRuntime,runtimeFor} from './runtime-topology.mjs';
import {servingPolicy,enginePolicyKey,kvBudgetBytes,allocatedPoolBytes} from './llm.mjs';
export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const exec = promisify(execFile);
export async function command(bin, args, options={}) {
  const {onOutput,...settings}=options;
  const config={timeout:90000,maxBuffer:8*1024*1024,...settings};
  if(!onOutput)return (await exec(bin,args,config)).stdout.trim();
  return new Promise((resolve,reject)=>{
    const child=execFile(bin,args,config,(error,stdout)=>error?reject(error):resolve(stdout.trim()));
    child.stdout?.on('data',chunk=>onOutput(String(chunk)));
    child.stderr?.on('data',chunk=>onOutput(String(chunk)));
  });
}
export async function call(base,path,data,timeout=30000) {
  const r = await fetch(base+path,{method:data===undefined?'GET':'POST',body:data===undefined?undefined:JSON.stringify(data),headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(timeout)});
  const text=await r.text(); let result; try {result=JSON.parse(text);} catch {result={error:`Backend HTTP ${r.status}`};}
  if (!r.ok) {const e=new Error(typeof result.error==='string'?result.error:`Backend HTTP ${r.status}`);e.status=r.status;e.data=result;throw e;} return result;
}
export class Backend {
  run = command;
  capture = exec;
  models=modelBackends();
  sameRuntime=sameRuntime;
  async config() {return JSON.parse(await readFile(ROOT+'platforms/scheduler/residency.json','utf8'));}
  async labelled() {try {return await this.run('docker',['inspect','--format','{{index .Config.Labels "ai.workbench.resident"}}','paiton-qwen38'])==='true';}catch{return false;}}
  async sleeping() {try {return await this.labelled() && (await call('http://127.0.0.1:18983','/is_sleeping')).is_sleeping===true;}catch{return false;}}
  async memory() {return Number((await readFile('/proc/meminfo','utf8')).match(/^MemAvailable:\s+(\d+)/m)[1])*1024;}
  async residency() {return {enabled:(await this.config()).enabled,models:['llm'],llm:await this.sleeping()?'cpu':await this.labelled()?'gpu':'cold',available_memory_bytes:await this.memory()};}
  async vram() {
    let total=0;
    for (const name of await readdir('/sys/class/drm')) if (/^card\d+$/.test(name)) {
      const dir='/sys/class/drm/'+name+'/device/';
      try {if ((await readFile(dir+'vendor','utf8')).trim()==='0x1002') total+=Number(await readFile(dir+'mem_info_vram_used','utf8'));}catch{}
    }return total;
  }
  async sleep() {
    const p=await this.config();
    if (!p.enabled || !p.models.includes('llm') || !await this.labelled() || await this.memory()<p.minimum_available_memory_gib*2**30) return false;
    await call('http://127.0.0.1:18983','/sleep?level=1&mode=wait',{},p.transition_timeout_seconds*1000);
    if (!await this.sleeping()) throw new Error('LLM did not enter CPU-resident sleep');
    for (let i=0;i<30 && await this.vram()>p.maximum_sleep_vram_gib*2**30;i++) await pause(200);
    if (await this.vram()>p.maximum_sleep_vram_gib*2**30 || await this.memory()<p.minimum_remaining_memory_gib*2**30) throw new Error('CPU residency exceeded memory budget');
    return true;
  }
  async rows() {return (await this.run('docker',['ps','--format','{{.Names}}'])).split('\n');}
  async running() {
    const rows=await this.rows();if(rows.includes('ai-vbench'))throw new Error('VBench holds GPU; finish evaluation before switching');
    const active=[],seen=new Set(); for (const [key,[,,name]] of Object.entries(this.models)) if(rows.includes(name) && !seen.has(name) && !(key==='llm' && await this.sleeping())){active.push(key);seen.add(name);}
    if(rows.includes('paiton-flux2-stock-1')&&!active.includes('flux'))active.push('flux');return active;
  }
  async idle(model) {
    try {
      const [,port,name]=this.models[model], rows=await this.rows();
      if(!rows.includes(name) && !(model==='flux' && rows.includes('paiton-flux2-stock-1')))return true;
      const base='http://127.0.0.1:'+port;
      if(model==='llm') {
        const r=await fetch(base+'/metrics',{signal:AbortSignal.timeout(5000)});if(!r.ok)return false;const text=await r.text();
        return ['num_requests_running','num_requests_waiting'].every(metric=>{const values=[...text.matchAll(new RegExp('^vllm:'+metric+'(?:\\{[^\\n]*\\})?\\s+([\\d.eE+-]+)','gm'))];return values.length>0 && values.every(v=>Number(v[1])===0);});
      }
      if(runtimeFor(model)==='comfy'){const q=await call(base,'/queue');return q.queue_running.length===0&&q.queue_pending.length===0;}
      if(model==='qwen-image')return (await call(base,'/health')).busy===false;
      if(model==='tts')return (await call(base,'/health')).busy!==true;
      return (await Promise.all([7861,7862].map(p=>call('http://127.0.0.1:'+p,'/health')))).every(r=>r.ready===true);
    }catch{return false;}
  }
  async ready(model) {
    try {
      const base='http://127.0.0.1:'+this.models[model][1];
      if(model==='llm'){if(await this.sleeping())return false;return (await fetch(base+'/health',{signal:AbortSignal.timeout(5000)})).ok;}
      if(runtimeFor(model)==='comfy'){await call(base,'/system_stats');return true;}
      if(model==='qwen-image')return (await call(base,'/health')).status==='ready';
      if(model==='tts')return (await call(base,'/health')).ok===true;
      return (await Promise.all([7861,7862].map(p=>call('http://127.0.0.1:'+p,'/health')))).every(r=>r.ready===true);
    }catch{return false;}
  }
  async stop(model) {const args=[...this.models[model][0]];args[1]='stop';await this.run(ROOT+'lab',args);if(model==='llm'){this.loadedLlmMode=null;this.capacityTokens=null;this.capacityContainer=null;this.llmConfiguration=null;this.kvForecast=null;}}
  // Offline configuration previews use the persisted layout, never live capacity.
  async previewPlan() {
    try {
      const plan=JSON.parse(await readFile(this.kvPreviewPath??ROOT+'workspace/data/llm/paiton/runtime/qwen38/workbench-kv-plan.json','utf8'));
      if(plan.version!==2||!plan.id||!plan.matrix||typeof plan.matrix!=='object')return null;
      return {...plan,preview_only:true};
    }catch{return null;}
  }
  async llmMode() {
    try {
      const runtime=JSON.parse(await readFile(ROOT+'.workbench/runtime/rocm101/active.json','utf8')).llm;
      const image=await this.run('docker',['inspect','--format','{{.Config.Image}}','paiton-qwen38']);
      if(runtime?.target&&image!==runtime.target){this.loadedLlmMode=null;return null;}
      const args=JSON.parse(await this.run('docker',['inspect','--format','{{json .Config.Cmd}}','paiton-qwen38']));
      const context=args[args.indexOf('--max-model-len')+1],seqs=args[args.indexOf('--max-num-seqs')+1];
      const kv=args[args.indexOf('--kv-cache-memory-bytes')+1];
      const env=JSON.parse(await this.run('docker',['inspect','--format','{{json .Config.Env}}','paiton-qwen38']));
      this.kvPlanId=env.find(value=>value.startsWith('WORKBENCH_KV_PLAN_ID='))?.split('=')[1]??null;
      this.kvForecast=null;
      if(this.kvPlanId)try{const plan=JSON.parse(await readFile(ROOT+'workspace/data/llm/paiton/runtime/qwen38/workbench-kv-plan.json','utf8'));if(plan.id===this.kvPlanId&&plan.context_tokens===Number(context)&&plan.concurrency===Number(seqs))this.kvForecast=plan;}catch{}
      this.llmConfiguration={context_tokens:Number(context),concurrency:Number(seqs),kv_budget_bytes:args.includes('--kv-cache-memory-bytes')&&Number(kv)>0?Number(kv):null,eager:args.includes('--enforce-eager'),lm_head:env.includes('PAITON_LMHEAD_W8=0')?'bf16':null,prefix_caching:args.includes('--enable-prefix-caching')&&!args.includes('--no-enable-prefix-caching'),mamba_cache_mode:args.includes('--mamba-cache-mode')?args[args.indexOf('--mamba-cache-mode')+1]:null};
      this.llmConfiguration.pool_allocated_bytes=allocatedPoolBytes(this.kvForecast,this.llmConfiguration);
      this.loadedLlmMode=Number(kv)>=2**30&&env.includes('PAITON_LMHEAD_W8=0')&&
        env.some(value=>value.startsWith('HIP_VISIBLE_DEVICES='))&&!env.some(value=>value.split('=')[0]==='CUDA_VISIBLE_DEVICES')&&env.includes('WORKBENCH_ROCM_HIP=1')&&env.includes('WORKBENCH_CONFIGURATION_VERSION=2')&&this.llmConfiguration.prefix_caching&&this.llmConfiguration.mamba_cache_mode==='align'&&
        args[args.indexOf('--max-num-batched-tokens')+1]===(Number(context)<=65536?'4096':'1024')&&
        (Number(context)<=65536?(!args.includes('--long-prefill-token-threshold')||args[args.indexOf('--long-prefill-token-threshold')+1]==='0'):args[args.indexOf('--long-prefill-token-threshold')+1]==='512')&&
        env.includes('RADIANCE_GDN_LAZY=0')
        ?enginePolicyKey(servingPolicy('custom',Number(context),Number(seqs),args.includes('--enforce-eager'),Number(kv))):null;
      if(this.loadedLlmMode)await this.readCapacity();
      if(this.loadedLlmMode){const budget=await this.readStartupBudget();if(budget)Object.assign(this.llmConfiguration,{weights_bytes:budget.weights_bytes,free_at_load_bytes:budget.free_at_load_bytes,graph_capture_bytes:budget.graph_capture_bytes});}
    }catch{this.loadedLlmMode=null;this.llmConfiguration=null;this.kvForecast=null;}
    return this.loadedLlmMode;
  }
  async readStartupBudget() {
    const id=await this.run('docker',['inspect','--format','{{.Id}}','paiton-qwen38']);
    if(this.startupBudgetContainer===id&&this.startupBudget)return this.startupBudget;
    this.startupBudget=null;this.startupBudgetContainer=null;
    try {
      const {stdout,stderr}=await this.capture('docker',['logs','--tail','3000','paiton-qwen38'],{timeout:5000,maxBuffer:4*1024*1024});
      const saved=await this.startupLogs();
      const text=(saved?.id===id?saved.output+'\n':'')+stdout+'\n'+stderr, gib=value=>Number.parseFloat(value.replaceAll(',',''))*2**30;
      // A fresh container logs each of these exactly once; the first match is this run.
      const weights=/Model loading took ([\d.]+) GiB/.exec(text);
      const free=/Initial free memory ([\d.]+) GiB/.exec(text);
      const graph=/Graph capturing finished in [\d.]+ secs, took ([\d.]+) GiB/.exec(text);
      if(weights&&free){
        this.startupBudget={container:id,weights_bytes:gib(weights[1]),free_at_load_bytes:gib(free[1]),
          graph_capture_bytes:graph?gib(graph[1]):null,graph_monitored:!!graph};
        this.startupBudgetContainer=id;
      }
    }catch{}
    return this.startupBudget??null;
  }
  async readCapacity() {
    const id=await this.run('docker',['inspect','--format','{{.Id}}','paiton-qwen38']);
    if(this.capacityContainer===id&&this.capacityTokens)return;
    this.capacityTokens=null;
    try {
      const {stdout,stderr}=await this.capture('docker',['logs','--tail','3000','paiton-qwen38'],{timeout:5000,maxBuffer:4*1024*1024});
      let matches=[...(stdout+'\n'+stderr).matchAll(/GPU KV cache size:\s*([\d,]+) tokens/g)];
      if(!matches.length){const startup=await this.startupLogs();if(startup?.id===id)matches=[...startup.output.matchAll(/GPU KV cache size:\s*([\d,]+) tokens/g)];}
      if(matches.length){this.capacityTokens=Number(matches.at(-1)[1].replaceAll(',',''));this.capacityContainer=id;}
    }catch{}
  }
  logReaders=new Map();
  async containerLogs(container,options={}) {
    let reader=this.logReaders.get(container);
    if(reader?.pending)return reader.pending.then(()=>this.containerLogResult(container,reader,options));
    if(reader&&Date.now()-reader.updatedAt<1000)return this.containerLogResult(container,reader,options);
    if(!reader){reader={buffer:new EngineLogBuffer(),updatedAt:0};this.logReaders.set(container,reader);}
    reader.pending=(async()=>{
      try{
        const id=await this.run('docker',['inspect','--format','{{.Id}}',container],{timeout:4000});
        if(id!==reader.id){reader.id=id;reader.buffer=new EngineLogBuffer();}
        const cursor=reader.buffer.cursor;
        const {stdout,stderr}=await this.capture('bash',['-c',cursor?'exec docker logs --timestamps --tail 10000 --since "$2" "$1" 2>&1':'exec docker logs --timestamps --tail 10000 "$1" 2>&1','engine-logs',container,...(cursor?[cursor]:[])],{timeout:4000,maxBuffer:8*1024*1024});
        reader.buffer.ingest(stdout+stderr);reader.available=true;reader.error=null;
      }catch{reader.available=false;reader.error='日志读取暂时失败，已保留上次输出；正在重试。';}
      finally{reader.updatedAt=Date.now();}
    })();
    try{await reader.pending;}finally{reader.pending=null;}
    return this.containerLogResult(container,reader,options);
  }
  containerLogResult(container,reader,options){
    return {container,id:reader.id,output:reader.buffer.output(options),available:reader.available,suppressed:reader.buffer.suppressed,error:reader.error};
  }
  async engineLogs(model='llm',{since,includeProbes=false}={}) {
    const entry=this.models[model];
    if(!entry)return {model:null,engine:null,containers:[],output:'当前没有运行中的模型，等待任务。',available:false};
    let engine={llm:'vLLM','qwen-image':'Qwen-Image',h3:'ComfyUI',flux:'FLUX / Paiton',tts:'CosyVoice'}[model];
    let containers=[entry[2]];
    if(model==='flux'){
      try{const rows=await this.rows();const active=['paiton-flux2-paiton-1','paiton-flux2-stock-1'].filter(name=>rows.includes(name));if(active.length)containers=active;engine=containers.includes('paiton-flux2-stock-1')?(containers.length>1?'FLUX / Paiton + Diffusers':'FLUX / Diffusers'):'FLUX / Paiton';}catch{}
    }
    const results=await Promise.all(containers.map(container=>this.containerLogs(container,{since,includeProbes})));
    const startup=model==='llm'?await this.startupLogs():null;
    return {model,engine,containers,output:results.map(r=>(containers.length>1?'── '+r.container+' ──\n':'')+r.output).join('\n'),available:results.some(r=>r.available),
      startup_output:startup?.output??null,startup_complete:startup?.complete??false,container_id:results.map(r=>r.id).filter(Boolean).join(',')||null,
      suppressed_probe_lines:results.reduce((n,r)=>n+r.suppressed,0),include_probes:includeProbes,log_error:results.find(r=>r.error)?.error??null};
  }
  async startupLogs() {
    try {
      const id=await this.run('docker',['inspect','--format','{{.Id}}','paiton-qwen38']);
      if(this.startupLog?.id===id&&this.startupLog.complete)return this.startupLog;
      const path=this.startupLogPath??ROOT+'workspace/data/scheduler/llm-startup.json';
      try{const saved=JSON.parse(await readFile(path,'utf8'));if(saved.id===id&&saved.complete){this.startupLog=saved;return saved;}}catch{}
      const {stdout,stderr}=await this.capture('bash',['-c','docker logs --timestamps "$1" 2>&1 | head -n 1500','startup-logs','paiton-qwen38'],{timeout:4000,maxBuffer:4*1024*1024});
      const lines=(stdout+stderr).split('\n'),end=lines.findIndex(line=>line.includes('Application startup complete.'));
      const record={id,complete:end>=0,output:(end>=0?lines.slice(0,end+1):lines).join('\n')};
      this.startupLog=record;
      if(record.complete){await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(record));}
      return record;
    }catch{return null;}
  }
  async ensure(model,deadline,clock,policy=servingPolicy('long'),report=()=>{}) {
    const mode=model==='llm'?enginePolicyKey(policy):null;
    let active=await this.running();if(active.length===1&&this.sameRuntime(active[0],model)&&await this.ready(model)&&
      (model!=='llm'||await this.llmMode()===mode))return;
    if(active.length)report('draining','等待当前引擎任务结束');
    while(active.length){
      if(clock()>=deadline)throw new Error('Timed out waiting for active GPU requests');
      if((await Promise.all(active.map(k=>this.idle(k)))).every(Boolean)){await pause(1000);if((await Promise.all(active.map(k=>this.idle(k)))).every(Boolean))break;}
      await pause(1000);active=await this.running();
    }
    for(const old of active){report('unloading',`释放 ${old} 引擎`);let preserved=false;if(old==='llm'&&model!=='llm'){try{report('unloading','将 Qwen 权重迁移到 CPU');preserved=await this.sleep();if(preserved)report('unloading','Qwen 权重已保留在 CPU');}catch(e){report('unloading',`CPU 保留失败，改为释放容器：${e.message}`);}}if(!preserved){await this.stop(old);if(old==='llm')this.loadedLlmMode=null;}}
    if(model==='llm'&&await this.sleeping()&&await this.llmMode()===mode){
      report('loading','从 CPU 唤醒 Qwen 权重');
      try {await call('http://127.0.0.1:18983','/wake_up',{},(await this.config()).transition_timeout_seconds*1000);if(!await this.sleeping()&&await this.ready(model))return;}catch(e){report('loading',`唤醒失败，改为冷启动：${e.message}`);}await this.stop(model);
    }
    if(model==='llm'&&(await this.labelled()||(await this.rows()).includes('paiton-qwen38')))await this.stop(model);
    const start=async cold=>{
      report('loading',`启动 ${model} 引擎${cold?' · 冷启动重试':''}`);
      const args=[...this.models[model][0]];
      if(model==='llm')args.push('--context',String(policy.context_tokens),'--max-num-seqs',String(policy.concurrency),
        '--kv-cache-memory-bytes',String(policy.kv_budget_bytes),'--lm-head','bf16','--eager-mode',policy.eager?'on':'off');
      await this.run(ROOT+'lab',args,{timeout:180000,env:{...process.env,...(cold?{LAB_LLM_RESIDENCY_DISABLE:'1'}:{})},onOutput:output=>report('loading',output,'launcher')});
      report('health-check','等待目标引擎健康检查通过');
      while(!await this.ready(model)){if(clock()>=deadline)throw new Error('Model startup timeout; inspect worker logs');if(model==='llm'&&await this.labelled()&&!['running','created'].includes(await this.run('docker',['inspect','--format','{{.State.Status}}','paiton-qwen38'])))throw new Error('Resident LLM exited during startup');await pause(2000);}
      if(model==='llm'){if(await this.llmMode()!==mode)throw new Error('LLM started with an unexpected context or concurrency configuration');}
    };
    try {await start(false);}catch(e){if(model!=='llm'||!(await this.config()).enabled)throw e;report('loading',`启动失败，重新冷启动：${e.message}`);await this.stop(model);await start(true);}
  }
}
