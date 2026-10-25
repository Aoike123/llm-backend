import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {AccessKeys,secureApi,keyManagement} from '../lib/access-keys.mjs';

async function store(){const dir=await mkdtemp(join(tmpdir(),'workbench-keys-'));return {dir,file:join(dir,'keys.json'),async close(){await rm(dir,{recursive:true,force:true});}};}
async function listen(handler){const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));return {server,base:'http://127.0.0.1:'+server.address().port,async close(){server.closeAllConnections();await new Promise(r=>server.close(r));}};}
const create=(s,name='Alice',limits={})=>s.mutate({action:'create',name,maxQueued:0,...limits});
test('legacy import is one-time; secrets and hashes never appear in listings',async()=>{
 const t=await store();try{
  const legacy='legacy-key-with-over-thirty-two-characters';await writeFile(join(t.dir,'legacy'),legacy+'\n');
  const s=await AccessKeys.open(t.file,{legacyFile:join(t.dir,'legacy')});assert.ok(s.authenticate('Bearer '+legacy));
  const result=await create(s);assert.ok(result.secret.startsWith('sk-wb-'));const k=s.authenticate('Bearer '+result.secret);assert.ok(k);
  assert.ok(!(await readFile(t.file,'utf8')).includes(result.secret));assert.ok(!JSON.stringify(s.snapshot()).includes(k.hash));assert.ok(!JSON.stringify(s.snapshot()).includes(result.secret));
  await s.mutate({action:'delete',id:s.state.keys[0].id});
  const reopened=await AccessKeys.open(t.file,{legacyFile:join(t.dir,'legacy')});assert.equal(reopened.authenticate('Bearer '+legacy),null);assert.ok(reopened.authenticate('Bearer '+result.secret));
 }finally{await t.close();}
});
test('limit changes and revocation take effect immediately for the coordinator',async()=>{
 const t=await store();try{
  const s=await AccessKeys.open(t.file),a=await create(s,'Alice'),b=await create(s,'Bob');
  const ak=s.authenticate('Bearer '+a.secret),bk=s.authenticate('Bearer '+b.secret);
  assert.deepEqual(s.limits(ak.id),{maxConcurrent:1,maxQueued:0});
  await s.mutate({action:'update',id:ak.id,maxConcurrent:2});assert.deepEqual(s.limits(ak.id),{maxConcurrent:2,maxQueued:0});
  await s.mutate({action:'settings',maxConcurrent:2,requestsPerMinute:60});assert.equal(s.settings().maxConcurrent,2);
  await s.mutate({action:'update',id:ak.id,enabled:false});assert.equal(s.authenticate('Bearer '+a.secret),null);assert.equal(s.limits(ak.id),null);assert.throws(()=>s.admit(ak),{code:'API_KEY_INVALID'});
  await s.mutate({action:'update',id:ak.id,enabled:true});assert.ok(s.authenticate('Bearer '+a.secret));
  await s.mutate({action:'delete',id:bk.id});assert.equal(s.authenticate('Bearer '+b.secret),null);assert.equal(s.limits(bk.id),null);
 }finally{await t.close();}
});
test('per-key request frequency, persistence and invalid updates',async()=>{
 const t=await store();try{
  const s=await AccessKeys.open(t.file),r=await create(s,'limited',{requestsPerMinute:1});const key=s.authenticate('Bearer '+r.secret);s.admit(key);assert.throws(()=>s.admit(key),{code:'API_KEY_REQUEST_RATE_LIMIT_EXCEEDED'});
  await assert.rejects(s.mutate({action:'update',id:key.id,maxConcurrent:0}));await assert.rejects(create(s,'bad',{maxConcurrent:1.5}));
  await Promise.all([s.mutate({action:'update',id:key.id,name:'renamed'}),s.mutate({action:'update',id:key.id,maxConcurrent:3})]);
  const reopened=await AccessKeys.open(t.file);assert.equal(reopened.snapshot().keys[0].name,'renamed');assert.equal(reopened.snapshot().keys[0].maxConcurrent,3);
 }finally{await t.close();}
});
test('single original API preserves trusted local calls and protects all public routes',async()=>{
 const t=await store();let server;try{
  const s=await AccessKeys.open(t.file),r=await create(s),auth={Authorization:'Bearer '+r.secret,'X-Workbench-Public':'1'};
  server=await listen(secureApi(async(req,res)=>res.end('original-api'),s));
  assert.equal(await(await fetch(server.base+'/v1/models')).text(),'original-api');
  assert.equal((await fetch(server.base+'/v1/models',{headers:{'X-Workbench-Public':'1'}})).status,401);
  assert.equal((await fetch(server.base+'/v1/models',{headers:{'X-Workbench-Public':'1',Authorization:'Bearer local'}})).status,401);
  for(const path of ['/status','/metrics','/api/access-keys','/api/llm-mode','/artifacts/invalid.mp4'])assert.equal((await fetch(server.base+path,{headers:auth})).status,404);
  assert.equal(await(await fetch(server.base+'/v1/models',{headers:auth})).text(),'original-api');
  assert.equal(s.snapshot().keys[0].requests,1);
 }finally{if(server)await server.close();await t.close();}
});
test('management is local-only, same-origin and never returns an existing secret',async()=>{
 const t=await store();let server;try{
  const s=await AccessKeys.open(t.file);server=await listen(keyManagement(s));
  const action=payload=>fetch(server.base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const created=await(await action({action:'create',name:'recipient'})).json();assert.ok(created.secret);
  const listed=await(await fetch(server.base)).json();assert.equal(listed.secret,undefined);assert.equal(listed.keys.length,1);
  assert.equal((await fetch(server.base,{headers:{Origin:'https://evil.example'}})).status,403);
  const raw=headers=>new Promise((resolve,reject)=>{const req=http.request(server.base,{headers},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});req.once('error',reject);req.end();});
  assert.equal(await raw({Host:'evil.example'}),403);
  assert.equal(await raw({'Sec-Fetch-Site':'cross-site'}),403);
  assert.equal((await action({action:'update',id:listed.keys[0].id,enabled:false})).status,200);
  assert.equal(s.authenticate('Bearer '+created.secret),null);
 }finally{if(server)await server.close();await t.close();}
});

test('public rate-limit errors identify each limit, preserve counters and never expose credentials',async t=>{
 const logs=[];t.mock.method(console,'warn',value=>logs.push(JSON.parse(value)));
 const cases=[
  {code:'API_KEY_REQUEST_RATE_LIMIT_EXCEEDED',keyLimits:{requestsPerMinute:1},sameKey:true},
  {code:'GLOBAL_REQUEST_RATE_LIMIT_EXCEEDED',globalLimits:{maxConcurrent:8,requestsPerMinute:1}},
 ];
 for(const scenario of cases){
  const temp=await store();let server;
  try{
   const s=await AccessKeys.open(temp.file),a=await create(s,'Alice',scenario.keyLimits),b=await create(s,'Bob');
   if(scenario.globalLimits)await s.mutate({action:'settings',...scenario.globalLimits});
   const key=s.authenticate('Bearer '+a.secret);s.admit(key);
   const before=s.snapshot();let backendCalls=0;
   server=await listen(secureApi(async(req,res)=>{backendCalls++;res.end('ok');},s));
   const secret=scenario.sameKey?a.secret:b.secret;
   const response=await fetch(server.base+'/v1/chat/completions',{headers:{Authorization:'Bearer '+secret,'X-Workbench-Public':'1'}});
   assert.equal(response.status,429);const body=await response.json();
   assert.equal(body.error.code,scenario.code);assert.equal(body.error.type,'rate_limit_error');
   assert.deepEqual(body.error.details,{current:1,limit:1});
   const retryAfter=Number(response.headers.get('retry-after'));assert.ok(retryAfter>=1&&retryAfter<=60);
   assert.equal(backendCalls,0);assert.deepEqual(s.snapshot(),before);
   assert.equal(logs.at(-1).code,scenario.code);
   assert.ok(!JSON.stringify(logs).includes(secret));assert.ok(!JSON.stringify(body).includes(secret));
   // Resetting the frequency window permits new requests.
   s.window.start-=60001;for(const usage of s.usage.values())usage.window.start-=60001;
   const retry=await fetch(server.base+'/v1/chat/completions',{headers:{Authorization:'Bearer '+secret,'X-Workbench-Public':'1'}});
   assert.equal(retry.status,200);await retry.text();assert.equal(backendCalls,1);
  }finally{if(server)await server.close();await temp.close();}
 }
});

test('missing, invalid and revoked credentials have named authentication errors',async t=>{
 t.mock.method(console,'warn',()=>{});const temp=await store();let server;
 try{
  const s=await AccessKeys.open(temp.file),r=await create(s);let calls=0;
  server=await listen(secureApi(async(req,res)=>{calls++;res.end('ok');},s));
  for(const [authorization,code] of [[undefined,'API_KEY_REQUIRED'],['Bearer invalid','API_KEY_INVALID']]){
   const response=await fetch(server.base+'/v1/models',{headers:{'X-Workbench-Public':'1',...(authorization?{Authorization:authorization}:{})}});
   assert.equal(response.status,401);assert.equal(response.headers.get('www-authenticate'),'Bearer');assert.equal((await response.json()).error.code,code);
  }
  const stale=s.authenticate('Bearer '+r.secret);await s.mutate({action:'update',id:stale.id,enabled:false});
  assert.throws(()=>s.admit(stale),{code:'API_KEY_INVALID'});assert.equal(calls,0);
 }finally{if(server)await server.close();await temp.close();}
});
