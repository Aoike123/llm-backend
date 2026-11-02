import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ToolListChangedNotificationSchema} from '@modelcontextprotocol/sdk/types.js';
import {validateToolInput} from '../manifest.mjs';
import {tools,catalog,validateGeneration} from '../../workbench/lib/capabilities.mjs';
// The gateway serves this catalog to the MCP server; validate against exactly what it sends.
const TOOLS=await tools(),CATALOG=await catalog(),validateInput=(name,input)=>validateToolInput(TOOLS,name,input);
import {openImport,importRoots,defaultImportRoots} from '../client.mjs';
test('advanced H3 controls are collapsed in the tool list but still validated in full by the gateway',async()=>{
  const video=TOOLS.find(t=>t.name==='generate_video').inputSchema.properties;
  for(const key of ['loras','sampling','optimizations','resolution','output','reference_slots']){assert.equal(video[key].properties,undefined);assert.match(video[key].description,/list_media_models/);}
  assert.ok(video.duration_seconds.maximum);assert.ok(video.reference_asset_ids.items);
  assert.ok(JSON.stringify(TOOLS).length<14000,'tool list grew to '+JSON.stringify(TOOLS).length+' characters');
  assert.ok(validateInput('generate_video',{request_id:'x',prompt:'x',loras:{combat:{enabled:true}}}));
  await assert.rejects(validateGeneration('generate_video',{request_id:'x',prompt:'x',loras:{combat:{enabled:'yes'}}}),/boolean/);
  await assert.rejects(validateGeneration('generate_video',{request_id:'x',prompt:'x',resolution:{megapixels:NaN}}),/invalid/);
  const h3=CATALOG.models.find(m=>m.id==='minimax-h3');
  assert.ok(h3.parameter_schemas['generate_video#generate'].sampling.properties.steps);
  assert.equal(h3.sync_api,undefined);assert.deepEqual(h3.tasks,['text-to-video','multimodal-reference']);
  assert.equal(CATALOG.capabilities[0].sync,undefined);
});
test('strict tool schemas reject unknown fields, bad IDs and unsafe seeds',()=>{
  assert.deepEqual(TOOLS.map(t=>t.name),['generate_image','generate_video','list_media_models','import_media','get_job','cancel_job','get_artifact']);assert.ok(validateInput('edit_image',{request_id:'e',prompt:'x',reference_asset_ids:['asset_a']}));assert.ok(validateInput('list_jobs',{limit:5}));assert.ok(validateInput('download_artifact',{artifact_id:'artifact_a',path:'x.png'}));assert.throws(()=>validateInput('generate_video_v2',{}),/Unknown media tool/);assert.throws(()=>validateInput('generate_video',{}),/request_id is required/);assert.ok(validateInput('import_media',{path:'/tmp/video.mp4',kind:'video'}));assert.ok(validateInput('import_media',{path:'/tmp/audio.wav',kind:'audio'}));
  for(const t of TOOLS)assert.ok(!t.name.includes('workbench'));
  assert.throws(()=>validateInput('run_goldfish_workflow',{request_id:'x',prompt:'x',reference_asset_ids:Array(10).fill('a')}),/count/);
  assert.throws(()=>validateInput('generate_image',{request_id:'x',prompt:'x',model:'qwen-image21',seed:2**53}),/seed/);
  assert.throws(()=>validateInput('get_job',{job_id:'../../etc/passwd'}));assert.throws(()=>validateInput('list_media_models',{token:'x'}));
});
test('prompt accepts 32000-character briefs and overflow reports its length',()=>{
  const long='字'.repeat(32000),base={request_id:'long-prompt',model:'anima',prompt:long};
  assert.ok(validateInput('generate_image',base));
  assert.ok(validateInput('run_goldfish_workflow',{request_id:'long-goldfish',prompt:long}));
  assert.throws(()=>validateInput('generate_image',{...base,prompt:long+'字'}),/arguments\.prompt exceeds 32000 characters \(got 32001\)/);
  assert.throws(()=>validateInput('run_goldfish_workflow',{request_id:'long-goldfish',prompt:long+'字'}),/exceeds 32000 characters \(got 32001\)/);
});
test('local file import refuses symlinks, root escapes and nonregular files',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mcp-import-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'allowed'));await writeFile(join(root,'allowed','ok.png'),'png');await writeFile(join(root,'outside'),'secret');await symlink(join(root,'outside'),join(root,'allowed','escape'));
  const fd=await openImport(join(root,'allowed','ok.png'),[join(root,'allowed')]);assert.equal((await fd.readFile()).toString(),'png');await fd.close();
  await assert.rejects(openImport(join(root,'allowed','escape'),[join(root,'allowed')]),/outside/);await assert.rejects(openImport(join(root,'allowed'),[join(root,'allowed')]),/regular/);
});
test('workspace download roots are also import roots',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mcp-workspace-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'ref.mp4'),'mp4');
  const previous=process.env.MEDIA_DOWNLOAD_ROOTS;process.env.MEDIA_DOWNLOAD_ROOTS=root;t.after(()=>{if(previous===undefined)delete process.env.MEDIA_DOWNLOAD_ROOTS;else process.env.MEDIA_DOWNLOAD_ROOTS=previous;});
  const roots=importRoots({import_roots:[join(root,'missing')]});assert.ok(roots.includes(root));
  for(const resource of defaultImportRoots())assert.ok(roots.includes(resource));assert.ok(roots.includes(join(root,'missing')));
  const fd=await openImport(join(root,'ref.mp4'),roots);assert.equal((await fd.readFile()).toString(),'mp4');await fd.close();
  await assert.rejects(openImport(join(root,'ref.mp4'),[join(root,'missing')]),/outside/);
});
test('official SDK stdio initializes, discovers gateway tools and Goldfish workflow, reports calls and returns resource links',async t=>{
  const events=[],job={job_id:'job_'+'a'.repeat(32),state:'queued'},artifact={artifact_id:'artifact_'+'b'.repeat(32),uri:'media://artifacts/artifact_'+'b'.repeat(32),mime_type:'image/png',local_path:'/tmp/output.png'};let forwardedPrompt=0;
  const gateway=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks).toString('utf8');res.setHeader('Content-Type','application/json');if(req.url==='/v1/media/catalog'){assert.equal(req.headers.authorization,'Bearer test-key');res.end(JSON.stringify(CATALOG));}else if(req.url==='/internal/mcp/events'){events.push(JSON.parse(raw));res.end('{}');}else if(req.url==='/v1/media/jobs'){assert.equal(req.headers.authorization,'Bearer test-key');forwardedPrompt=Math.max(forwardedPrompt,JSON.parse(raw).arguments?.prompt?.length??0);res.end(JSON.stringify(job));}else if(req.url.startsWith('/v1/media/artifacts/'))res.end(JSON.stringify(artifact));else{res.statusCode=404;res.end('{}');}});
  await new Promise(r=>gateway.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>gateway.close(r)));
  const transport=new StdioClientTransport({command:process.execPath,args:[new URL('../cli.mjs',import.meta.url).pathname,'stdio'],env:{...process.env,MEDIA_GATEWAY_URL:'http://127.0.0.1:'+gateway.address().port,MEDIA_API_KEY:'test-key',MEDIA_TELEMETRY_TOKEN:'test-token'},stderr:'pipe'});
  let errors='';transport.stderr?.on('data',x=>errors+=x);const client=new Client({name:'integration-test',version:'1.0'});t.after(()=>client.close());await client.connect(transport);
  const tools=await client.listTools();assert.equal(tools.tools.length,7);assert.equal(tools.tools.find(t=>t.name==='get_artifact').annotations.readOnlyHint,false);const models=await client.callTool({name:'list_media_models',arguments:{}});assert.deepEqual(models.structuredContent.models.map(model=>model.id),['qwen-image21','anima','minimax-h3']);assert.equal(models.structuredContent.capabilities.find(c=>c.capability==='image.generate').primary,'qwen-image21');assert.equal(models.structuredContent.runtime_topology,undefined);assert.equal(models.structuredContent.workflows[0].tool,'generate_video');
  assert.equal(models.structuredContent.models[0].parameter_schemas,undefined);
  const h3=await client.callTool({name:'list_media_models',arguments:{model:'minimax-h3'}});assert.ok(h3.structuredContent.model.parameter_schemas['generate_video#generate'].loras.properties);assert.deepEqual(h3.structuredContent.capabilities.map(c=>c.capability),['video.generate']);
  assert.equal((await client.callTool({name:'list_media_models',arguments:{model:'nope'}})).isError,true);
  const accepted=await client.callTool({name:'generate_image',arguments:{request_id:'one',model:'qwen-image21',prompt:'cup'}});assert.equal(accepted.structuredContent.job_id,job.job_id);
  const goldfish=await client.callTool({name:'run_goldfish_workflow',arguments:{request_id:'goldfish-one',prompt:'A continuous shot',reference_asset_ids:['asset_a','asset_b','asset_c']}});assert.equal(goldfish.structuredContent.job_id,job.job_id);
  const longPrompt=await client.callTool({name:'run_goldfish_workflow',arguments:{request_id:'goldfish-long',prompt:'字'.repeat(32000)}});assert.notEqual(longPrompt.isError,true);assert.equal(forwardedPrompt,32000);
  const media=await client.callTool({name:'get_artifact',arguments:{artifact_id:artifact.artifact_id}});assert.equal(media.content[1].type,'resource_link');
  const resource=await client.readResource({uri:artifact.uri});assert.equal(resource.contents[0].mimeType,'application/json');
  const invalid=await client.callTool({name:'generate_image',arguments:{prompt:'x'}});assert.equal(invalid.isError,true);
  await client.close();assert.ok(events.some(e=>e.type==='initialized'&&e.client_name==='integration-test'&&e.protocol_version));assert.equal(events.filter(e=>e.type==='call'&&e.tool==='generate_image').length,2);assert.equal(errors,'');
});
test('a running session is told when the gateway catalog changes',async t=>{
  let catalogBody=CATALOG;
  const gateway=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/v1/media/catalog')res.end(JSON.stringify(catalogBody));else res.end('{}');});
  await new Promise(r=>gateway.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>gateway.close(r)));
  const transport=new StdioClientTransport({command:process.execPath,args:[new URL('../cli.mjs',import.meta.url).pathname,'stdio'],env:{...process.env,MEDIA_GATEWAY_URL:'http://127.0.0.1:'+gateway.address().port,MEDIA_API_KEY:'test-key',MEDIA_TOOLS_WATCH_MS:'100'},stderr:'pipe'});
  const client=new Client({name:'watch-test',version:'1.0'});t.after(()=>client.close());
  let changed=0;client.setNotificationHandler(ToolListChangedNotificationSchema,()=>{changed++;});
  await client.connect(transport);assert.ok(client.getServerCapabilities().tools.listChanged);
  assert.equal((await client.listTools()).tools.length,7);
  await new Promise(r=>setTimeout(r,400));assert.equal(changed,0,'an unchanged catalog sends nothing');
  catalogBody={...CATALOG,tools:CATALOG.tools.filter(tool=>tool.name!=='generate_video')};
  for(let i=0;i<50&&!changed;i++)await new Promise(r=>setTimeout(r,100));
  assert.equal(changed,1);assert.equal((await client.listTools()).tools.length,6);
  await new Promise(r=>setTimeout(r,400));assert.equal(changed,1,'one change is announced once');
});
