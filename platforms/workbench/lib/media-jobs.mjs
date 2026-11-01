import {readFile,readdir,mkdir,stat,rename,open,chmod} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import sharp from 'sharp';
import {CAPABILITIES,capabilityForTool,validateInput,candidates} from './capabilities.mjs';
import {registry} from './registry.mjs';
import {atomic,uid,fail} from './media-store.mjs';
import {executeMedia} from './media-executor.mjs';
import {pause} from './core.mjs';
import {linkCoordinator} from './access-keys.mjs';
const terminal=new Set(['succeeded','failed','cancelled','unknown']);
const needsRecovery=j=>(!terminal.has(j.state)&&!preDispatch.has(j.state))||(j.state==='unknown'&&j.recovery_required!==false);
const preDispatch=new Set(['queued','preparing','waiting_for_admission','waiting_for_engine']);
// Stored jobs predate the capability field; the tool name identifies it.
const capabilityOf=job=>job.capability??capabilityForTool(job.tool);
// Engines that can stop a running prompt declare it; others finish a request once started.
const interruptible=j=>registry.enginePackage(j.engine)?.manifest.platform.interruptible===true&&['dispatching','running'].includes(j.state)&&!j.cancel_requested_at;
const canonical=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
const LEGACY_OUTPUT={image:'output.png',video:'output.mp4'};
async function durable(tmp,file){await chmod(tmp,0o600);const fd=await open(tmp,'r');try{await fd.sync();}finally{await fd.close();}await rename(tmp,file);}
async function probe(file){return JSON.parse((await promisify(execFile)('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',file],{timeout:30000,maxBuffer:2**20})).stdout);}
export class MediaJobs{
  constructor(store,keys,coordinator,metrics,lifecycle,{execute=executeMedia}={}){Object.assign(this,{store,keys,coordinator,metrics,lifecycle,execute});if(keys&&coordinator&&!coordinator.keys)linkCoordinator(keys,coordinator);this.jobs=new Map();this.controllers=new Map();this.workers=new Set();this.pending=Promise.resolve();this.recoveryPending=false;this.stopped=false;this.preparedBytes=0;this.preparationBudget=512*2**20;}
  serial(fn){const task=this.pending.then(fn);this.pending=task.catch(()=>{});return task;}
  persist(job){return atomic(join(this.store.jobs,job.job_id,'job.json'),job);}
  async change(job,state,extra={}){return this.serial(async()=>{if(job.state==='cancelled'&&state!=='cancelled')throw fail('Cancelled',409);const next={...job,state,updated_at:new Date().toISOString(),...extra};await this.persist(next);Object.assign(job,next);return job;});}
  async open(){
    for(const id of await readdir(this.store.jobs)){
      if(!/^job_[a-f0-9]{32}$/.test(id))continue;
      try{const job=JSON.parse(await readFile(join(this.store.jobs,id,'job.json'),'utf8'));this.jobs.set(id,job);}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    if(process.env.WORKBENCH_READ_ONLY==='1'){this.recovery=Promise.resolve();return this;}
    this.recoveryPending=[...this.jobs.values()].some(needsRecovery);
    // Both synchronous API and mode changes must respect the startup recovery barrier.
    this.coordinator.mediaRecovery=()=>this.recoveryPending;
    this.recovery=this.recover().then(()=>{for(const job of this.jobs.values())if(preDispatch.has(job.state))this.launch(job);}).catch(e=>{console.error('Media recovery blocked:',e.message);});
    return this;
  }
  async backendIdle(engine){
    try{if(await this.coordinator.backend.idle(engine))return true;
      if(this.coordinator.backend.running&&!(await this.coordinator.backend.running()).includes(engine))return true;
    }catch{}return false;
  }
  async waitIdle(engine){while(!await this.backendIdle(engine))await pause(1000);}
  async recover(){
    const pending=[...this.jobs.values()].filter(needsRecovery);
    for(const job of pending){
      const original=job.state;await this.change(job,'recovering');let restored=false;
      // A completed atomic output may already be on disk when saving metadata was interrupted.
      if(original==='saving'&&LEGACY_OUTPUT[job.kind]){
        try{
          const file=join(this.store.outputDirectory(job),LEGACY_OUTPUT[job.kind]);await stat(file);
          const result=job.kind==='image'?{data:[{b64_json:(await readFile(file)).toString('base64')}]}:{data:[{local_path:file}]};
          await this.finish(job,{...result,metrics:{recovered:true}});restored=true;
        }catch{}
      }
      const adapter=await registry.adapter(job.engine).catch(()=>null);
      if(!restored&&adapter?.recover)restored=await adapter.recover(job,{finish:(j,r)=>this.finish(j,r),change:(j,s,e)=>this.change(j,s,e),backendIdle:e=>this.backendIdle(e),outputDirectory:this.store.outputDirectory(job)}).catch(()=>false);
      if(!restored)await this.change(job,'unknown',{error:{code:'OUTCOME_UNKNOWN',message:'Gateway restarted after dispatch. No automatic resubmission; inspect backend history.'}});
      // Even an unknown job remains a restart barrier until the backend is observably idle or stopped.
      await this.waitIdle(job.engine);await this.change(job,job.state,{recovery_required:false});
    }
    this.recoveryPending=false;
  }
  get(owner,id){const job=this.jobs.get(id);if(!job||job.owner_id!==owner)throw fail('Job not found',404);return job;}
  public(job){const {request,owner_id,fingerprint,backend,...value}=job;return {...value,cancellable:preDispatch.has(job.state)||interruptible(job),poll_after_seconds:terminal.has(job.state)?0:5};}
  list(owner,{offset=0,limit=20}={}){const rows=[...this.jobs.values()].filter(j=>j.owner_id===owner).reverse();return {jobs:rows.slice(offset,offset+limit).map(j=>this.public(j)),offset,has_more:offset+limit<rows.length,total:rows.length};}
  // Engine-specific reference checks; returns the bytes preparation may hold in memory.
  async validateAssets(owner,capability,input,model){
    const asset=(id,kind)=>this.store.getAsset(owner,id,kind),adapter=await registry.adapter(model.engine);
    const refs=adapter?.assets?.(capability,input,{asset,model})??[];
    const estimate=128*2**20+refs.reduce((total,a)=>total+a.bytes*3,0);
    if(estimate>this.preparationBudget)throw fail('Combined references exceed the 512 MiB preparation memory budget',413);
    return estimate;
  }
  async create(owner,tool,input){
    const capability=capabilityForTool(tool);if(!capability)throw fail('Invalid generation tool');
    tool=CAPABILITIES[capability].tool;
    await validateInput(tool,input);
    const asset=(id,kind)=>this.store.getAsset(owner,id,kind);
    const {models,pinned}=await candidates(capability,input,{assets:asset});
    await this.validateAssets(owner,capability,input,models[0]);
    const fingerprint=createHash('sha256').update(canonical({tool,input})).digest('hex');
    return this.serial(async()=>{
      const existing=[...this.jobs.values()].find(j=>j.owner_id===owner&&j.request_id===input.request_id);
      if(existing){if(existing.fingerprint!==fingerprint)throw fail('request_id already used with different arguments',409);return this.public(existing);}
      if(this.lifecycle.draining||this.stopped)throw fail('Gateway draining',503);
      this.coordinator.assertAcceptingRequests();
      const active=[...this.jobs.values()].filter(j=>!terminal.has(j.state));
      if(active.length>=32||active.filter(j=>j.owner_id===owner).length>=8)throw fail('Pending media job quota reached',429);
      if(this.jobs.size>=10000)throw fail('Job history quota reached; archive old jobs',507);
      await this.store.quota(256*2**20*(active.length+1));
      const first=models[0];
      const job={job_id:uid('job'),request_id:input.request_id,owner_id:owner,tool,capability,model:first.id,candidates:models.map(m=>m.id),pinned,engine:first.engine,kind:CAPABILITIES[capability].kind,state:'queued',request:structuredClone(input),fingerprint,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),artifacts:[]};
      (await registry.adapter(first.engine))?.onCreate?.(job,input,{asset});
      await this.persist(job);this.jobs.set(job.job_id,job);this.launch(job);return this.public(job);
    });
  }
  launch(job){const work=this.run(job).catch(e=>console.error('Media job persistence failure:',e.message)).finally(()=>this.workers.delete(work));this.workers.add(work);}
  async cancel(owner,id){return this.cancelJob(this.get(owner,id));}
  // Local console: same rules, any owner.
  async cancelAny(id){const job=this.jobs.get(id);if(!job)throw fail('Job not found',404);return this.cancelJob(job);}
  async cancelJob(job){
    const interrupt=await this.serial(async()=>{
      if(preDispatch.has(job.state)){this.controllers.get(job.job_id)?.abort();job.state='cancelled';job.updated_at=new Date().toISOString();await this.persist(job);return null;}
      // Repeating a cancel re-sends the interrupt, so a request that could not reach the backend can be retried.
      if(job.cancel_requested_at&&!terminal.has(job.state))return job.backend?.prompt_id?job.backend:null;
      const declares=registry.enginePackage(job.engine)?.manifest.platform.interruptible===true;
      if(!interruptible(job))throw fail(declares?'Job is saving or finished; it can no longer be cancelled':'This backend cannot interrupt a running request; it finishes on its own',409);
      // The final state comes from the backend: cancelled once it reports the interruption.
      const next={...job,cancel_requested_at:new Date().toISOString(),updated_at:new Date().toISOString()};await this.persist(next);Object.assign(job,next);
      return job.backend?.prompt_id?job.backend:null;
    });
    // Without a prompt_id yet, onSubmitted interrupts as soon as the backend accepts the prompt.
    if(interrupt)await (await registry.adapter(job.engine))?.interrupt?.(interrupt);
    return this.public(job);
  }
  async payload(job,capability=capabilityOf(job),model=registry.model(job.model)??{engine:job.engine}){
    const input=job.request,asset=(id,kind)=>this.store.getAsset(job.owner_id,id,kind);
    const bytes=async(id,kind='image')=>id?readFile(asset(id,kind).file):undefined;
    const adapter=await registry.adapter(model.engine);
    return adapter?.payload?adapter.payload(capability,input,{bytes,asset,job,model}):{...input};
  }
  async reservePreparation(job,signal){
    const bytes=await this.validateAssets(job.owner_id,capabilityOf(job),job.request,registry.model(job.model)??{engine:job.engine}),deadline=Date.now()+900000;
    while(this.preparedBytes+bytes>this.preparationBudget){
      if(signal.aborted)throw fail('Cancelled',409);if(Date.now()>deadline)throw fail('Media preparation wait timed out',503);await pause(100);
    }
    if(signal.aborted)throw fail('Cancelled',409);this.preparedBytes+=bytes;let released=false;
    return ()=>{if(!released){released=true;this.preparedBytes-=bytes;}};
  }
  // Fall back only when nothing was generated: the engine could not start, or refused the work
  // before running it. A backend failure falls back only where routing opts in.
  fallbackAllowed(job,e){
    if(job.state==='cancelled'||job.pinned||e.message==='Cancelled')return false;
    if(e.code==='ENGINE_UNAVAILABLE'||e.code==='NOT_SUBMITTED')return true;
    return e.code==='BACKEND_FAILED'&&registry.routing(capabilityOf(job)).fallback_on_backend_error;
  }
  async run(job){
    const controller=new AbortController();this.controllers.set(job.job_id,controller);
    const state={dispatched:false};let releasePreparation;
    const check=()=>{if(controller.signal.aborted||job.state==='cancelled')throw fail('Cancelled',409);};
    try{
      check();
      const key=this.keys.state.keys.find(k=>k.id===job.owner_id&&k.enabled);if(!key)throw fail('API key revoked',401);
      const enqueuedAt=this.coordinator.clock();this.keys.admit(key);
      releasePreparation=await this.reservePreparation(job,controller.signal);check();
      // Jobs stored before routing carry no candidates; older ones name a workflow, not a model.
      const chain=job.candidates??[registry.model(job.model)?job.model:registry.models().find(m=>m.engine===job.engine)?.id??job.model];
      for(let i=Math.max(0,chain.indexOf(job.model));;i++){
        try{await this.attempt(job,chain[i],{check,signal:controller.signal,enqueuedAt,state});return;}
        catch(e){
          const next=chain.slice(i+1).find(id=>registry.model(id));
          if(!next||!this.fallbackAllowed(job,e))throw e;
          const model=registry.model(next),from=[...(job.fallback_from??[]),{model:chain[i],code:e.code??'JOB_FAILED',message:String(e.message).slice(0,300)}];
          await this.settle(job,state);state.dispatched=false;
          await this.change(job,'waiting_for_engine',{model:next,engine:model.engine,fallback_from:from,backend:undefined});
          console.warn(JSON.stringify({event:'media_job_fallback',job_id:job.job_id,from:chain[i],to:next,code:e.code}));
        }
      }
    }catch(e){
      // Only a lost or ambiguous result is unknown: a failure the backend reported, work that was
      // never submitted, or an unusable returned artifact is final.
      const known={BACKEND_FAILED:'BACKEND_FAILED',ARTIFACT_INVALID:'ARTIFACT_INVALID',NOT_SUBMITTED:'JOB_FAILED',ENGINE_UNAVAILABLE:'ENGINE_UNAVAILABLE'}[e.code],uncertain=state.dispatched&&!known;
      if(e.code==='BACKEND_CANCELLED'&&job.state!=='cancelled')await this.change(job,'cancelled',{error:{code:'CANCELLED',message:job.cancel_requested_at?'Cancelled while running':'Interrupted in ComfyUI'}});
      else if(job.state!=='cancelled')await this.change(job,uncertain?'unknown':'failed',{error:{code:uncertain?'OUTCOME_UNKNOWN':known??'JOB_FAILED',message:uncertain?'Backend outcome is uncertain; inspect backend history before retrying.':(e.code==='API_KEY_INVALID'?'API key revoked':String(e.message).slice(0,300))}});
    }finally{try{await this.settle(job,state);}finally{releasePreparation?.();this.controllers.delete(job.job_id);}}
  }
  async attempt(job,modelId,{check,signal,enqueuedAt,state}){
    const capability=capabilityOf(job),model=registry.model(modelId);
    if(!model)throw Object.assign(new Error(modelId+' is disabled'),{code:'ENGINE_UNAVAILABLE'});
    const adapter=await registry.adapter(model.engine),lease=state.lease={engine:model.engine,started:performance.now(),queue:0,counted:false};
    await this.change(job,'preparing');check();
    const d=await this.payload(job,capability,model),preparedVideos=await adapter?.prepare?.(capability,d);check();
    await this.store.quota(256*2**20);await this.change(job,'waiting_for_engine');check();
    // Durable jobs wait as long as the former admission and GPU queues combined.
    lease.ticket=await this.coordinator.acquire(model.engine,{timeout:1800,profileId:job.model,key:job.owner_id,signal,enqueuedAt});
    lease.timer=setInterval(()=>{try{this.coordinator.renew(lease.ticket.token);}catch{}},30000);check();
    await this.serial(async()=>{check();job.state='dispatching';job.recovery_required=true;job.updated_at=new Date().toISOString();await this.persist(job);state.dispatched=true;});
    // Persist dispatch BEFORE sending. Lost network responses must never trigger an automatic retry.
    if(!adapter?.interrupt)await this.change(job,'running');
    this.metrics.start(model.engine);lease.counted=true;lease.queue=(performance.now()-lease.started)/1000;
    const result=await this.execute(model.engine,d,{capability,model,preparedVideos,outputDirectory:this.store.outputDirectory(job),onSubmitted:async backend=>{await this.change(job,'running',{backend});if(job.cancel_requested_at)await (await registry.adapter(job.engine))?.interrupt?.(backend);}});
    // The backend has returned; a bad artifact is a known failure, not an uncertain outcome.
    try{await this.finish(job,result,{queue_seconds:lease.queue,total_seconds:(performance.now()-lease.started)/1000});}
    catch(e){if(job.state!=='cancelled')e.code??='ARTIFACT_INVALID';throw e;}
  }
  // Runs after the job's state is recorded: ownership is kept until the backend is idle, even
  // when its HTTP response was lost.
  async settle(job,state){
    const lease=state.lease;if(!lease)return;state.lease=null;
    if(lease.ticket){while(true){try{await this.coordinator.release(lease.ticket.token);break;}catch(e){if(e.message==='Invalid lease token')break;await pause(1000);}}}
    try{if(state.dispatched)await this.change(job,job.state,{recovery_required:false});}
    finally{clearInterval(lease.timer);}
    if(lease.counted)this.metrics.finish(lease.engine,job.state==='succeeded'?'success':'error',(performance.now()-lease.started)/1000,lease.queue);
  }
  // Image and video backends return their legacy shapes; newer adapters write their files into
  // the job directory and list them as artifacts.
  async collect(job,result,directory){
    if(Array.isArray(result.artifacts)){
      const root=resolve(directory)+sep,rows=[];
      for(const item of result.artifacts){
        const file=resolve(item.file??'');if(!file.startsWith(root))throw fail('Artifact outside the job directory');
        await stat(file);rows.push({kind:item.kind??job.kind,file,mime:item.mime,name:item.name??null,media:item.media??{}});
      }
      if(!rows.length)throw fail('Backend returned no artifacts');return rows;
    }
    if(job.kind==='image'){
      const encoded=result.data?.[0]?.b64_json;if(typeof encoded!=='string'||encoded.length>48*2**20)throw fail('Invalid generated image');
      const file=join(directory,'output.png'),tmp=file+'.tmp';await sharp(Buffer.from(encoded,'base64'),{limitInputPixels:16777216}).png().toFile(tmp);await durable(tmp,file);
      const m=await sharp(file).metadata();return [{kind:'image',file,mime:'image/png',media:{width:m.width,height:m.height,has_alpha:!!m.hasAlpha}}];
    }
    if(job.kind==='video'){
      const file=result.data?.[0]?.local_path;if(file!==join(directory,'output.mp4'))throw fail('Invalid video artifact path');
      const info=await probe(file),v=info.streams?.find(s=>s.codec_type==='video');if(!v)throw fail('Generated file has no video stream');
      const [n,d]=(v.r_frame_rate??'0/1').split('/').map(Number);
      return [{kind:'video',file,mime:'video/mp4',media:{width:v.width,height:v.height,fps:n/d,frames:Number(v.nb_frames)||null,duration_seconds:Number(v.duration??info.format?.duration)||null,has_audio:info.streams.some(s=>s.codec_type==='audio')}}];
    }
    throw fail('Backend returned no artifacts');
  }
  async finish(job,result,timing={}){
    await this.change(job,'saving');const directory=this.store.outputDirectory(job);await mkdir(directory,{recursive:true,mode:0o700});
    const rows=await this.collect(job,result,directory),artifacts=[];
    for(const row of rows){
      const info=await stat(row.file),artifact={artifact_id:uid('artifact'),kind:row.kind,mime_type:row.mime,bytes:info.size,local_path:row.file,job_id:job.job_id,media:row.media,uri:null,...(row.name?{name:row.name}:{})};
      artifact.uri='media://artifacts/'+artifact.artifact_id;this.store.account(row.file,info.size);artifacts.push(artifact);
    }
    const input=job.request,media=artifacts[0].media,capability=capabilityOf(job);
    const effective={...input,seed:input.seed??42,model:job.model};delete effective.prompt;delete effective.request_id;
    Object.assign(effective,(await registry.adapter(job.engine).catch(()=>null))?.effective?.(capability,input,media,job)??{});
    if(job.kind==='video')Object.assign(effective,{width:media.width,height:media.height,fps:media.fps,effective_frames:media.frames??effective.effective_frames??effective.frames});
    await this.change(job,'succeeded',{artifacts,served_by:job.model,effective_parameters:effective,metrics:{...result.metrics,...timing},finished_at:new Date().toISOString()});
  }
  findArtifact(id){for(const job of this.jobs.values())if(job.state==='succeeded'){const artifact=job.artifacts?.find(a=>a.artifact_id===id);if(artifact)return {owner_id:job.owner_id,artifact};}return null;}
  artifact(owner,id){for(const job of this.jobs.values())if(job.owner_id===owner&&job.state==='succeeded'){const artifact=job.artifacts.find(a=>a.artifact_id===id);if(artifact)return artifact;}throw fail('Artifact not found',404);}
}
