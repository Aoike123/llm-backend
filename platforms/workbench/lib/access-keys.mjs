import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {ApiError} from './api-errors.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const publicPaths=new Set(['/v1/models','/v1/media/models','/v1/chat/completions','/v1/images/generations','/v1/images/edits','/v1/videos/generations']);
const integer=(n,min,max,label)=>{if(!Number.isInteger(n)||n<min||n>max)throw new Error(`${label}应为 ${min}–${max} 的整数`);return n;};
const name=value=>{if(typeof value!=='string'||!value.trim()||value.trim().length>80)throw new Error('名称需要 1–80 个字符');return value.trim();};
const requestLimits=value=>({maxConcurrent:integer(value.maxConcurrent,1,32,'并发'),requestsPerMinute:integer(value.requestsPerMinute,1,60000,'每分钟请求数')});
const keyLimits=value=>({...requestLimits(value),maxQueued:integer(value.maxQueued??8,0,128,'密钥等待名额')});
const settings=value=>({...requestLimits(value),maxQueued:integer(value.maxQueued??32,0,256,'总等待名额'),queueWaitSeconds:integer(value.queueWaitSeconds??900,1,900,'最长排队秒数')});
const record=(secret,label,limits)=>({id:randomUUID(),name:name(label),hash:hash(secret),preview:secret.slice(0,12)+'…'+secret.slice(-4),enabled:true,...keyLimits(limits),createdAt:new Date().toISOString()});

export class AccessKeys {
  // Keys authenticate, count request rate and bound prepared bodies. Concurrency
  // and queueing belong to the GPU coordinator, which reads limits() and
  // settings() and reports activity back for the console.
  constructor(file,state){this.file=file;this.state=state;this.usage=new Map();this.preparing=new Map();this.preparedBytes=0;this.clock=()=>performance.now()/1000;this.window={start:0,count:0};this.pending=Promise.resolve();this.startedAt=new Date().toISOString();this.activity=()=>({active:0,queued:0,byKey:{}});this.onChange=()=>{};}
  static async open(file,{legacyFile,defaults={maxConcurrent:8,requestsPerMinute:60}}={}){
    let state;
    try{state=JSON.parse(await readFile(file,'utf8'));}
    catch(e){
      if(e.code!=='ENOENT')throw e;
      let legacy=[];
      if(legacyFile)try{legacy=(await readFile(legacyFile,'utf8')).split(/\r?\n/).map(s=>s.trim()).filter(Boolean);}catch(e){if(e.code!=='ENOENT')throw e;}
      if(legacy.some(s=>s.length<32||/\s/.test(s)))throw new Error('Invalid legacy API key file');
      state={version:1,settings:settings(defaults),keys:[...new Set(legacy)].map((s,i)=>record(s,`原有公网密钥${i?' '+(i+1):''}`,defaults))};
    }
    if(state.version!==1||!Array.isArray(state.keys))throw new Error('Invalid access key store');
    state.settings=settings(state.settings);
    const ids=new Set(),hashes=new Set();
    for(const key of state.keys){
      name(key.name);Object.assign(key,keyLimits(key));
      if(typeof key.id!=='string'||ids.has(key.id)||hashes.has(key.hash)||!/^[a-f0-9]{64}$/.test(key.hash)||typeof key.enabled!=='boolean'||typeof key.preview!=='string')throw new Error('Invalid access key record');
      ids.add(key.id);hashes.add(key.hash);
    }
    const store=new AccessKeys(file,state);await store.save(state);return store;
  }
  async save(state){
    await mkdir(dirname(this.file),{recursive:true});
    const tmp=this.file+'.'+randomUUID()+'.tmp';
    await writeFile(tmp,JSON.stringify(state,null,2)+'\n',{mode:0o600});await rename(tmp,this.file);
  }
  limits(id){const key=this.state.keys.find(k=>k.id===id&&k.enabled);return key?{maxConcurrent:key.maxConcurrent,maxQueued:key.maxQueued}:null;}
  settings(){return this.state.settings;}
  snapshot(){const activity=this.activity();return {settings:this.state.settings,active:activity.active,queued:activity.queued,prepared_body_bytes:this.preparedBytes,prepared_body_budget_bytes:64*2**20,startedAt:this.startedAt,keys:this.state.keys.map(({hash:_,...key})=>({...key,...(this.usage.get(key.id)??{requests:0,lastUsedAt:null}),active:activity.byKey[key.id]?.active??0,queued:activity.byKey[key.id]?.queued??0})).map(({window:_,...key})=>key)};}
  mutate(input){
    const run=async()=>{
      const next=structuredClone(this.state);let secret;
      if(input.action==='create'){
        if(next.keys.length>=500)throw new Error('最多保留 500 个密钥');
        const limits=keyLimits({maxConcurrent:input.maxConcurrent??1,requestsPerMinute:input.requestsPerMinute??60,maxQueued:input.maxQueued});
        secret='sk-wb-'+randomBytes(32).toString('base64url');next.keys.push(record(secret,input.name,limits));
      }else if(input.action==='settings')next.settings=settings({...next.settings,...input});
      else{
        const index=next.keys.findIndex(k=>k.id===input.id);if(index<0)throw new Error('密钥不存在');
        if(input.action==='delete')next.keys.splice(index,1);
        else if(input.action==='update'){
          const key=next.keys[index];
          if(input.name!==undefined)key.name=name(input.name);
          if(input.enabled!==undefined){if(typeof input.enabled!=='boolean')throw new Error('Invalid enabled');key.enabled=input.enabled;}
          if(input.maxConcurrent!==undefined)key.maxConcurrent=integer(input.maxConcurrent,1,32,'密钥并发');
          if(input.requestsPerMinute!==undefined)key.requestsPerMinute=integer(input.requestsPerMinute,1,60000,'每分钟请求数');
          if(input.maxQueued!==undefined)key.maxQueued=integer(input.maxQueued,0,128,'密钥等待名额');
        }else throw new Error('未知操作');
      }
      await this.save(next);this.state=next;this.onChange();return {...this.snapshot(),...(secret?{secret}:{} )};
    };
    const task=this.pending.then(run);this.pending=task.catch(()=>{});return task;
  }
  authenticate(authorization){
    const match=/^Bearer ([^\s]+)$/i.exec(authorization??'');if(!match)return null;
    const candidate=Buffer.from(hash(match[1]),'hex');
    return this.state.keys.find(k=>k.enabled&&timingSafeEqual(candidate,Buffer.from(k.hash,'hex')))??null;
  }
  // Rate limits only; the coordinator decides when a request may run.
  admit(key){
    // Fetch the current record so a revoked or edited key cannot use stale settings.
    key=this.state.keys.find(k=>k.id===key?.id&&k.enabled);if(!key)throw new ApiError('API_KEY_INVALID');
    const now=Date.now(),usage=this.usage.get(key.id)??{requests:0,lastUsedAt:null,window:{start:now,count:0}};
    if(now-this.window.start>=60000)this.window={start:now,count:0};
    if(now-usage.window.start>=60000)usage.window={start:now,count:0};
    const rejectLimit=(code,current,limit,retryAfterSeconds)=>{throw new ApiError(code,{details:{current,limit},retryAfterSeconds});};
    if(usage.window.count>=key.requestsPerMinute)rejectLimit('API_KEY_REQUEST_RATE_LIMIT_EXCEEDED',usage.window.count,key.requestsPerMinute,Math.max(1,Math.ceil((usage.window.start+60000-now)/1000)));
    if(this.window.count>=this.state.settings.requestsPerMinute)rejectLimit('GLOBAL_REQUEST_RATE_LIMIT_EXCEEDED',this.window.count,this.state.settings.requestsPerMinute,Math.max(1,Math.ceil((this.window.start+60000-now)/1000)));
    usage.requests++;usage.lastUsedAt=new Date(now).toISOString();usage.window.count++;this.window.count++;this.usage.set(key.id,usage);
    return key;
  }
  reservePreparation(key,contentLength){
    // Admission needs a validated engine from JSON. Bound both in-flight body
    // readers and retained JSON, including chunked requests with unknown sizes.
    const count=this.preparing.get(key.id)??0,limits=this.state.settings;
    if(count>=key.maxConcurrent+key.maxQueued)throw new ApiError(key.maxQueued?'API_KEY_QUEUE_FULL':'API_KEY_CONCURRENCY_LIMIT_EXCEEDED',{details:{current:key.maxQueued?count-key.maxConcurrent:count,limit:key.maxQueued||key.maxConcurrent},retryAfterSeconds:5});
    const total=[...this.preparing.values()].reduce((a,b)=>a+b,0);
    if(total>=limits.maxConcurrent+limits.maxQueued)throw new ApiError(limits.maxQueued?'GLOBAL_QUEUE_FULL':'GLOBAL_CONCURRENCY_LIMIT_EXCEEDED',{details:{current:limits.maxQueued?total-limits.maxConcurrent:total,limit:limits.maxQueued||limits.maxConcurrent},retryAfterSeconds:5});
    const length=Number(contentLength),bytes=Number.isSafeInteger(length)&&length>0?Math.min(length,32*2**20):32*2**20;
    if(this.preparedBytes+bytes>64*2**20)throw new ApiError('ADMISSION_BODY_BUDGET_EXCEEDED',{details:{current_bytes:this.preparedBytes,limit_bytes:64*2**20,requested_bytes:bytes},retryAfterSeconds:5});
    this.preparedBytes+=bytes;this.preparing.set(key.id,count+1);
    let released=false;return ()=>{if(released)return;released=true;this.preparedBytes-=bytes;
      const remaining=this.preparing.get(key.id)-1;if(remaining)this.preparing.set(key.id,remaining);else this.preparing.delete(key.id);};
  }
}

export function linkCoordinator(store,coordinator){
  coordinator.keys=store;store.clock=coordinator.clock;store.activity=()=>coordinator.keyActivity();store.onChange=()=>coordinator.pump();
}

function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
export function keyManagement(store){
  return async(req,res)=>{
    const host=req.headers.host??'';
    if(!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)||req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'仅限本机控制台'});
    if(req.headers.origin){try{const origin=new URL(req.headers.origin);if(!['http:','https:'].includes(origin.protocol)||origin.host!==host)throw new Error();}catch{return json(res,403,{error:'仅限同源控制台'});}}
    if(req.method==='GET')return json(res,200,store.snapshot());
    if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
    if(process.env.WORKBENCH_READ_ONLY==='1')return json(res,403,{error:'Preview is read-only'});
    if(req.headers['content-type']?.split(';')[0]!=='application/json')return json(res,415,{error:'Use application/json'});
    try{
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>16384)throw new Error('请求过大');chunks.push(chunk);}
      const value=JSON.parse(Buffer.concat(chunks));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('JSON object required');
      return json(res,200,await store.mutate(value));
    }catch(e){return json(res,400,{error:e.code?'保存密钥配置失败':e.message});}
  };
}

// The public reverse proxy sets this header. Local trusted integrations keep their
// original access; explicitly supplied keys use the same policy on either route.
export function secureApi(api,store,{coordinator}={}){
  if(coordinator)linkCoordinator(store,coordinator);
  return async(req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname;
    if(req.headers['x-workbench-public']==='1'&&!publicPaths.has(path)&&!/^\/artifacts\/[a-f0-9]{32}\.mp4$/.test(path))return json(res,404,{error:'Not found'});
    const protectedPath=path.startsWith('/v1/')||path.startsWith('/artifacts/');
    const auth=req.headers.authorization,required=req.headers['x-workbench-public']==='1'||(auth&&auth!=='Bearer local');
    if(!protectedPath||!required||req.method==='OPTIONS')return api(req,res);
    const key=store.authenticate(auth),enqueuedAt=store.clock();
    let releasePreparation;
    // Counts the request rate; the handler then queues on the coordinator under this key.
    const admit=async(engine)=>{store.admit(key);return {key:key.id,enqueuedAt,timeout:store.settings().queueWaitSeconds};};
    try{
      if(!key)throw new ApiError(auth?'API_KEY_INVALID':'API_KEY_REQUIRED');
      const discovery=req.method==='GET'&&['/v1/models','/v1/media/models'].includes(path);
      const inference=coordinator&&req.method==='POST'&&publicPaths.has(path)&&!discovery;
      if(inference){
        releasePreparation=store.reservePreparation(key,req.headers['content-length']);
        // handlers validates and identifies the engine before queueing on the
        // coordinator under this key. The raw body is consumed only once.
        return await api(req,res,{admit,keyId:key.id});
      }
      store.admit(key);
      if(res.destroyed)return;
      return await api(req,res);
    }catch(error){
      if(!(error instanceof ApiError))throw error;
      if(error.code==='CLIENT_REQUEST_CANCELLED'){console.info(JSON.stringify({event:'api_client_disconnected',code:error.code,path,key_id:key?.id,phase:'waiting_for_admission'}));return;}
      if(error.status===401)res.setHeader('WWW-Authenticate','Bearer');
      if(error.retryAfterSeconds)res.setHeader('Retry-After',String(error.retryAfterSeconds));
      console.warn(JSON.stringify({event:'api_request_rejected',code:error.code,status:error.status,path,key_id:key?.id,...error.details,retry_after_seconds:error.retryAfterSeconds}));
      if(!res.destroyed)return json(res,error.status,error.toJSON());
    }finally{
      releasePreparation?.();
    }
  };
}
