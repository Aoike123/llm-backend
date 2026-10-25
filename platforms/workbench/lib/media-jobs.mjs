import {readFile,readdir,mkdir,stat,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {MODELS,validateInput} from './media-manifest.mjs';
import {atomic,uid,fail} from './media-store.mjs';
import {executeMedia} from './media-executor.mjs';
import {prepareH3Videos} from './h3-references.mjs';
import {validateVideoRequest,saveVideoOutput,comfyFailure} from './media.mjs';
import {call} from './backend.mjs';
import {validateGoldfishControls,goldfishReferenceSlots} from './goldfish-controls.mjs';
import {goldfishFrames,GOLDFISH_SEED} from './goldfish-workflow.mjs';

// One public video tool; the workflow-era name stays accepted for stored jobs and old clients.
const VIDEO_TOOL='generate_video';
const canonicalTool=tool=>tool==='run_goldfish_workflow'?VIDEO_TOOL:tool;
const isVideoTool=tool=>tool===VIDEO_TOOL||tool==='run_goldfish_workflow';
import {pause} from './core.mjs';
import {linkCoordinator} from './access-keys.mjs';
const terminal=new Set(['succeeded','failed','cancelled','unknown']);
const needsRecovery=j=>(!terminal.has(j.state)&&!preDispatch.has(j.state))||(j.state==='unknown'&&j.recovery_required!==false);
const preDispatch=new Set(['queued','preparing','waiting_for_admission','waiting_for_engine']);
const canonical=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
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
      if(original==='saving'){
        try{
          const file=join(this.store.outputDirectory(job),job.kind==='image'?'output.png':'output.mp4');await stat(file);
          const result=job.kind==='image'?{data:[{b64_json:(await readFile(file)).toString('base64')}]}:{data:[{local_path:file}]};
          await this.finish(job,{...result,metrics:{recovered:true}});restored=true;
        }catch{}
      }
      if(!restored&&job.backend?.prompt_id){
        let entry;
        for(let i=0;i<1800;i++){
          try{entry=(await call(job.backend.base,'/history/'+job.backend.prompt_id))[job.backend.prompt_id];}catch{}
          if(entry||await this.backendIdle(job.engine))break;await pause(1000);
        }
        if(entry?.status?.status_str==='success'){
          try{const saved=await saveVideoOutput(job.backend.base,entry,this.store.outputDirectory(job));await this.finish(job,{data:[saved],metrics:{prompt_id:job.backend.prompt_id,recovered:true}});restored=true;}catch{}
        }else if(entry){await this.change(job,'failed',{error:{code:'BACKEND_FAILED',message:entry.status?.status_str==='error'?comfyFailure(entry).message:'Backend reported a failed recovered job'}});restored=true;}
      }
      if(!restored)await this.change(job,'unknown',{error:{code:'OUTCOME_UNKNOWN',message:'Gateway restarted after dispatch. No automatic resubmission; inspect backend history.'}});
      // Even an unknown job remains a restart barrier until the backend is observably idle or stopped.
      await this.waitIdle(job.engine);await this.change(job,job.state,{recovery_required:false});
    }
    this.recoveryPending=false;
  }
  get(owner,id){const job=this.jobs.get(id);if(!job||job.owner_id!==owner)throw fail('Job not found',404);return job;}
  public(job){const {request,owner_id,fingerprint,backend,...value}=job;return {...value,cancellable:preDispatch.has(job.state),poll_after_seconds:terminal.has(job.state)?0:5};}
  list(owner,{offset=0,limit=20}={}){const rows=[...this.jobs.values()].filter(j=>j.owner_id===owner).reverse();return {jobs:rows.slice(offset,offset+limit).map(j=>this.public(j)),offset,has_more:offset+limit<rows.length,total:rows.length};}
  validateAssets(owner,tool,input){
    const refs=[];const add=(id,kind)=>{if(id){const a=this.store.getAsset(owner,id,kind);refs.push(a);return a;}};
    if(isVideoTool(tool)){
      validateGoldfishControls(input);
      for(const id of input.reference_asset_ids??[])add(id,'image');
      for(const id of input.reference_video_asset_ids??[])add(id,'video');
      for(const id of input.reference_audio_asset_ids??[])add(id,'audio');
      const enabled=[...goldfishReferenceSlots(input,'images',input.reference_asset_ids),...goldfishReferenceSlots(input,'videos',input.reference_video_asset_ids),...goldfishReferenceSlots(input,'audios',input.reference_audio_asset_ids)].map(({value})=>refs.find(a=>a.asset_id===value));
      if(enabled.length>12)throw fail('Goldfish supports at most 12 reference files');
      if(enabled.some(a=>a.kind==='audio')&&!enabled.some(a=>a.kind!=='audio'))throw fail('Audio references require image or video references');
      for(const kind of ['video','audio'])if(enabled.filter(a=>a.kind===kind).reduce((sum,a)=>sum+a.seconds,0)>15.05)throw fail('Reference '+kind+' total exceeds 15 seconds');
      if(enabled.some(a=>a.kind==='video'&&a.seconds>goldfishFrames(input.duration_seconds??10)/24+1/24))throw fail('Reference video is longer than the output');
    }
    if(tool==='edit_image'){
      for(const id of input.reference_asset_ids)add(id,'image');
      if(refs.reduce((s,a)=>s+a.width*a.height,0)>4194304)throw fail('Qwen combined reference pixels exceed 4194304');
      if(refs.reduce((s,a)=>s+a.bytes,0)>16*2**20)throw fail('Qwen combined reference files exceed 16 MiB');
    }
    if(tool==='generate_audio'){
      const asset=add(input.reference_asset_id,'audio');
      if(!asset)throw fail('reference_asset_id is required');
      if(asset.seconds<3||asset.seconds>30)throw fail('参考音频需要 3–30 秒');
      if(input.text.length>5000)throw fail('音频文本上限 5000 字符');
      if(input.instruct&&input.instruct.length>500)throw fail('instruct 上限 500 字符');
    }
    if(tool==='generate_image'){
      if(input.model==='flux2-klein'&&(input.mode!==undefined||input.size!==undefined))throw fail('FLUX does not accept mode or size');
      if(input.model==='qwen-image21'&&input.engine!==undefined)throw fail('Qwen does not accept engine');
      if(input.model==='qwen-image21'&&input.prompt.length>4000)throw fail('Qwen prompt is limited to 4000 characters (got '+input.prompt.length+')');
    }
    if(tool==='edit_image'&&input.prompt.length>4000)throw fail('Qwen prompt is limited to 4000 characters (got '+input.prompt.length+')');
    const estimate=128*2**20+refs.reduce((total,asset)=>total+asset.bytes*3,0);
    if(estimate>this.preparationBudget)throw fail('Combined references exceed the 512 MiB preparation memory budget',413);
    return estimate;
  }
  async create(owner,tool,input){
    tool=canonicalTool(tool);
    validateInput(tool,input);this.validateAssets(owner,tool,input);
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
      const model=tool===VIDEO_TOOL?'yz-h3-ultimate-original':tool==='edit_image'?'qwen-image21':tool==='generate_audio'?'cosyvoice3-rl':input.model,info=tool===VIDEO_TOOL?{engine:'h3',kind:'video'}:MODELS.find(m=>m.id===model);
      const job={job_id:uid('job'),request_id:input.request_id,owner_id:owner,tool,model,engine:info.engine,kind:info.kind,state:'queued',request:structuredClone(input),fingerprint,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),artifacts:[]};
      if(tool===VIDEO_TOOL){
        let audioOrdinal=0;
        const images=goldfishReferenceSlots(input,'images',input.reference_asset_ids).map(({index},ordinal)=>({input_slot:index+1,tag:'<Picture '+(ordinal+1)+'>'}));
        const videos=goldfishReferenceSlots(input,'videos',input.reference_video_asset_ids).map(({value,index},ordinal)=>({input_slot:index+1,tag:'<Video '+(ordinal+1)+'>',...(input.reference_video_audio&&this.store.getAsset(owner,value,'video').has_audio?{audio_tag:'<Audio '+(++audioOrdinal)+'>'}:{})}));
        const audios=goldfishReferenceSlots(input,'audios',input.reference_audio_asset_ids).map(({index})=>({input_slot:index+1,tag:'<Audio '+(++audioOrdinal)+'>'}));
        job.reference_mapping={images,videos,audios};
      }
      await this.persist(job);this.jobs.set(job.job_id,job);this.launch(job);return this.public(job);
    });
  }
  launch(job){const work=this.run(job).catch(e=>console.error('Media job persistence failure:',e.message)).finally(()=>this.workers.delete(work));this.workers.add(work);}
  async cancel(owner,id){return this.serial(async()=>{const job=this.get(owner,id);if(!preDispatch.has(job.state))throw fail('Job cannot be cancelled after backend dispatch',409);this.controllers.get(id)?.abort();job.state='cancelled';job.updated_at=new Date().toISOString();await this.persist(job);return this.public(job);});}
  async payload(job){
    const input=job.request,d={prompt:input.prompt,seed:input.seed??42};
    if(job.kind==='audio'){
      const asset=this.store.getAsset(job.owner_id,input.reference_asset_id,'audio');
      return {text:input.text,reference_path:asset.file,reference_text:input.reference_text??'',
              speed:input.speed??1,seed:input.seed??42,...(input.instruct?{instruct:input.instruct}:{})};
    }
    const bytes=async(id,kind='image')=>id?readFile(this.store.getAsset(job.owner_id,id,kind).file):undefined;
    if(isVideoTool(job.tool)){
      const groups=[['images','reference_asset_ids','image'],['videos','reference_video_asset_ids','video'],['audios','reference_audio_asset_ids','audio']],payload={...input,workflow:'yz-h3-ultimate-original'};
      for(const [kind,key,type] of groups){const slots=goldfishReferenceSlots(input,kind,input[key]);payload['reference_'+kind+'_b64']=await Promise.all(slots.map(({value})=>bytes(value,type)));payload['reference_'+kind+'_slots']=slots.map(({index})=>index);}
      return payload;
    }
    if(job.kind==='image'){
      if(job.engine==='flux')d.engine=(input.engine??'paiton')==='paiton'?'Paiton':'Stock (Diffusers)';
      else Object.assign(d,{mode:job.tool==='edit_image'?'edit':input.mode??'text-to-image',size:input.size??'1024x1024',n:1,steps:40,guidance:1,response_format:'b64_json'});
      if(job.tool==='edit_image')d.images_b64=await Promise.all(input.reference_asset_ids.map(async id=>(await bytes(id)).toString('base64')));
    }else{
      for(const key of ['engine','width','height','frames','preset','steps','reference_image_size','reference_video_audio'])if(input[key]!==undefined)d[key]=input[key];
      d.first_frame_b64=await bytes(input.first_frame_asset_id);d.last_frame_b64=await bytes(input.last_frame_asset_id);
      d.reference_images_b64=await Promise.all((input.reference_image_asset_ids??[]).map(id=>bytes(id)));
      d.reference_videos_b64=await Promise.all((input.reference_video_asset_ids??[]).map(id=>bytes(id,'video')));
    }
    return d;
  }
  async reservePreparation(job,signal){
    const bytes=this.validateAssets(job.owner_id,job.tool,job.request),deadline=Date.now()+900000;
    while(this.preparedBytes+bytes>this.preparationBudget){
      if(signal.aborted)throw fail('Cancelled',409);if(Date.now()>deadline)throw fail('Media preparation wait timed out',503);await pause(100);
    }
    if(signal.aborted)throw fail('Cancelled',409);this.preparedBytes+=bytes;let released=false;
    return ()=>{if(!released){released=true;this.preparedBytes-=bytes;}};
  }
  async run(job){
    const controller=new AbortController();this.controllers.set(job.job_id,controller);
    let ticket,timer,releasePreparation,counted=false,dispatched=false;const started=performance.now();let queue=0;
    const check=()=>{if(controller.signal.aborted||job.state==='cancelled')throw fail('Cancelled',409);};
    try{
      check();
      const key=this.keys.state.keys.find(k=>k.id===job.owner_id&&k.enabled);if(!key)throw fail('API key revoked',401);
      const enqueuedAt=this.coordinator.clock();this.keys.admit(key);
      releasePreparation=await this.reservePreparation(job,controller.signal);check();
      await this.change(job,'preparing');check();const d=await this.payload(job),preparedVideos=job.engine==='h3'?(isVideoTool(job.tool)?(d.reference_videos_b64.length?await prepareH3Videos({...d,preset:'reference',frames:goldfishFrames(d.duration_seconds??10)}):[]):await prepareH3Videos(d)):undefined;check();
      await this.store.quota(256*2**20);await this.change(job,'waiting_for_engine');check();
      // Durable jobs wait as long as the former admission and GPU queues combined.
      ticket=await this.coordinator.acquire(job.engine,{timeout:1800,profileId:job.model,key:job.owner_id,signal:controller.signal,enqueuedAt});
      timer=setInterval(()=>{try{this.coordinator.renew(ticket.token);}catch{}},30000);check();
      await this.serial(async()=>{check();job.state='dispatching';job.recovery_required=true;job.updated_at=new Date().toISOString();await this.persist(job);dispatched=true;});
      // Persist dispatch BEFORE sending. Lost network responses must never trigger an automatic retry.
      if(job.kind==='image'||job.kind==='audio')await this.change(job,'running');
      this.metrics.start(job.engine);counted=true;queue=(performance.now()-started)/1000;
      const result=await this.execute(job.engine,d,{path:job.tool==='edit_image'?'/v1/images/edits':'/v1/images/generations',preparedVideos,outputDirectory:this.store.outputDirectory(job),onSubmitted:backend=>this.change(job,'running',{backend})});
      // The backend has returned; a bad artifact is a known failure, not an uncertain outcome.
      try{await this.finish(job,result,{queue_seconds:queue,total_seconds:(performance.now()-started)/1000});}
      catch(e){if(job.state!=='cancelled')e.code??='ARTIFACT_INVALID';throw e;}
    }catch(e){
      // Only a lost or ambiguous result is unknown: a failure the backend reported, work that was
      // never submitted, or an unusable returned artifact is final.
      const known={BACKEND_FAILED:'BACKEND_FAILED',ARTIFACT_INVALID:'ARTIFACT_INVALID',NOT_SUBMITTED:'JOB_FAILED'}[e.code],uncertain=dispatched&&!known;
      if(job.state!=='cancelled')await this.change(job,uncertain?'unknown':'failed',{error:{code:uncertain?'OUTCOME_UNKNOWN':known??'JOB_FAILED',message:uncertain?'Backend outcome is uncertain; inspect backend history before retrying.':(e.code==='API_KEY_INVALID'?'API key revoked':String(e.message).slice(0,300))}});
    }finally{
      // Keep renewing ownership until backend idle even when its HTTP response was lost.
      if(ticket){while(true){try{await this.coordinator.release(ticket.token);break;}catch(e){if(e.message==='Invalid lease token')break;await pause(1000);}}}
      try{if(dispatched)await this.change(job,job.state,{recovery_required:false});}
      finally{clearInterval(timer);releasePreparation?.();this.controllers.delete(job.job_id);}
      if(counted)this.metrics.finish(job.engine,job.state==='succeeded'?'success':'error',(performance.now()-started)/1000,queue);
    }
  }
  async finish(job,result,timing={}){
    await this.change(job,'saving');const directory=this.store.outputDirectory(job);await mkdir(directory,{recursive:true,mode:0o700});
    let file,mime;
    if(job.kind==='audio'){
      const encoded=result.audio_base64;
      if(typeof encoded!=='string'||encoded.length>64*2**20)throw fail('Invalid generated audio');
      file=join(directory,'output.wav');
      const {writeFile,open,chmod}=await import('node:fs/promises');
      const tmp=file+'.tmp';await writeFile(tmp,Buffer.from(encoded,'base64'));await chmod(tmp,0o600);
      const fd=await open(tmp,'r');try{await fd.sync();}finally{await fd.close();}
      await rename(tmp,file);mime='audio/wav';
    }else if(job.kind==='image'){
      const encoded=result.data?.[0]?.b64_json;if(typeof encoded!=='string'||encoded.length>48*2**20)throw fail('Invalid generated image');
      file=join(directory,'output.png');const tmp=file+'.tmp';await sharp(Buffer.from(encoded,'base64'),{limitInputPixels:16777216}).png().toFile(tmp);const {open,chmod}=await import('node:fs/promises');await chmod(tmp,0o600);const fd=await open(tmp,'r');try{await fd.sync();}finally{await fd.close();}await rename(tmp,file);mime='image/png';
    }else{file=result.data?.[0]?.local_path;if(file!==join(directory,'output.mp4'))throw fail('Invalid video artifact path');mime='video/mp4';}
    let media;
    if(job.kind==='audio'){
      media={duration_seconds:result.duration_seconds??null,sample_rate:result.sample_rate??24000,rtf:result.rtf??null};
    }else if(job.kind==='image'){const m=await sharp(file).metadata();media={width:m.width,height:m.height,has_alpha:!!m.hasAlpha};}
    else{
      const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
      const probe=JSON.parse((await promisify(execFile)('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',file],{timeout:30000,maxBuffer:2**20})).stdout);
      const v=probe.streams?.find(s=>s.codec_type==='video');if(!v)throw fail('Generated file has no video stream');
      const [n,d]=(v.r_frame_rate??'0/1').split('/').map(Number);media={width:v.width,height:v.height,fps:n/d,frames:Number(v.nb_frames)||null,duration_seconds:Number(v.duration??probe.format?.duration)||null,has_audio:probe.streams.some(s=>s.codec_type==='audio')};
    }
    const info=await stat(file);const artifact={artifact_id:uid('artifact'),kind:job.kind,mime_type:mime,bytes:info.size,local_path:file,job_id:job.job_id,media,uri:null};artifact.uri='media://artifacts/'+artifact.artifact_id;
    this.store.account(file,info.size);
    const input=job.request,reference=!!((input.reference_image_asset_ids?.length??0)+(input.reference_video_asset_ids?.length??0));
    const effective={...input,seed:input.seed??42};delete effective.prompt;delete effective.request_id;
    if(isVideoTool(job.tool))Object.assign(effective,{workflow:'yz-h3-ultimate-original',seed:input.seed??GOLDFISH_SEED,reference_mapping:job.reference_mapping,controls:{loras:input.loras??{},sampling:input.sampling??{},optimizations:input.optimizations??{},resolution:input.resolution??{},output:input.output??{}},duration_seconds:input.duration_seconds??10,frames:goldfishFrames(input.duration_seconds??10),width:media.width,height:media.height});
    else if(job.engine==='h3'){const frames=input.frames??124;Object.assign(effective,{width:input.width??864,height:input.height??480,frames,preset:input.preset??(reference?'reference':'turbo8'),effective_frames:reference?frames+((5-frames%17+17)%17):frames,fps:24});}
    if(job.engine==='qwen-image')Object.assign(effective,{size:input.size??'1024x1024',mode:job.tool==='edit_image'?'edit':input.mode??'text-to-image',steps:40,guidance_scale:1});
    if(job.engine==='tts')Object.assign(effective,{speed:input.speed??1});
    if(job.kind==='video')Object.assign(effective,{width:media.width,height:media.height,fps:media.fps,effective_frames:media.frames??effective.effective_frames??effective.frames});
    await this.change(job,'succeeded',{artifacts:[artifact],effective_parameters:effective,metrics:{...result.metrics,...timing},finished_at:new Date().toISOString()});
  }
  findArtifact(id){for(const job of this.jobs.values())if(job.state==='succeeded'){const artifact=job.artifacts?.find(a=>a.artifact_id===id);if(artifact)return {owner_id:job.owner_id,artifact};}return null;}
  artifact(owner,id){for(const job of this.jobs.values())if(job.owner_id===owner&&job.state==='succeeded'){const artifact=job.artifacts.find(a=>a.artifact_id===id);if(artifact)return artifact;}throw fail('Artifact not found',404);}
}
