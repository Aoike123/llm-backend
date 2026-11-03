import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Registry} from '../lib/registry.mjs';
import {defineCapabilities,definitionsOf,resolveCapability,isGenerationTool,capabilityForSync,categoriesOf,visibleTools,browseResult,CAPABILITIES,TOOL_GROUPS} from '../lib/media-tools.mjs';
import {apiCatalog,publicPaths} from '../lib/api-catalog.mjs';

// One package declares everything clients see of a capability that nothing else knows about.
const MUSIC={order:50,group:'generate_music',task:'compose',kind:'audio',label:'音乐生成',sync:'/v1/audio/music',
  group_info:{label:'音乐生成',summary:'按描述生成一段音乐',description:'Create a music job. Poll get_job.'},category:{id:'music',label:'音乐',summary:'按描述生成音乐'},
  description:'compose music from a prompt',base:{request_id:{$use:'request_id'},prompt:{$use:'prompt',note:'曲风与情绪。'},seed:{$use:'seed'}},required:['request_id','prompt'],example:{request_id:'m-1',prompt:'a calm piano piece'}};
const manifest=(surface,capabilities=['music.compose'])=>({name:'Music',category:'audio',platform:{engine:'music',default_enabled:true,adapter:'adapter.mjs',surface,
  runtime:{id:'music',name:'music',port:9777,container:'c-music',launch:['music','start']},ui:{name:'Music',description:'d',symbol:'M',accent:'#fff',panel:'media'},models:[{id:'music-1',capabilities}]}});
async function install(t,body){
  const root=await mkdtemp(join(tmpdir(),'surface-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'engines/audio/music'),{recursive:true});await writeFile(join(root,'engines/audio/music/engine.json'),JSON.stringify(body));await writeFile(join(root,'engines/audio/music/adapter.mjs'),'export default {};');
  return {enginesDir:join(root,'engines'),statePath:join(root,'state.json')};
}

test('a package alone adds a tool, a task, a category, a sync route and a public path',async t=>{
  const registry=new Registry(await install(t,manifest({'music.compose':MUSIC})));
  assert.ok(!CAPABILITIES['music.compose'],'a registry over another directory does not touch the live tables');
  defineCapabilities(registry.surface);
  assert.equal(resolveCapability('generate_music'),'music.compose');assert.equal(resolveCapability('generate_music',{task:'compose'}),'music.compose');
  assert.ok(isGenerationTool('generate_music'));assert.equal(capabilityForSync('/v1/audio/music'),'music.compose');assert.equal(TOOL_GROUPS.generate_music.label,'音乐生成');
  assert.equal(CAPABILITIES['music.compose'].base.prompt.maxLength,32000,'the shared field shorthands expand');
  const tools=[{name:'generate_music',description:'x'},{name:'import_media'},{name:'get_job'},{name:'browse_media'}];
  assert.deepEqual(categoriesOf(tools).map(c=>[c.id,c.tools]),[['music',['generate_music','import_media']]]);
  assert.deepEqual(visibleTools(tools).map(x=>x.name),['browse_media']);assert.ok(visibleTools(tools,new Set(['music'])).some(x=>x.name==='generate_music'));
  assert.equal(browseResult(tools,{category:'music'}).tools[0].name,'generate_music');
  const route={capability:'music.compose',tool:'generate_music',task:'compose',label:'音乐生成',primary:'music-1',fallbacks:[],providers:['music-1']};
  const api=apiCatalog([route],[{id:'music',label:'音乐',tools:['generate_music']}]);
  assert.ok(api.groups.find(g=>g.id==='sync').routes.some(r=>r.path==='/v1/audio/music'&&r.access==='public'));assert.equal(api.job_tools[0].category,'音乐');
  assert.ok(publicPaths().has('/v1/audio/music'));
  // The MCP process gets the same declarations as JSON and ends up with the same tables.
  const sent=JSON.parse(JSON.stringify(definitionsOf()));defineCapabilities(sent);assert.equal(resolveCapability('generate_music'),'music.compose');
});
test('a capability a model serves must be declared by some package, and declarations must agree',async t=>{
  const refuses=async(surface,message)=>{const paths=await install(t,manifest(surface));assert.throws(()=>new Registry(paths),message);};
  await refuses({},/music-1 serves music\.compose, which no package declares in platform\.surface/);
  await refuses({'music.compose':{...MUSIC,required:['request_id','missing']}},/required field missing is not in base/);
  await refuses({'music.compose':{...MUSIC,sync:'audio/music'}},/sync must be a \/v1\/ path/);
  await refuses({'music.compose':{...MUSIC,category:undefined}},/surface\.category is required/);
});
