// What the internet can reach, controlled from the console. The routes that may be public are the
// `access: 'public'` ones of api-catalog.mjs (chat, model lists, the synchronous media routes of
// enabled capabilities, finished MP4s); each can be switched off here without touching the proxy.
// The gateway is the authority: a public request (header X-Workbench-Public, set by the proxy) for
// a route that is off gets 404, whatever the proxy forwards. The proxy forwards /v1/* and
// /artifacts/* wholesale (caddySnippet); what it really does is checked from outside on demand (probe).
import {readFile,readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {atomic} from './media-store.mjs';
import {apiCatalog} from './api-catalog.mjs';

const run=promisify(execFile);
const MP4=/^\/artifacts\/[a-f0-9]{32}\.mp4$/;
export const routeId=r=>r.method+' '+r.path;
export const TUNNEL_UNIT='ai-workbench-public-tunnel.service';

export class PublicExposure {
  constructor(file,state,{routes,categories=()=>[],root,env=process.env,fetcher=fetch,systemctl}={}){
    this.file=file;this.state=state;this.routes=routes;this.categories=categories;this.root=root;this.env=env;this.fetcher=fetcher;this.systemctl=systemctl??this.#systemctl;
    this.startedAt=new Date().toISOString();this.stats=new Map();this.lastProbe=null;this.pending=Promise.resolve();
  }
  static async open(file,options){
    let state={version:1,master:true,off:[]};
    try{state={...state,...JSON.parse(await readFile(file,'utf8'))};}catch(e){if(e.code!=='ENOENT')throw e;}
    if(state.version!==1||typeof state.master!=='boolean'||!Array.isArray(state.off))throw new Error('Invalid public exposure store');
    return new PublicExposure(file,state,options);
  }
  // Every route that could be public, with whether it is, now.
  catalog(){
    const all=apiCatalog(this.routes(),this.categories()).groups.flatMap(g=>g.routes.map(r=>({...r,group:g.id})));
    return all.filter(r=>r.access==='public').map(r=>({...r,id:routeId(r),exposed:this.state.master&&!this.state.off.includes(routeId(r))}));
  }
  // The gate the gateway applies to a request that came through the proxy.
  allows(path){
    if(!this.state.master)return false;
    return this.catalog().some(r=>r.exposed&&(r.path===path||(r.path.includes('{')&&MP4.test(path)&&r.path==='/artifacts/{artifact}.mp4')));
  }
  paths(){return this.catalog().filter(r=>r.exposed).map(r=>r.path);}
  record(path,outcome){
    const entry=this.stats.get(path)??{served:0,denied:0,blocked:0,last_at:null};
    entry[outcome]++;entry.last_at=new Date().toISOString();this.stats.set(path,entry);
  }
  summary(){
    const total={served:0,denied:0,blocked:0,last_at:null};
    for(const e of this.stats.values()){total.served+=e.served;total.denied+=e.denied;total.blocked+=e.blocked;if(e.last_at&&(!total.last_at||e.last_at>total.last_at))total.last_at=e.last_at;}
    return {since:this.startedAt,...total,by_path:Object.fromEntries(this.stats)};
  }
  mutate(input){
    const apply=async()=>{
      const next=structuredClone(this.state);
      if(input.action==='master'){if(typeof input.enabled!=='boolean')throw new Error('Invalid enabled');next.master=input.enabled;}
      else if(input.action==='set'){
        const route=this.catalog().find(r=>r.id===input.id);if(!route)throw new Error('这个接口不能对公网放行');
        if(typeof input.exposed!=='boolean')throw new Error('Invalid exposed');
        next.off=input.exposed?next.off.filter(id=>id!==input.id):[...new Set([...next.off,input.id])];
      }else throw new Error('未知操作');
      await atomic(this.file,next);this.state=next;return this.snapshot();
    };
    const task=this.pending.then(apply);this.pending=task.catch(()=>{});return task;
  }
  // The proxy forwards the whole /v1 and /artifacts trees; which routes answer is this class's
  // decision, so the proxy needs no change when a switch or an engine changes.
  caddySnippet(){return '@gateway path /v1/* /artifacts/*\nhandle @gateway {\n    import inference_proxy\n}';}
  async base(){
    if(this.env.WORKBENCH_PUBLIC_BASE)return this.env.WORKBENCH_PUBLIC_BASE.replace(/\/$/,'');
    // Without a setting, the site address of the Caddyfile kept in the repository.
    try{
      const dir=join(this.root,'platforms/public-api'),file=(await readdir(dir)).find(f=>f.startsWith('Caddyfile.')&&!f.endsWith('.example'));
      const site=file&&/^([a-z0-9.-]+\.[a-z]{2,})\s*\{/m.exec(await readFile(join(dir,file),'utf8'))?.[1];
      return site?'https://'+site+'/v1':null;
    }catch{return null;}
  }
  async #systemctl(...args){return (await run('systemctl',['--user',...args],{timeout:3000})).stdout;}
  // The reverse tunnel: its unit state and where it points (never the key path).
  async tunnel(){
    const out={unit:TUNNEL_UNIT,state:'unknown',since:null,restarts:null,target:null,remote_port:null};
    try{
      const shown=Object.fromEntries((await this.systemctl('show',TUNNEL_UNIT,'--timestamp=utc','-p','ActiveState,SubState,ActiveEnterTimestamp,NRestarts')).trim().split('\n').map(l=>l.split(/=(.*)/s).slice(0,2)));
      out.state=shown.ActiveState==='active'?'active':shown.ActiveState==='failed'?'failed':shown.ActiveState==='inactive'||shown.ActiveState==='deactivating'?'inactive':shown.ActiveState==='activating'?'starting':'unknown';
      out.since=shown.ActiveEnterTimestamp?new Date(shown.ActiveEnterTimestamp).toISOString():null;out.restarts=Number(shown.NRestarts)||0;
    }catch{}
    try{
      const env=Object.fromEntries((await readFile(join(this.env.HOME??'','.config/ai-workbench/public-tunnel.env'),'utf8')).split('\n').map(l=>l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2]]));
      out.target=env.PUBLIC_API_SSH_TARGET?.replace(/^.*@/,'')??null;out.remote_port=Number(env.PUBLIC_API_REMOTE_PORT)||28984;
    }catch{}
    return out;
  }
  // Ask the public address what it does for each route, without a key: a reachable route answers
  // 401 from the gateway; 404 with the gateway's JSON body is the gateway refusing; any other 404
  // is the proxy's own path list. Safe: authentication fails before any work or body is read.
  async probe(){
    const base=await this.base();if(!base)throw new Error('没有公网地址：设置 WORKBENCH_PUBLIC_BASE，或在 platforms/public-api 放置 Caddyfile.<域名>');
    const origin=new URL(base).origin,routes=this.catalog();
    const check=async r=>{
      const path=r.path.replace('{artifact}','0'.repeat(32)),started=Date.now();
      try{
        const response=await this.fetcher(origin+path,{method:r.method,headers:{'X-Workbench-Probe':'1','Content-Type':'application/json'},body:r.method==='POST'?'{}':undefined,signal:AbortSignal.timeout(8000),redirect:'manual'});
        const text=await response.text().catch(()=> ''),gateway=/"error"/.test(text);
        const seen=response.status===401?'reachable':response.status===404?(gateway?'gateway-refused':'proxy-refused'):response.status>=500?'unreachable':'other';
        const ok=r.exposed?seen==='reachable':seen!=='reachable';
        return {id:r.id,path:r.path,exposed:r.exposed,status:response.status,seen,ok,ms:Date.now()-started};
      }catch(e){return {id:r.id,path:r.path,exposed:r.exposed,status:null,seen:'unreachable',ok:false,ms:Date.now()-started};}
    };
    const results=await Promise.all(routes.map(check));
    return this.lastProbe={at:new Date().toISOString(),base,results,ok:results.every(r=>r.ok)};
  }
  async snapshot(){
    return {master:this.state.master,routes:this.catalog(),stats:this.summary(),tunnel:await this.tunnel(),base:await this.base(),caddy:this.caddySnippet(),probe:this.lastProbe};
  }
}
