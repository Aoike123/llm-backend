import test from 'node:test';
import assert from 'node:assert/strict';
import {Backend,command} from '../lib/backend.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('startup logs survive gateway restart, exclude runtime noise and follow container identity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'workbench-startup-'));
 try{
  const b=new Backend();b.startupLogPath=join(dir,'startup.json');let id='first',reads=0;b.run=async()=>id;
  b.capture=async()=>{reads++;return {stdout:'loading weights\nGPU KV cache size: 290,785 tokens\nApplication startup complete.\nGET /health\n',stderr:''};};
  const startup=await b.startupLogs();assert.equal(startup.complete,true);assert.match(startup.output,/loading weights/);assert.doesNotMatch(startup.output,/GET \/health/);
  await b.startupLogs();assert.equal(reads,1);
  const restarted=new Backend();restarted.startupLogPath=b.startupLogPath;restarted.run=async()=>id;
  restarted.capture=async()=>({stdout:'GET /health',stderr:''});await restarted.readCapacity();assert.equal(restarted.capacityTokens,290785);
  assert.equal((await restarted.startupLogs()).output,startup.output);
  id='second';restarted.capture=async()=>({stdout:'new engine loading',stderr:''});
  const next=await restarted.startupLogs();assert.equal(next.id,'second');assert.equal(next.complete,false);assert.equal(next.output,'new engine loading');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('cold switch verifies idle twice before stop and start',async()=>{
 const b=new Backend(),events=[];b.running=async()=>['flux'];b.idle=async()=>{events.push('idle');return true;};b.ready=async()=>true;b.stop=async m=>events.push('stop:'+m);b.run=async(_,args)=>{events.push('start:'+args[0]);return '';};
 await b.ensure('qwen-image',performance.now()/1000+10,()=>performance.now()/1000);assert.deepEqual(events,['idle','idle','stop:flux','start:pation-model-qwen-image-21']);
});
test('failed LLM sleep falls back to stop before media starts',async()=>{
 const b=new Backend(),events=[];b.running=async()=>['llm'];b.idle=async()=>true;b.ready=async()=>true;b.sleep=async()=>{throw new Error('offload failed');};b.stop=async m=>events.push('stop:'+m);b.run=async()=>{events.push('start');return '';};
 await b.ensure('flux',performance.now()/1000+10,()=>performance.now()/1000);assert.deepEqual(events,['stop:llm','start']);
});
test('missing GPU activity metrics retain busy status',async()=>{
 const b=new Backend();b.rows=async()=>['paiton-qwen38'];const old=globalThis.fetch;globalThis.fetch=async()=>({ok:true,text:async()=> 'vllm:num_requests_running 0\n'});
 try{assert.equal(await b.idle('llm'),false);}finally{globalThis.fetch=old;}
});
test('insufficient RAM skips CPU offload without issuing a request',async()=>{
 const b=new Backend();b.config=async()=>({enabled:true,models:['llm'],minimum_available_memory_gib:32});b.labelled=async()=>true;b.memory=async()=>31*2**30;assert.equal(await b.sleep(),false);
});
test('matching context, concurrency and BF16 worker is reused',async()=>{
 const b=new Backend(),policy={context_tokens:65536,concurrency:2,kv_budget_bytes:8859648000};
 b.running=async()=>['llm'];b.ready=async()=>true;b.llmMode=async()=> '65536:2:bf16:8859648000:graph';b.run=async()=>{throw new Error('Should not reload');};
 await b.ensure('llm',performance.now()/1000+10,()=>performance.now()/1000,policy);
});
test('different serving limits stop and launch with actual context, concurrency and fixed KV',async()=>{
 const b=new Backend(),policy={context_tokens:65536,concurrency:2,kv_budget_bytes:8859648000},events=[];
 b.running=async()=>['llm'];b.ready=async()=>true;b.idle=async()=>true;b.sleeping=async()=>false;b.labelled=async()=>false;b.rows=async()=>[];
 let mode='262144:8:bf16:8859648000:graph';b.llmMode=async()=>mode;
 b.stop=async()=>{events.push('stop');};b.run=async(_,args)=>{events.push(args);mode='65536:2:bf16:8859648000:graph';};
 await b.ensure('llm',performance.now()/1000+10,()=>performance.now()/1000,policy);
 assert.equal(events[0],'stop');const args=events[1];
 for(const [flag,value] of [['--context','65536'],['--max-num-seqs','2'],['--kv-cache-memory-bytes','8859648000'],['--lm-head','bf16']])assert.equal(args[args.indexOf(flag)+1],value);
});
test('capacity is read from real worker log output including stderr and refreshed for new containers',async()=>{
 const b=new Backend();let id='one';b.run=async()=>id;b.capture=async()=>({stdout:'',stderr:'GPU KV cache size: 380,928 tokens'});
 await b.readCapacity();assert.equal(b.capacityTokens,380928);
 id='two';b.capture=async()=>({stdout:'GPU KV cache size: 381,440 tokens',stderr:''});await b.readCapacity();assert.equal(b.capacityTokens,381440);
});

test('engine log output retains native messages and is not scoped to policy changes',async()=>{
  const b=new Backend();
  b.startupLogs=async()=>null;b.run=async()=> 'instance-one';
  b.capture=async(bin,args)=>{
    assert.equal(bin,'bash');
    assert.deepEqual(args,['-c','exec docker logs --timestamps --tail 10000 "$1" 2>&1','engine-logs','paiton-qwen38']);
    return {stdout:'native progress\n\n',stderr:'INFO GET /health\nWARNING diagnostic\nTraceback\n'};
  };
  const logs=await b.engineLogs('llm');assert.equal(logs.available,true);assert.equal(logs.output,'native progress\n\nINFO GET /health\nWARNING diagnostic\nTraceback');assert.equal(logs.model,'llm');assert.equal(logs.engine,'vLLM');assert.deepEqual(logs.containers,['paiton-qwen38']);
});

test('engine output follows each media model and the active FLUX implementation',async()=>{
 const b=new Backend(),seen=[];b.run=async(_,args)=>args.at(-1)+'-id';b.rows=async()=>['paiton-flux2-stock-1'];b.capture=async(_,args)=>{seen.push(args.at(-1));return {stdout:'model output',stderr:''};};
 for(const model of ['qwen-image','h3','flux']){const logs=await b.engineLogs(model);assert.equal(logs.model,model);assert.equal(logs.available,true);assert.equal(logs.output,'model output');}
 assert.deepEqual(seen,['paiton-qwen-image21','paiton-h3-comfyui-1','paiton-flux2-stock-1']);
 assert.equal((await b.engineLogs('flux')).engine,'FLUX / Diffusers');
 const before=seen.length;assert.equal((await b.engineLogs(null)).available,false);assert.equal(seen.length,before);
 b.rows=async()=>['paiton-flux2-paiton-1','paiton-flux2-stock-1'];const both=await b.engineLogs('flux');assert.equal(both.containers.length,2);assert.match(both.output,/paiton-flux2-paiton-1/);assert.match(both.output,/paiton-flux2-stock-1/);
});

test('offline preview survives missing engine without inspecting or starting a container',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'workbench-preview-'));
 try{
  const {writeFile}=await import('node:fs/promises');
  const b=new Backend();b.kvPreviewPath=join(dir,'plan.json');b.run=async()=>{throw Error('must not call docker');};
  const plan={version:2,id:'captured-layout',matrix:{'54272:6:graph':{block_bytes:14336000,blocks_per_request:89}}};
  await writeFile(b.kvPreviewPath,JSON.stringify(plan));
  const saved=await b.previewPlan();assert.equal(saved.preview_only,true);assert.deepEqual(saved.matrix,plan.matrix);
  assert.equal(b.kvForecast,undefined);assert.equal(b.capacityTokens,undefined);
  await writeFile(b.kvPreviewPath,'invalid');assert.equal(await b.previewPlan(),null);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('launch output streams stdout and stderr before command completion',async()=>{
 let completed=false;const chunks=[];
 const output=await command(process.execPath,['-e',"process.stdout.write('loading\\n');process.stderr.write('warning\\n');setTimeout(()=>process.stdout.write('ready\\n'),60)"],{onOutput:chunk=>{assert.equal(completed,false);chunks.push(chunk);}});
 completed=true;assert.match(chunks.join(''),/loading/);assert.match(chunks.join(''),/warning/);assert.match(output,/ready/);
});
test('switch log cutoff excludes previous runtime without discarding the shared log buffer',async()=>{
 const b=new Backend();b.run=async()=> 'instance-one';
 b.capture=async()=>({stdout:'2026-10-15T00:00:00.000000000Z previous runtime\n2026-10-15T01:00:00.000000000Z new startup',stderr:''});
 assert.equal((await b.engineLogs('h3',{since:'2026-10-15T01:00:00.000Z'})).output,'2026-10-15T01:00:00.000000000Z new startup');
 assert.match((await b.engineLogs('h3')).output,/previous runtime/);
});
test('container logs follow incrementally, coalesce concurrent readers and reset on recreation',async()=>{
 const b=new Backend();let id='first',captures=0;
 b.run=async()=>id;
 b.capture=async(_,args)=>{captures++;if(captures===2){assert.match(args[1],/--since/);assert.equal(args.at(-1),'2026-10-16T00:00:00.000000001Z');}
  return {stdout:captures===1?'2026-10-16T00:00:00.000000001Z first generation':captures===2?'2026-10-16T00:00:00.000000001Z first generation\n2026-10-16T00:00:01.000000000Z second generation':'2026-10-16T01:00:00.000000000Z recreated engine',stderr:''};};
 await Promise.all([b.engineLogs('h3'),b.engineLogs('h3')]);assert.equal(captures,1);
 b.logReaders.get('paiton-h3-comfyui-1').updatedAt=0;
 assert.match((await b.engineLogs('h3')).output,/first generation[\s\S]*second generation/);
 id='second';b.logReaders.get('paiton-h3-comfyui-1').updatedAt=0;
 const result=await b.engineLogs('h3');assert.equal(result.container_id,'second');assert.doesNotMatch(result.output,/first generation/);
});
test('worker reuse requires prefix caching with aligned recurrent state',async()=>{
 const {readFile}=await import('node:fs/promises');
 const runtime=JSON.parse(await readFile(new URL('../../../.workbench/runtime/rocm101/active.json',import.meta.url),'utf8'));
 const args=['serve','--max-model-len','196608','--max-num-seqs','2','--kv-cache-memory-bytes','8859648000','--max-num-batched-tokens','1024','--long-prefill-token-threshold','512','--mamba-cache-mode','align','--enable-prefix-caching'];
 const env=['HIP_VISIBLE_DEVICES=0','PAITON_LMHEAD_W8=0','WORKBENCH_ROCM_HIP=1','WORKBENCH_CONFIGURATION_VERSION=2','RADIANCE_GDN_LAZY=0'];
 const b=new Backend();b.readCapacity=async()=>{};b.readStartupBudget=async()=>null;
 b.run=async(_,command)=>command.includes('{{.Config.Image}}')?runtime.llm.target:command.includes('{{json .Config.Cmd}}')?JSON.stringify(args):JSON.stringify(env);
 assert.equal(await b.llmMode(),'196608:2:bf16:8859648000:graph');assert.equal(b.llmConfiguration.prefix_caching,true);
 args[args.indexOf('--enable-prefix-caching')]='--no-enable-prefix-caching';assert.equal(await b.llmMode(),null);
 args[args.indexOf('--no-enable-prefix-caching')]='--enable-prefix-caching';args[args.indexOf('--mamba-cache-mode')+1]='none';assert.equal(await b.llmMode(),null);
});
