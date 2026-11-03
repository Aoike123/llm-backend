import '../lib/registry.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AccessKeys,secureApi,publicManagement} from '../lib/access-keys.mjs';
import {PublicExposure} from '../lib/public-exposure.mjs';

const routes=()=>[{capability:'image.generate',tool:'generate_image',task:'generate',label:'生图',primary:'m1',fallbacks:[],providers:['m1']},{capability:'video.generate',tool:'generate_video',task:'generate',label:'视频生成',primary:'v1',fallbacks:[],providers:['v1']}];
async function setup(t,options={}){
  const dir=await mkdtemp(join(tmpdir(),'exposure-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'public-exposure.json'),exposure=await PublicExposure.open(file,{routes,root:dir,env:{HOME:dir},...options});
  const store=await AccessKeys.open(join(dir,'keys.json'));
  const server=http.createServer(secureApi(async(req,res)=>res.end('original-api'),store,{exposure}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  return {dir,file,exposure,base:'http://127.0.0.1:'+server.address().port};
}
const pub={'X-Workbench-Public':'1'};

test('a public request reaches only the routes switched on; switching one off blocks it at once',async t=>{
  const {exposure,base}=await setup(t);
  assert.equal((await fetch(base+'/v1/images/generations',{method:'POST',headers:pub})).status,401,'on: reaches the gateway, which wants a key');
  await exposure.mutate({action:'set',id:'POST /v1/images/generations',exposed:false});
  assert.equal((await fetch(base+'/v1/images/generations',{method:'POST',headers:pub})).status,404);
  assert.equal((await fetch(base+'/v1/videos/generations',{method:'POST',headers:pub})).status,401,'other routes are unaffected');
  assert.equal((await fetch(base+'/v1/images/generations',{method:'POST'})).status,200,'local requests do not pass through the gate');
  await exposure.mutate({action:'master',enabled:false});
  assert.equal((await fetch(base+'/v1/models',{headers:pub})).status,404);
});
test('a route with no enabled capability is not public, and only public routes can be switched',async t=>{
  const {exposure,base}=await setup(t,{routes:()=>[routes()[0]]});
  assert.equal((await fetch(base+'/v1/videos/generations',{method:'POST',headers:pub})).status,404);
  assert.ok(!exposure.catalog().some(r=>r.path==='/v1/videos/generations'));
  await assert.rejects(exposure.mutate({action:'set',id:'POST /v1/media/jobs',exposed:true}),/不能对公网放行/);
  await assert.rejects(exposure.mutate({action:'set',id:'GET /health',exposed:true}),/不能对公网放行/);
});
test('settings persist across restarts; counters tell served, denied and blocked apart; probes are not traffic',async t=>{
  const {exposure,base,file,dir}=await setup(t);
  await exposure.mutate({action:'set',id:'POST /v1/videos/generations',exposed:false});
  await fetch(base+'/v1/images/generations',{method:'POST',headers:pub});
  await fetch(base+'/v1/videos/generations',{method:'POST',headers:pub});
  await fetch(base+'/v1/images/generations',{method:'POST',headers:{...pub,'X-Workbench-Probe':'1'}});
  const stats=exposure.summary();assert.deepEqual([stats.served,stats.denied,stats.blocked],[0,1,1]);assert.equal(stats.by_path['/v1/images/generations'].denied,1);
  const again=await PublicExposure.open(file,{routes,root:dir});assert.ok(!again.allows('/v1/videos/generations'));assert.ok(again.allows('/v1/images/generations'));
});
test('mp4 results follow the artifact route; the proxy is told to forward the whole tree and the gateway decides',async t=>{
  const {exposure}=await setup(t);
  assert.ok(exposure.allows('/artifacts/'+'a'.repeat(32)+'.mp4'));assert.ok(!exposure.allows('/artifacts/x.mp4'));assert.ok(!exposure.allows('/v1/media/jobs'));
  const snippet=exposure.caddySnippet();assert.ok(snippet.includes('/v1/*')&&snippet.includes('/artifacts/*'));
  await exposure.mutate({action:'set',id:'GET /artifacts/{artifact}.mp4',exposed:false});assert.ok(!exposure.allows('/artifacts/'+'a'.repeat(32)+'.mp4'));
  assert.equal(exposure.caddySnippet(),snippet,'switches never change what the proxy forwards');
});
test('the outside check tells a gateway answer from the proxy refusing',async t=>{
  const answers={'/v1/models':[401,'{"error":{"code":"API_KEY_REQUIRED"}}'],'/v1/images/generations':[404,''],'/v1/videos/generations':[404,'{"error":"Not found"}']};
  const seen=[];
  const fetcher=async(url,init)=>{const path=new URL(url).pathname;seen.push([path,init.headers['X-Workbench-Probe']]);const [status,body]=answers[path]??[401,'{"error":{}}'];return new Response(body,{status});};
  const {exposure}=await setup(t,{fetcher,env:{HOME:'/nonexistent',WORKBENCH_PUBLIC_BASE:'https://api.example.test/v1'}});
  await exposure.mutate({action:'set',id:'POST /v1/videos/generations',exposed:false});
  const probe=await exposure.probe(),by=id=>probe.results.find(r=>r.path===id);
  assert.equal(by('/v1/models').seen,'reachable');assert.equal(by('/v1/models').ok,true);
  assert.deepEqual([by('/v1/images/generations').seen,by('/v1/images/generations').ok],['proxy-refused',false],'on here, but the proxy list lacks it');
  assert.deepEqual([by('/v1/videos/generations').seen,by('/v1/videos/generations').ok],['gateway-refused',true],'off, and refused as intended');
  assert.equal(probe.ok,false);assert.ok(seen.every(([,header])=>header==='1'));assert.equal(exposure.lastProbe.base,'https://api.example.test/v1');
});
test('the public address falls back to the site of the repository Caddyfile, and the tunnel reports its unit',async t=>{
  const {dir,exposure}=await setup(t,{systemctl:async()=> 'ActiveState=active\nSubState=running\nActiveEnterTimestamp=Tue 2026-11-03 07:21:39 UTC\nNRestarts=2\n'});
  await mkdir(join(dir,'platforms/public-api'),{recursive:true});await writeFile(join(dir,'platforms/public-api/Caddyfile.example'),'api.example.com {\n}\n');
  assert.equal(await exposure.base(),null,'the .example template is not a site');
  await writeFile(join(dir,'platforms/public-api/Caddyfile.demo.test'),'(snippet) {\n}\n\napi.demo.test {\n}\n');assert.equal(await exposure.base(),'https://api.demo.test/v1');
  await mkdir(join(dir,'.config/ai-workbench'),{recursive:true});await writeFile(join(dir,'.config/ai-workbench/public-tunnel.env'),'PUBLIC_API_SSH_TARGET=tunnel@203.0.113.7\nPUBLIC_API_SSH_IDENTITY=/secret/key\nPUBLIC_API_REMOTE_PORT=28984\n');
  const tunnel=await exposure.tunnel();assert.deepEqual([tunnel.state,tunnel.restarts,tunnel.target,tunnel.remote_port],['active',2,'203.0.113.7',28984]);assert.ok(!JSON.stringify(tunnel).includes('secret'));assert.equal(tunnel.since,'2026-11-03T07:21:39.000Z','the unit time is read as UTC, not as a zone abbreviation');
});
test('the management endpoint serves the snapshot, takes switches and refuses non-local origins',async t=>{
  const {exposure}=await setup(t),server=http.createServer(publicManagement(exposure));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
  const snapshot=await (await fetch(base)).json();assert.equal(snapshot.master,true);assert.ok(snapshot.routes.every(r=>r.access==='public'));assert.ok(snapshot.caddy.includes('/v1/*'));
  const post=body=>fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await (await post({action:'master',enabled:false})).json()).master,false);assert.equal((await post({action:'set',id:'nope',exposed:true})).status,400);
  assert.equal((await fetch(base,{headers:{Origin:'http://evil.test'}})).status,403);
  assert.equal((await fetch(base,{method:'POST',body:'{}'})).status,415);
});
