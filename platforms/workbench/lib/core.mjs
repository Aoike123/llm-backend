import { randomBytes } from 'node:crypto';
import {llmProfile, servingPolicy, policyBudget,enginePolicyKey} from './llm.mjs';
import {ApiError} from './api-errors.mjs';
import {EngineScheduling} from './engine-scheduling.mjs';
export const pause = ms => new Promise(r => setTimeout(r, ms));
export class Coordinator {
  constructor(backend, {clock = () => performance.now()/1000, leaseSeconds = 120, sharedLimit = 8, engineScheduling = {}} = {}) {
    this.scheduling=new EngineScheduling(engineScheduling);
    Object.assign(this, {backend, clock, leaseSeconds, sharedLimit, selectedLlmMode:'long',policy:servingPolicy('long'), pendingLlmMode:null, modeSwitch:null, engineSwitch:null, queue: [], owner: null, switching: false, target: null, current: null, error: null});
  }
  selectWaitingRequest(requests) {
    return this.scheduling.choose(requests,this.target??this.current,this.clock()).request;
  }
  status() {
    const tokens = this.owner?.tokens;
    return {current: this.current, leased: !!tokens?.size, lease_model: this.owner?.model ?? null, active_leases: tokens?.size ?? 0,
      lease_expired: !!tokens?.size && Math.max(...tokens.values()) < this.clock(), queued: this.queue.length,
      engine_scheduling:{...this.scheduling.status(this.queue,this.target??this.current,this.clock()),admission:this.scheduling.status(this.admissionQueue?.()??[],this.target??this.current,this.clock())},
      switching: this.switching, switching_target: this.target, last_error: this.error,
      selected_llm_mode:this.selectedLlmMode, pending_llm_mode:this.pendingLlmMode,
      mode_switch:this.modeSwitch,engine_switch:this.engineSwitch,llm_policy:this.policy,llm_engine:this.backend.llmConfiguration??null,kv_forecast:this.backend.kvForecast??null,kv_budget:policyBudget(this.policy,this.backend.capacityTokens,
        this.pendingLlmMode?null:this.backend.loadedLlmMode),
      llm_mode: this.owner?.mode ?? this.backend.loadedLlmMode ?? null,
      llm_slots: Object.fromEntries(['192k','256k','64k'].map(slot=>[slot,[...(this.owner?.slots?.values()??[])].filter(s=>s===slot).length]))};
  }
  ticket(model, slot) {
    this.scheduling.granted(model,this.clock());
    const token = randomBytes(32).toString('base64url');
    this.owner.tokens.set(token, this.clock() + this.leaseSeconds);
    if(slot)this.owner.slots.set(token,slot);
    return {token, model, lease_seconds: this.leaseSeconds};
  }
  async recover() {
    const owner = this.owner;
    if (owner && !this.switching && Math.max(...owner.tokens.values()) < this.clock() && await this.backend.idle(owner.model)) {
      if (this.owner === owner && Math.max(...owner.tokens.values()) < this.clock()) this.owner = null;
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
        await this.recover();await pause(100);
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
    finally {if(ownsSwitch){this.switching=false;this.target=null;}this.pendingLlmMode=null;}
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
      await pause(100);
    }
    throw new Error('Invalid lease token');
  }
  async acquire(model, timeout = 900, shared = false, profileId = 'qwen38-27b-w3a4-192k', switchRequest = false, {signal,enqueuedAt=this.clock()} = {}) {
    this.assertAcceptingRequests();
    if (!Object.hasOwn(this.backend.models, model)) throw new Error('Unknown model');
    shared = !!shared && model === 'llm';
    const profile=model==='llm'?this.requestProfile(profileId):null;
    if(model==='llm'&&!profile)throw new Error('Unknown LLM profile');
    const ticket = {engine:model,enqueuedAt,signal}, deadline = this.clock() + timeout;
    this.queue.push(ticket);
    try {
      while (true) {
        if(signal?.aborted)throw new ApiError('CLIENT_REQUEST_CANCELLED');
        await this.recover();
        if (this.clock() >= deadline) throw new ApiError('GPU_LEASE_QUEUE_TIMEOUT');
        if (this.selectWaitingRequest(this.queue.filter(job=>!job.signal?.aborted)) === ticket && !this.switching) {
          if (shared && this.owner?.shared && this.owner.model === model && this.owner.mode===profile.mode &&
              this.owner.tokens.size < Math.min(this.sharedLimit,this.policy.concurrency)) return this.ticket(model,profile.slot);
          if (!this.owner) {
            this.switching = true; this.target = model;
            const track=this.current!==model||(model==='llm'&&this.backend.loadedLlmMode!==enginePolicyKey(this.policy));
            if(track)this.beginEngineSwitch(model);
            try {
              if(switchRequest){this.modeSwitch.phase='loading';this.switchLog(`Preparing backend ${model}; requested policy ${profile?.mode??model}`);}
              await this.backend.ensure(model, deadline, this.clock,model==='llm'?this.policy:undefined,track?(...args)=>this.engineProgress(...args):undefined);
              if(track){this.engineProgress('ready',`${model} 引擎已就绪`);this.scheduling.turn=null;}
              this.current = model; this.error = null;
              this.owner = {model, shared, mode:profile?.mode, tokens: new Map(), slots:new Map(),reservations:new Map()};
              return this.ticket(model,profile?.slot);
            } catch (e) { if(track)this.engineProgress('error',e.message);this.error = e.message; this.current = null; throw e; }
            finally { this.switching = false; this.target = null; }
          }
        }
        await pause(100);
      }
    } finally { this.queue.splice(this.queue.indexOf(ticket), 1); }
  }
  renew(token) {
    if (!this.owner?.tokens.has(token)) throw new Error('Invalid lease token');
    this.owner.tokens.set(token, this.clock()+this.leaseSeconds);
  }
  async release(token) {
    const owner = this.owner;
    if (!owner?.tokens.has(token)) throw new Error('Invalid lease token');
    if (owner.tokens.size > 1) { owner.tokens.delete(token); owner.slots.delete(token); owner.reservations.delete(token); return; }
    if (!await this.backend.idle(owner.model)) throw new Error('Backend still busy or status unavailable; lease retained');
    if (this.owner === owner) { owner.tokens.delete(token); owner.slots.delete(token); owner.reservations.delete(token); if (!owner.tokens.size) this.owner = null; }
  }
}
