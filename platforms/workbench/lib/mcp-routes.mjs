import {readFile} from 'node:fs/promises';
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {join} from 'node:path';
import {ID,CAPABILITIES,TOOL_GROUPS,COMMON_TOOLS,isGenerationTool,catalog,routes,validateToolInput} from './capabilities.mjs';
import {LEGACY_TOOLS,LEGACY_GROUPS,INSTRUCTIONS,listedTools,modelsView,categoriesOf,categoryTools,visibleTools,scopeMedia,TASK_TOOLS} from './media-tools.mjs';
// Tools a client may report calls for: the gateway ones, older names, and whatever the installed packages declare.
const knownTools=()=>new Set([...COMMON_TOOLS.map(t=>t.name),...Object.keys(LEGACY_TOOLS),...Object.keys(TOOL_GROUPS),...Object.keys(LEGACY_GROUPS),...Object.values(CAPABILITIES).flatMap(c=>[c.tool,...(c.aliases??[])])]);
const validateCommon=(name,input)=>validateToolInput(COMMON_TOOLS,name,input);
import {apiCatalog} from './api-catalog.mjs';
import {ROOT} from './backend.mjs';
import {runtimeTopology} from './runtime-topology.mjs';
import {comfyRuntime} from './comfy-runtime.mjs';
import {send} from './http.mjs';
import {atomic,fail} from './media-store.mjs';
import {capabilityForSync} from './media-tools.mjs';
import {pause} from './core.mjs';
import {jobRow,listJobs,listArtifacts,listVoices,searchVoices,streamFile,thumbnail} from './media-library.mjs';
const LINK_SECRET=process.env.WORKBENCH_LINK_SECRET?Buffer.from(process.env.WORKBENCH_LINK_SECRET):randomBytes(32);
const LINK_BASE=process.env.WORKBENCH_LINK_BASE??'http://127.0.0.1:18982';
const linkSignature=(owner,id,exp)=>createHmac('sha256',LINK_SECRET).update(owner+'|'+id+'|'+exp).digest('base64url');
function signedContentUrl(owner,id,ttl=600){
  const exp=Math.floor(Date.now()/1000)+ttl;
  return LINK_BASE+'/v1/media/artifacts/'+id+'/content?exp='+exp+'&sig='+linkSignature(owner,id,exp);
}
function validSignature(owner,id,exp,sig){
  if(!Number.isInteger(exp)||exp<Math.floor(Date.now()/1000))return false;
  const expected=Buffer.from(linkSignature(owner,id,exp));
  const provided=Buffer.from(String(sig??''));
  return expected.length===provided.length&&timingSafeEqual(expected,provided);
}
export function localManagement(req){
  const host=req.headers.host??'';if(!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)||req.headers['sec-fetch-site']==='cross-site'||req.headers['x-workbench-public']==='1')return false;
  if(req.headers.origin){try{if(new URL(req.headers.origin).host!==host)return false;}catch{return false;}}
  return true;
}
async function jsonBody(req,limit=32768){
  if(req.headers['content-type']?.split(';')[0]!=='application/json')throw fail('Use application/json',415);
  let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>limit)throw fail('Request too large',413);chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks));
}
export class McpInfo{
  constructor(store){this.store=store;this.state={instances:[],calls:[]};this.pending=Promise.resolve();}
  async open(){
    const secretFile=join(this.store.telemetry,'secret.json');
    try{this.secret=JSON.parse(await readFile(secretFile,'utf8')).token;}catch(e){if(e.code!=='ENOENT')throw e;if(process.env.WORKBENCH_READ_ONLY!=='1'){this.secret=randomBytes(32).toString('hex');await atomic(secretFile,{token:this.secret});}}
    try{this.state=JSON.parse(await readFile(join(this.store.telemetry,'events.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    this.trim();return this;
  }
  trim(){const cutoff=Date.now()-30*86400000;this.state.calls=this.state.calls.filter(c=>Date.parse(c.at)>cutoff).slice(-5000);this.state.instances=this.state.instances.filter(i=>Date.parse(i.last_reported_at)>cutoff).slice(-256);}
  authorized(value){return typeof value==='string'&&this.secret&&value.length===this.secret.length&&timingSafeEqual(Buffer.from(value),Buffer.from(this.secret));}
  event(owner,input){
    const work=this.pending.then(async()=>{
      if(!input||typeof input!=='object'||!/^instance_[a-f0-9]{32}$/.test(input.instance_id??''))throw fail('Invalid telemetry instance');
      if(!['heartbeat','initialized','closed','call'].includes(input.type))throw fail('Invalid event type');
      if(!Number.isSafeInteger(input.sequence)||input.sequence<0)throw fail('Invalid sequence');
      const now=new Date().toISOString();let instance=this.state.instances.find(i=>i.instance_id===input.instance_id&&i.owner_id===owner);
      if(instance&&input.sequence<=instance.sequence)return;
      if(!instance){instance={instance_id:input.instance_id,owner_id:owner,started_at:now};this.state.instances.push(instance);}
      Object.assign(instance,{sequence:input.sequence,last_reported_at:now,version:ID.version});
      if(input.type==='initialized')Object.assign(instance,{initialized_at:now,client_name:typeof input.client_name==='string'?input.client_name.replace(/[\x00-\x1f]/g,'').slice(0,80):null,protocol_version:typeof input.protocol_version==='string'?input.protocol_version.slice(0,30):null});
      if(input.type==='closed')instance.closed_at=now;
      if(input.type==='call'){
        if(!knownTools().has(input.tool)||!['success','error'].includes(input.status)||!Number.isFinite(input.duration_ms)||input.duration_ms<0)throw fail('Invalid call event');
        // Only allowlisted fields are retained: no prompt, argument, token, path or backend error text.
        this.state.calls.push({call_id:owner+':'+instance.instance_id+':'+input.sequence,instance_id:instance.instance_id,owner_id:owner,at:now,tool:input.tool,status:input.status,duration_ms:Math.round(input.duration_ms),job_id:/^job_[a-f0-9]{32}$/.test(input.job_id??'')?input.job_id:null,error_code:input.status==='error'?'TOOL_ERROR':null});
      }
      this.trim();await atomic(join(this.store.telemetry,'events.json'),this.state);
    });this.pending=work.catch(()=>{});return work;
  }
  // Every MCP process start leaves a record for 30 days; the list shows the live ones and the latest dozen past ones.
  #shownInstances(){
    const rows=[...this.state.instances].sort((a,b)=>Date.parse(b.last_reported_at)-Date.parse(a.last_reported_at)).map(i=>({...i,stale:Date.now()-Date.parse(i.last_reported_at)>45000}));
    let past=0;return rows.filter(i=>!i.stale||past++<12);
  }
  async overview(jobs,lifecycle){const media=await catalog();return {...ID,deployed:true,observed_at:new Date().toISOString(),gateway:{status:lifecycle.draining?'draining':'ready',recovery_pending:jobs.recoveryPending},tools_count:media.tools.length,models:media.models,workflows:media.workflows,capabilities:routes(),instances:this.#shownInstances(),instances_total:this.state.instances.length,last_reported_at:this.state.instances.reduce((last,i)=>!last||i.last_reported_at>last?i.last_reported_at:last,null),pending_jobs:[...jobs.jobs.values()].filter(j=>!['succeeded','failed','cancelled','unknown'].includes(j.state)).length,storage:{used_bytes:this.store.usedBytes,quota_bytes:this.store.maxBytes},note:'实例上报与协议初始化是历史观察；心跳不代表宿主当前仍保持协议连接。'};}
  config(){return {transport:'stdio',command:ROOT+'lab',args:['mcp','stdio'],cwd:ROOT,config_file:'~/.config/llm-backend/media-mcp.json',setup_command:ROOT+'lab mcp setup',client_config:{mcpServers:{'local-media':{command:ROOT+'lab',args:['mcp','stdio']}}},credential_note:'先运行 setup，密钥仅保存在权限为 0600 的本机配置文件；此模板不含密钥。',remote_http:{deployed:false}};}
}
export function mcpRoutes(jobs,info,keys,lifecycle){
  async function admin(req,res){
    if(!localManagement(req))return send(res,403,{error:'Local same-origin console only'});
    const url=new URL(req.url,'http://localhost'),path=url.pathname;
    const cancel=/^\/api\/mcp\/jobs\/(job_[a-f0-9]{32})\/cancel$/.exec(path),voice=/^\/api\/mcp\/voices\/(artifact_[a-f0-9]{32})$/.exec(path);
    if(req.method!=='GET'&&!(cancel&&req.method==='POST')&&!(voice&&req.method==='PATCH'))return send(res,405,{error:'Read only'});
    try{
      // The only console write: JSON content type keeps it out of simple cross-site forms.
      if(cancel){await jsonBody(req);return send(res,200,await jobs.cancelAny(cancel[1]));}
      if(voice){
        const body=await jsonBody(req),label=v=>v===undefined?undefined:typeof v==='string'&&v.trim().length<=80?v.trim():(()=>{throw fail('Names and groups are text up to 80 characters');})();
        const name=label(body.name),group=label(body.group);if(name==='')throw fail('A voice needs a name');if(name===undefined&&group===undefined)throw fail('Give name or group');
        return send(res,200,await jobs.labelVoice(voice[1],{name,group}));
      }
      if(path==='/api/mcp/voices')return send(res,200,listVoices(jobs,url));
      if(path==='/api/mcp/overview')return send(res,200,{...await info.overview(jobs,lifecycle),runtime_topology:runtimeTopology(jobs.coordinator?.status?.()??{})});
      // Live like the tool list: sync routes and job tools follow the enabled engines.
      if(path==='/api/mcp/api'){const media=await catalog();return send(res,200,{base:LINK_BASE+'/v1',...apiCatalog(routes(),categoriesOf(media.tools))});}
      if(path==='/api/mcp/config')return send(res,200,info.config());
      if(path==='/api/mcp/tools'){const media=await catalog();return send(res,200,{...ID,tools:media.tools});}
      // The model's view: what enters a client model's context at session start and on each call.
      if(path==='/api/mcp/model-view'){
        const media=await catalog(),tools=listedTools(media.tools);
        // Staged: browse_media alone at first, then the tools each category opens.
        const initial=visibleTools(media.tools).map(t=>t.name),categories=categoriesOf(media.tools).map(c=>({id:c.id,label:c.label,summary:c.summary,tools:categoryTools(media.tools,c).map(t=>t.name),models:scopeMedia(media,[c]).models.map(m=>m.id)}));
        return send(res,200,{instructions:INSTRUCTIONS,tools,initial,categories,tool_info:Object.fromEntries(Object.entries(TOOL_GROUPS).map(([name,g])=>[name,{label:g.label,summary:g.summary}])),task_tools:TASK_TOOLS.filter(name=>media.tools.some(t=>t.name===name)),list_media_models:{overview:modelsView(media),by_category:Object.fromEntries(categoriesOf(media.tools).map(c=>[c.id,modelsView(scopeMedia(media,[c]))])),models:Object.fromEntries(media.models.map(m=>[m.id,modelsView(media,m.id)]))},models:media.models});
      }
      if(path==='/api/mcp/runtime'){
        const native=await comfyRuntime();
        return send(res,200,{runtime_topology:runtimeTopology(jobs.coordinator?.status?.()??{}),native_queue:{...native,available:native.queue_available}});
      }
      if(path==='/api/mcp/jobs')return send(res,200,listJobs(jobs,url));
      if(path==='/api/mcp/artifacts')return send(res,200,listArtifacts(jobs,url));
      if(path==='/api/mcp/calls'){
        const offset=Number(url.searchParams.get('offset')??0),limit=Number(url.searchParams.get('limit')??30);
        if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw fail('Invalid pagination');
        const rows=[...info.state.calls].reverse().map(c=>({...c,job_state:c.job_id?jobs.jobs.get(c.job_id)?.state??null:null}));
        return send(res,200,{calls:rows.slice(offset,offset+limit),offset,has_more:offset+limit<rows.length,total:rows.length,observed_at:new Date().toISOString(),retention_days:30,truncated:rows.length===5000});
      }
      const match=/^\/api\/mcp\/jobs\/(job_[a-f0-9]{32})$/.exec(path);
      if(match){const job=jobs.jobs.get(match[1]);if(!job)throw fail('Job not found',404);return send(res,200,jobRow(jobs,job,{full:true}));}
      const artifactMatch=/^\/api\/mcp\/artifacts\/(artifact_[a-f0-9]{32})$/.exec(path);
      if(artifactMatch){
        const found=jobs.findArtifact(artifactMatch[1]);if(!found)throw fail('Artifact not found',404);
        const width=url.searchParams.get('thumb');
        return width?streamFile(req,res,await thumbnail(jobs.store,found.artifact,Number(width))):streamArtifact(req,res,found.artifact);
      }
      return send(res,404,{error:'Unknown MCP info endpoint'});
    }catch(e){return send(res,e.status??400,{error:e.message});}
  }
  async function media(req,res){
    if(req.headers['x-workbench-public']==='1')return send(res,404,{error:'Not found'});
    // Internal APIs are for non-browser clients; no ambient local trust or cookie identity.
    if(req.headers.origin)return send(res,403,{error:'Non-browser API only'});
    const url=new URL(req.url,'http://localhost'),path=url.pathname;
    const signedMatch=/^\/v1\/media\/artifacts\/(artifact_[a-f0-9]{32})\/content$/.exec(path);
    if(signedMatch&&req.method==='GET'&&url.searchParams.get('sig')){
      const found=jobs.findArtifact(signedMatch[1]);
      const exp=Number(url.searchParams.get('exp'));
      if(!found||!validSignature(found.owner_id,signedMatch[1],exp,url.searchParams.get('sig')))return send(res,403,{error:'Invalid or expired link'});
      return streamArtifact(req,res,found.artifact);
    }
    const key=keys.authenticate(req.headers.authorization);if(!key)return send(res,401,{error:'Valid API key required'});
    try{
      if(path==='/internal/mcp/events'){
        if(!info.authorized(req.headers['x-media-telemetry-token']))throw fail('Invalid telemetry credential',401);
        if(req.method!=='POST')throw fail('Method not allowed',405);
        if(process.env.WORKBENCH_READ_ONLY==='1')throw fail('Preview is read-only',403);
        const event=await jsonBody(req);if(event?.job_id)jobs.get(key.id,event.job_id);await info.event(key.id,event);return send(res,200,{ok:true});
      }
      keys.admit(key);
      if(req.method==='POST'&&(lifecycle.draining||process.env.WORKBENCH_READ_ONLY==='1'))throw fail('Gateway is draining or read-only',503);
      if(path==='/v1/media/assets'&&req.method==='POST'){
        if(req.headers['content-type']!=='application/octet-stream')throw fail('Use application/octet-stream',415);
        return send(res,201,await jobs.store.import(key.id,url.searchParams.get('kind'),req));
      }
      const artifactMatch=/^\/v1\/media\/artifacts\/(artifact_[a-f0-9]{32})(\/content)?$/.exec(path);
      if(artifactMatch&&req.method==='GET'){const artifact=jobs.artifact(key.id,artifactMatch[1]);return artifactMatch[2]?streamArtifact(req,res,artifact):send(res,200,{...artifact,content_url:signedContentUrl(key.id,artifactMatch[1])});}
      // The MCP server reads its tool list from here, so enabling an engine reaches clients at once.
      if(path==='/v1/media/catalog'&&req.method==='GET')return send(res,200,await catalog());
      if(path==='/v1/media/voices'&&req.method==='GET'){
        const q=url.searchParams,input={};for(const k of ['query','group'])if(q.has(k))input[k]=q.get(k);for(const k of ['offset','limit'])if(q.has(k))input[k]=Number(q.get(k));
        validateCommon('search_voices',input);return send(res,200,searchVoices(jobs,key.id,input));
      }
      const voiceMatch=/^\/v1\/media\/voices\/(artifact_[a-f0-9]{32})$/.exec(path);
      if(voiceMatch&&req.method==='PATCH'){
        const body=await jsonBody(req);validateCommon('update_voice',{voice_artifact_id:voiceMatch[1],...body});
        if(body.name===undefined&&body.group===undefined)throw fail('Give name or group');
        return send(res,200,await jobs.labelVoice(voiceMatch[1],{name:body.name,group:body.group},key.id));
      }
      if(path==='/v1/media/jobs'&&req.method==='GET'){
        const input={offset:Number(url.searchParams.get('offset')??0),limit:Number(url.searchParams.get('limit')??20)};validateCommon('list_jobs',input);return send(res,200,jobs.list(key.id,input));
      }
      if(path==='/v1/media/jobs'&&req.method==='POST'){
        // 32000-character prompts are up to 96 KiB as UTF-8, so the job body needs 128 KiB.
        const body=await jsonBody(req,131072);if(!isGenerationTool(body.tool))throw fail('Invalid generation tool');
        return send(res,202,await jobs.create(key.id,body.tool,body.arguments));
      }
      const match=/^\/v1\/media\/jobs\/(job_[a-f0-9]{32})(\/cancel)?$/.exec(path);
      if(match){
        if(match[2]&&req.method==='POST')return send(res,200,await jobs.cancel(key.id,match[1]));
        if(!match[2]&&req.method==='GET'){
          const seconds=Number(url.searchParams.get('wait_seconds')??0);validateCommon('get_job',{job_id:match[1],wait_seconds:seconds});
          const start=Date.now();let job=jobs.get(key.id,match[1]);
          while(Date.now()-start<seconds*1000&&!['succeeded','failed','unknown','cancelled'].includes(job.state)&&!res.destroyed){await pause(200);job=jobs.get(key.id,match[1]);}
          return send(res,200,jobs.public(job));
        }
      }
      return send(res,404,{error:'Unknown media endpoint'});
    }catch(e){if(e.retryAfterSeconds)res.setHeader('Retry-After',String(e.retryAfterSeconds));return send(res,e.status??400,{error:e.code??e.message});}
  }
  // A job-backed sync route: submit the capability's job for the caller's key, wait for it, answer.
  // The client may ask for the audio itself (Accept: audio/*) instead of the JSON description.
  async function syncJob(req,res){
    const path=new URL(req.url,'http://localhost').pathname,capability=capabilityForSync(path),c=CAPABILITIES[capability];
    if(!c||c.sync_via!=='job')return send(res,404,{error:'Unknown API endpoint'});
    if(req.method!=='POST')return send(res,405,{error:'Method not allowed'});
    if(req.headers.origin)return send(res,403,{error:'Non-browser API only'});
    const key=keys.authenticate(req.headers.authorization);if(!key)return send(res,401,{error:'Valid API key required'});
    try{
      const body=await jsonBody(req,131072);
      const created=await jobs.create(key.id,c.group,{...body,request_id:body.request_id??'sync-'+randomBytes(12).toString('hex'),...(c.task!==undefined?{task:c.task}:{})});
      const deadline=Date.now()+Number(process.env.WORKBENCH_SYNC_WAIT_SECONDS??900)*1000;let job=jobs.get(key.id,created.job_id);
      while(Date.now()<deadline&&!['succeeded','failed','unknown','cancelled'].includes(job.state)&&!res.destroyed){await pause(200);job=jobs.get(key.id,created.job_id);}
      if(res.destroyed)return;
      const view=jobs.public(job);res.setHeader('X-Job-Id',job.job_id);
      if(job.state==='succeeded'){
        const artifacts=(job.artifacts??[]).map(a=>({artifact_id:a.artifact_id,name:a.name??null,kind:a.kind,mime_type:a.mime_type,bytes:a.bytes,media:a.media??null}));
        const wanted=/^audio\//.test((req.headers.accept??'').split(',')[0].trim())?job.artifacts?.find(a=>a.kind==='audio'):null;
        if(wanted)return streamArtifact(req,res,wanted);
        return send(res,200,{job_id:job.job_id,state:job.state,capability,served_by:job.served_by??job.model,artifacts,metrics:job.metrics??null});
      }
      if(['failed','unknown','cancelled'].includes(job.state))return send(res,502,{error:view.error??{code:job.state},job_id:job.job_id,state:job.state});
      // Still running at the deadline: the job continues; the caller polls it where it can.
      return send(res,202,{job_id:job.job_id,state:view.state,poll_after_seconds:view.poll_after_seconds});
    }catch(e){if(e.retryAfterSeconds)res.setHeader('Retry-After',String(e.retryAfterSeconds));return send(res,e.status??400,{error:e.code??e.message});}
  }
  return {admin,media,syncJob};
}
const streamArtifact=(req,res,artifact)=>streamFile(req,res,{path:artifact.local_path,mime_type:artifact.mime_type,bytes:artifact.bytes});
