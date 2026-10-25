import { randomBytes } from 'node:crypto';
import {llmProfile, servingPolicy, policyBudget,enginePolicyKey} from './llm.mjs';
import {ApiError} from './api-errors.mjs';
import {EngineScheduling} from './engine-scheduling.mjs';
import {sharedEngines as topologySharedEngines} from './runtime-topology.mjs';
export const pause = ms => new Promise(r => setTimeout(r, ms));
const LOCAL='local';
// One queue for every GPU request. Each engine declares how many requests one
// loaded instance serves at once; a key's concurrency counts only leases it
// holds, so waiting never consumes it. Grants happen on events (enqueue,
// release, cancel, load finished, key change); a 1 s tick only reclaims
// expired leases.
export class Coordinator {
  constructor(backend, {clock = () => performance.now()/1000, leaseSeconds = 120, sharedLimit = 8, engineScheduling = {}, sharedEngines = topologySharedEngines(), keys = null} = {}) {
    this.scheduling=new EngineScheduling(engineScheduling);
    Object.assign(this, {backend, clock, leaseSeconds, sharedLimit, sharedEngines, keys, selectedLlmMode:'long',policy:servingPolicy('long'), pendingLlmMode:null, modeSwitch:null, engineSwitch:null, queue: [], owner: null, switching: false, target: null, current: null, error: null, waiters:[], pumping:null, again:false, tick:null});
  }
  capacity(model) {
    return model==='llm'?Math.min(this.sharedLimit,this.policy.concurrency):(this.sharedEngines[model]??1);
  }
  selectWaitingRequest(requests) {
    return this.scheduling.choose(requests,this.target??this.current,this.clock()).request;
  }
  running(key) {
    let count=0;for(const holder of this.owner?.keys.values()??[])if(key===undefined?holder!==LOCAL:holder===key)count++;return count;
  }
  keyActivity() {
    const byKey={},row=key=>byKey[key]??={active:0,queued:0};
    for(const key of this.owner?.keys.values()??[])if(key!==LOCAL)row(key).active++;
    for(const request of this.queue)if(request.key!==LOCAL)row(request.key).queued++;
    return {active:this.running(),queued:this.queue.filter(r=>r.key!==LOCAL).length,byKey};
  }
  status() {
    const tokens = this.owner?.tokens;
    return {current: this.current, leased: !!tokens?.size, lease_model: this.owner?.model ?? null, active_leases: tokens?.size ?? 0,
      lease_capacity: this.owner ? (this.owner.exclusive ? 1 : this.capacity(this.owner.model)) : null,
      lease_expired: !!tokens?.size && Math.max(...tokens.values()) < this.clock(), queued: this.queue.length,
      engine_scheduling:this.scheduling.status(this.queue,this.target??this.current,this.clock()),
      switching: this.switching, switching_target: this.target, last_error: this.error,
      selected_llm_mode:this.selectedLlmMode, pending_llm_mode:this.pendingLlmMode,
      mode_switch:this.modeSwitch,engine_switch:this.engineSwitch,llm_policy:this.policy,llm_engine:this.backend.llmConfiguration??null,kv_forecast:this.backend.kvForecast??null,kv_budget:policyBudget(this.policy,this.backend.capacityTokens,
        this.pendingLlmMode?null:this.backend.loadedLlmMode),
      llm_mode: this.owner?.mode ?? this.backend.loadedLlmMode ?? null,
      llm_slots: Object.fromEntries(['192k','256k','64k'].map(slot=>[slot,[...(this.owner?.slots?.values()??[])].filter(s=>s===slot).length]))};
  }
  notify() {
    const waiters=this.waiters;this.waiters=[];for(const wake of waiters)wake();
  }
  // Resolves on the next lease change, abort or after ms, whichever is first.
  changed(ms=1000,signal) {
    return new Promise(resolve=>{this.waiters.push(resolve);setTimeout(resolve,ms).unref?.();signal?.addEventListener('abort',resolve,{once:true});});
  }
  ticket(request) {
    this.scheduling.granted(request.engine,this.clock());
    const token = randomBytes(32).toString('base64url');
    this.owner.tokens.set(token, this.clock() + this.leaseSeconds);
    this.owner.keys.set(token,request.key);
    if(request.profile?.slot)this.owner.slots.set(token,request.profile.slot);
    return {token, model:request.engine, lease_seconds: this.leaseSeconds};
  }
  drop(owner,token) {
    owner.tokens.delete(token);owner.slots.delete(token);owner.reservations.delete(token);owner.keys.delete(token);
  }
  async recover() {
    const owner = this.owner;
    if (owner?.tokens.size && !this.switching && Math.max(...owner.tokens.values()) < this.clock() && await this.backend.idle(owner.model)) {
      if (this.owner === owner && Math.max(...owner.tokens.values()) < this.clock()) {this.owner = null;this.notify();}
    }
  }
  assertAcceptingRequests() {
    if(this.mediaRecovery?.()){const e=new Error('Media startup recovery in progress; inference is paused');e.status=503;throw e;}
    if(this.pendingLlmMode){const e=new Error('LLM mode switch is in progress; new inference requests are paused');e.status=409;throw e;}
  }
  switchLog(message) {
    if(this.modeSwitch){this.modeSwitch.events.push({time:new Date().toISOString(),source:'scheduler',message});this.modeSwitch.events=this.modeSwitch.events.slice(-80);}
  }
  beginEngineSwitch(model) {
    this.engineSwitch={id:randomBytes(8).toString('hex'),target:model,from:this.current,phase:'preparing',started_at:Date.now(),events:[]};
    this.engineProgress('preparing',`准备 ${model} 引擎`);
  }
  engineProgress(phase,message,source='scheduler') {
    if(!this.engineSwitch)return;
    this.engineSwitch.phase=phase;
    this.engineSwitch.events.push({time:new Date().toISOString(),source,message:String(message).slice(-8192)});
    this.engineSwitch.events=this.engineSwitch.events.slice(-120);
    if(phase==='ready'||phase==='error')this.engineSwitch.finished_at=Date.now();
  }
  assertLlmMode(profile) {
    this.assertAcceptingRequests();if(!profile)throw new Error('Unknown LLM profile');
  }
  requestProfile(id) {
    const profile=llmProfile(id);return profile?{...profile,mode:enginePolicyKey(this.policy),maxModelLen:this.policy.context_tokens,limit:this.policy.concurrency}:null;
  }
  async selectLlmMode(mode,contextTokens,concurrency,eager=false,kvBytes) {
    const policy=servingPolicy(mode,contextTokens,concurrency,eager,kvBytes);
    if(this.pendingLlmMode){const e=new Error('LLM mode switch already in progress');e.status=409;throw e;}
    this.assertAcceptingRequests();
    if(JSON.stringify(policy)===JSON.stringify(this.policy)&&this.backend.loadedLlmMode===enginePolicyKey(policy))return {mode,policy,unchanged:true};
    this.pendingLlmMode=mode;
    this.modeSwitch={id:randomBytes(8).toString('hex'),target:mode,policy,previous_container:this.backend.capacityContainer??this.backend.startupLog?.id??null,started_at:Date.now(),phase:'draining',events:[]};
    this.switchLog(`Waiting for existing tasks before loading ${policy.context_tokens} tokens × ${policy.concurrency} requests; BF16 head, ${policy.kv_budget_bytes/2**30} GiB KV`);
    const deadline=this.clock()+900;
    let ownsSwitch=false;
    try {
      while(this.owner||this.queue.length||this.switching){
        if(this.clock()>=deadline)throw new Error('Timed out waiting for existing tasks; configuration unchanged');
        await this.recover();await this.changed();
      }
      this.switching=true;ownsSwitch=true;this.target='llm';this.modeSwitch.phase='loading';this.beginEngineSwitch('llm');
      this.switchLog('Loading engine with the selected context and concurrency');
      await this.backend.ensure('llm',deadline,this.clock,policy,(...args)=>this.engineProgress(...args));
      this.current='llm';this.scheduling.turn=null;this.error=null;this.modeSwitch.phase='saving';
      await this.onModeSelected?.(mode,policy);
      this.policy=policy;this.selectedLlmMode=mode;
      this.modeSwitch.phase='ready';this.modeSwitch.finished_at=Date.now();
      this.switchLog('Engine ready; selected context and concurrency are active');this.engineProgress('ready','Qwen 引擎就绪，配置已生效');
      return {mode,policy,budget:policyBudget(policy,this.backend.capacityTokens)};
    }catch(e){this.error=e.message;this.modeSwitch.phase='error';this.switchLog(`Configuration failed: ${e.message}`);if(ownsSwitch)this.engineProgress('error',e.message);throw e;}
    finally {if(ownsSwitch){this.switching=false;this.target=null;}this.pendingLlmMode=null;this.pump();}
  }
  async reserveTokens(token,amount,timeout=900,{signal}={}) {
    const owner=this.owner,deadline=this.clock()+timeout;
    if(!owner?.tokens.has(token))throw new Error('Invalid lease token');
    const capacity=this.backend.capacityTokens;
    if(capacity==null)return; // Backend scheduler owns capacity when no measured value is available.
    if(amount>capacity){const e=new Error(`Request requires ${amount} tokens but KV capacity is ${capacity}`);e.status=400;throw e;}
    while(this.owner===owner&&owner.tokens.has(token)) {
      if(signal?.aborted)throw new ApiError('CLIENT_REQUEST_CANCELLED');
      const used=[...owner.reservations.values()].reduce((a,b)=>a+b,0);
      if(used+amount<=capacity){owner.reservations.set(token,amount);return;}
      if(this.clock()>=deadline)throw new ApiError('KV_CAPACITY_WAIT_TIMEOUT');
      await this.changed(Math.max(1,Math.min(1000,(deadline-this.clock())*1000)),signal);
    }
    throw new Error('Invalid lease token');
  }
  // Keyed requests may hold maxConcurrent leases and wait maxQueued more; the
  // same bound applies to all keys together. Trusted local calls are unbounded.
  admitToQueue(key) {
    if(key===LOCAL)return;
    const limits=this.keys?.limits(key);if(!limits)throw new ApiError('API_KEY_INVALID');
    const reject=(code,current,limit)=>{throw new ApiError(code,{details:{current,limit},retryAfterSeconds:5});};
    const mine=this.running(key)+this.queue.filter(r=>r.key===key).length;
    if(mine>=limits.maxConcurrent+limits.maxQueued)reject(limits.maxQueued?'API_KEY_QUEUE_FULL':'API_KEY_CONCURRENCY_LIMIT_EXCEEDED',limits.maxQueued?mine-limits.maxConcurrent:mine,limits.maxQueued||limits.maxConcurrent);
    const global=this.keys.settings(),all=this.running()+this.queue.filter(r=>r.key!==LOCAL).length;
    if(all>=global.maxConcurrent+global.maxQueued)reject(global.maxQueued?'GLOBAL_QUEUE_FULL':'GLOBAL_CONCURRENCY_LIMIT_EXCEEDED',global.maxQueued?all-global.maxConcurrent:all,global.maxQueued||global.maxConcurrent);
  }
  async acquire(model, {timeout = 900, profileId = 'qwen38-27b-w3a4-192k', key = LOCAL, exclusive = false, switchRequest = false, signal, enqueuedAt = this.clock()} = {}) {
    this.assertAcceptingRequests();
    if (!Object.hasOwn(this.backend.models, model)) return Promise.reject(new Error('Unknown model'));
    const profile=model==='llm'?this.requestProfile(profileId):null;
    if(model==='llm'&&!profile)return Promise.reject(new Error('Unknown LLM profile'));
    if(signal?.aborted)return Promise.reject(new ApiError('CLIENT_REQUEST_CANCELLED'));
    key??=LOCAL;
    try{this.admitToQueue(key);}catch(e){return Promise.reject(e);}
    return new Promise((resolve,reject)=>{
      const request={engine:model,key,exclusive,profile,switchRequest,enqueuedAt,signal,deadline:this.clock()+timeout,resolve,reject};
      request.cancel=()=>this.settle(request,new ApiError('CLIENT_REQUEST_CANCELLED'));
      request.timer=setTimeout(()=>this.settle(request,new ApiError(key===LOCAL?'GPU_LEASE_QUEUE_TIMEOUT':'ADMISSION_QUEUE_WAIT_TIMEOUT',key===LOCAL?{}:{details:{wait_seconds:timeout},retryAfterSeconds:5})),timeout*1000);
      signal?.addEventListener('abort',request.cancel,{once:true});
      this.queue.push(request);this.startTick();this.pump();
    });
  }
  settle(request,error,ticket) {
    const index=this.queue.indexOf(request);if(index<0)return false;
    this.queue.splice(index,1);clearTimeout(request.timer);request.signal?.removeEventListener('abort',request.cancel);
    if(error)request.reject(error);else request.resolve(ticket);
    this.notify();if(error)this.pump();return true;
  }
  eligible(request) {
    if(request.key===LOCAL)return true;
    const limits=this.keys?.limits(request.key);
    if(!limits){this.settle(request,new ApiError('API_KEY_INVALID'));return false;}
    return this.running(request.key)<limits.maxConcurrent&&this.running()<this.keys.settings().maxConcurrent;
  }
  canJoin(request) {
    const owner=this.owner;
    return !!owner&&!this.switching&&owner.model===request.engine&&!owner.exclusive&&!request.exclusive&&
      owner.tokens.size<this.capacity(owner.model)&&(owner.model!=='llm'||owner.mode===request.profile.mode);
  }
  // Within the chosen engine, the key holding the fewest leases goes next, so one
  // key's burst cannot crowd out others; FIFO breaks ties.
  fairest(candidates) {
    return candidates.reduce((best,r)=>{const a=this.running(r.key),b=this.running(best.key);return a<b||(a===b&&r.enqueuedAt<best.enqueuedAt)?r:best;});
  }
  pump() {
    if(this.pumping){this.again=true;return this.pumping;}
    // Clearing pumping in the same microtask as the final again check means a
    // pump() arriving after that check always starts a new pass.
    this.pumping=(async()=>{
      try{do{this.again=false;await this.dispatch();}while(this.again);}
      catch(e){console.error('GPU dispatch failed:',e.message);}
      finally{this.pumping=null;}
    })();
    return this.pumping;
  }
  async dispatch() {
    await this.recover();
    while(!this.switching) {
      const eligible=this.queue.filter(r=>this.eligible(r));
      const chosen=this.selectWaitingRequest(eligible);if(!chosen)return;
      const request=this.fairest(eligible.filter(r=>r.engine===chosen.engine));
      if(this.owner){if(!this.canJoin(request))return;this.settle(request,null,this.ticket(request));continue;}
      await this.load(request);
    }
  }
  async load(request) {
    const model=request.engine;
    this.switching = true; this.target = model;
    const track=this.current!==model||(model==='llm'&&this.backend.loadedLlmMode!==enginePolicyKey(this.policy));
    if(track)this.beginEngineSwitch(model);
    try {
      if(request.switchRequest){this.modeSwitch.phase='loading';this.switchLog(`Preparing backend ${model}; requested policy ${request.profile?.mode??model}`);}
      await this.backend.ensure(model, request.deadline, this.clock,model==='llm'?this.policy:undefined,track?(...args)=>this.engineProgress(...args):undefined);
      if(track){this.engineProgress('ready',`${model} 引擎已就绪`);this.scheduling.turn=null;}
      this.current = model; this.error = null;
      // A request that timed out or disconnected while loading leaves the engine loaded and unowned.
      if(this.queue.includes(request)){
        this.owner = {model, exclusive:request.exclusive, mode:request.profile?.mode, tokens: new Map(), slots:new Map(),reservations:new Map(),keys:new Map()};
        this.settle(request,null,this.ticket(request));
      }
    } catch (e) { if(track)this.engineProgress('error',e.message);this.error = e.message; this.current = null; this.settle(request,e); }
    finally { this.switching = false; this.target = null; }
  }
  startTick() {
    if(this.tick)return;
    this.tick=setInterval(()=>{if(!this.queue.length&&!this.owner){clearInterval(this.tick);this.tick=null;return;}this.pump();},1000);
    this.tick.unref?.();
  }
  renew(token) {
    if (!this.owner?.tokens.has(token)) throw new Error('Invalid lease token');
    this.owner.tokens.set(token, this.clock()+this.leaseSeconds);
  }
  async release(token) {
    const owner = this.owner;
    if (!owner?.tokens.has(token)) throw new Error('Invalid lease token');
    if (owner.tokens.size > 1) { this.drop(owner,token); this.notify(); this.pump(); return; }
    if (!await this.backend.idle(owner.model)) throw new Error('Backend still busy or status unavailable; lease retained');
    if (this.owner === owner && owner.tokens.has(token)) { this.drop(owner,token); if (!owner.tokens.size) this.owner = null; }
    this.notify(); this.pump();
  }
}
