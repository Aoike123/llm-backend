import http from 'node:http';
import next from 'next';
import {Agent,setGlobalDispatcher} from 'undici';
setGlobalDispatcher(new Agent({headersTimeout:1800000,bodyTimeout:1800000}));
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Backend,ROOT} from './lib/backend.mjs';
import {Coordinator,pause} from './lib/core.mjs';
import {servingPolicy} from './lib/llm.mjs';
import {Metrics} from './lib/metrics.mjs';
import {handlers,send} from './lib/http.mjs';
import {AccessKeys,keyManagement,secureApi} from './lib/access-keys.mjs';
import {MediaStore} from './lib/media-store.mjs';
import {MediaJobs} from './lib/media-jobs.mjs';
import {McpInfo,mcpRoutes} from './lib/mcp-routes.mjs';
import {acquireProcessLock} from './lib/process-lock.mjs';
const directory=fileURLToPath(new URL('.',import.meta.url)),data=(process.env.WORKBENCH_DATA??ROOT+'workspace/data/scheduler').replace(/\/?$/,'/');
await mkdir(data,{recursive:true});
const lockPath=data+'node.lock';
const releaseLock=await acquireProcessLock(lockPath);
const backend=new Backend(),coordinator=new Coordinator(backend,{engineScheduling:JSON.parse(await readFile(ROOT+'platforms/scheduler/scheduling.json','utf8'))}),metrics=new Metrics(data+'metrics.json'),lifecycle={draining:false};
backend.startupLogPath=data+'llm-startup.json';
try{const saved=JSON.parse(await readFile(data+'llm-mode.json','utf8'));coordinator.policy=servingPolicy(saved.mode,saved.policy?.context_tokens,saved.policy?.concurrency,saved.policy?.eager,saved.policy?.kv_budget_bytes);coordinator.selectedLlmMode=saved.mode;}catch{coordinator.policy=servingPolicy('throughput');coordinator.selectedLlmMode='throughput';}
coordinator.onModeSelected=(mode,policy)=>writeFile(data+'llm-mode.json',JSON.stringify({mode,policy}));
await backend.llmMode();
const app=next({dev:process.env.NODE_ENV!=='production',dir:directory,hostname:'127.0.0.1',port:Number(process.env.WORKBENCH_PORT??13000)});
await app.prepare();const handle=app.getRequestHandler(),{api:rawApi,control}=handlers(coordinator,metrics,lifecycle);
const accessKeys=await AccessKeys.open(data+'access-keys.json',{legacyFile:ROOT+'workspace/data/public-api/api.keys'});
const api=secureApi(rawApi,accessKeys,{coordinator}),manageKeys=keyManagement(accessKeys);
const mediaStore=await new MediaStore().open(),mediaJobs=await new MediaJobs(mediaStore,accessKeys,coordinator,metrics,lifecycle).open(),mcpInfo=await new McpInfo(mediaStore).open();
const mcp=mcpRoutes(mediaJobs,mcpInfo,accessKeys,lifecycle);
const inferenceApi=(req,res)=>{const path=new URL(req.url,'http://localhost').pathname;return path==='/internal/mcp/events'||path.startsWith('/v1/media/jobs')||path.startsWith('/v1/media/assets')||path.startsWith('/v1/media/artifacts')?mcp.media(req,res):api(req,res);};
const safe=fn=>(req,res)=>Promise.resolve(fn(req,res)).catch(e=>{console.error(e.message);if(!res.headersSent)send(res,503,{error:'Service temporarily unavailable'});else res.destroy();});
const ui=http.createServer(safe((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;if(path.startsWith('/api/mcp/'))return mcp.admin(req,res);if(path==='/api/access-keys')return manageKeys(req,res);return path==='/data'||path==='/status'||path==='/metrics'||path==='/health'||path.startsWith('/api/llm-mode')||path==='/api/engine-logs'||path.startsWith('/v1/')||path.startsWith('/artifacts/')?inferenceApi(req,res):handle(req,res);}));
const inference=http.createServer(safe(inferenceApi)),controls=http.createServer(safe(control));
const servers=[ui,inference,controls];for(const server of servers){server.requestTimeout=0;server.headersTimeout=60000;}
await Promise.all(servers.map((s,i)=>new Promise((resolve,reject)=>{s.once('error',reject);s.listen([Number(process.env.WORKBENCH_PORT??13000),Number(process.env.INFERENCE_PORT??18982),Number(process.env.CONTROL_PORT??18990)][i],'127.0.0.1',resolve);} )));
await writeFile(data+'server.pid',String(process.pid));console.log('Next.js Workbench ready:', servers.map(s=>s.address().port).join(' / '));
let refreshing=false;
const refresh=setInterval(async()=>{
  if(refreshing||lifecycle.draining||coordinator.owner||coordinator.switching)return;refreshing=true;
  try{const active=await backend.running();if(!coordinator.owner&&!coordinator.switching)coordinator.current=active.length===1?(backend.sameRuntime(active[0],coordinator.current)?coordinator.current:active[0]):null;}catch{}finally{refreshing=false;}
},5000);
async function stop(){
  if(lifecycle.draining)return;lifecycle.draining=true;mediaJobs.stopped=true;clearInterval(refresh);
  await Promise.all([...mediaJobs.workers]);await mediaJobs.pending;await mcpInfo.pending;
  while(coordinator.owner||coordinator.switching||coordinator.queue.length||accessKeys.active||accessKeys.queue.length||accessKeys.preparing.size){await coordinator.recover();await pause(1000);}
  await Promise.all(servers.map(s=>new Promise(r=>{s.close(r);s.closeIdleConnections();s.closeAllConnections();})));await releaseLock();process.exit(0);
}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
