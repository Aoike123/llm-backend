import '../lib/registry.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {FIXED,GROUPS,publicPaths,apiCatalog} from '../lib/api-catalog.mjs';

const route=(capability,extra={})=>({capability,primary:'m1',fallbacks:[],providers:['m1'],tool:'t',...extra});

test('sync routes come from the enabled capabilities, not from a hand-kept list',()=>{
  const none=apiCatalog([]);assert.ok(!none.groups.flatMap(g=>g.routes).some(r=>r.path==='/v1/images/generations'));
  const images=apiCatalog([route('image.generate',{providers:['m1','m2']})]);
  const row=images.groups.find(g=>g.id==='sync').routes.find(r=>r.path==='/v1/images/generations');
  assert.deepEqual([row.method,row.access,row.models.providers],['POST','public',['m1','m2']]);
  assert.ok(!images.groups.flatMap(g=>g.routes).some(r=>r.path==='/v1/videos/generations'),'a capability with no engine has no route');
});
test('public paths are the public fixed routes plus every capability sync path',()=>{
  for(const path of ['/v1/chat/completions','/v1/models','/v1/media/models','/v1/images/generations','/v1/images/edits','/v1/videos/generations'])assert.ok(publicPaths().has(path),path);
  for(const path of ['/v1/media/jobs','/v1/media/voices','/v1/capabilities','/status','/metrics'])assert.ok(!publicPaths().has(path),path);
});
test('every route has a group, a method and an access class; paths are unique',()=>{
  const groups=new Set(GROUPS.map(g=>g.id)),seen=new Set();
  for(const r of FIXED){assert.ok(groups.has(r.group),r.path);assert.ok(['GET','POST','PATCH'].includes(r.method),r.path);assert.ok(['public','key','local'].includes(r.access),r.path);assert.ok(!seen.has(r.method+r.path),r.path);seen.add(r.method+r.path);}
});
test('job tools list the enabled capabilities with their category',()=>{
  const out=apiCatalog([route('image.generate',{tool:'generate_image',task:'generate',label:'生图'})],[{id:'image',label:'图像',tools:['generate_image']}]);
  assert.deepEqual(out.job_tools,[{tool:'generate_image',task:'generate',capability:'image.generate',label:'生图',category:'图像',primary:'m1',providers:['m1']}]);
});
// The handlers match paths in code. A literal path there that the table lacks is a route the docs
// and the public-path check would not know about.
test('every literal path the gateway handles is declared in the table',async()=>{
  const declared=new Set(FIXED.map(r=>r.path)),sources=await Promise.all(['../lib/http.mjs','../lib/mcp-routes.mjs'].map(f=>readFile(new URL(f,import.meta.url),'utf8')));
  const literals=new Set(sources.flatMap(text=>[...text.matchAll(/(?:path===|includes\()\s*'(\/(?:v1|health|status|metrics)[^']*)'/g)].map(m=>m[1])));
  const sync=new Set(['/v1/images/generations','/v1/images/edits','/v1/videos/generations']);
  assert.ok(literals.size>8,'the scan found the routes');
  for(const path of literals)if(!sync.has(path))assert.ok(declared.has(path),path+' is handled but not declared in api-catalog.mjs');
});
