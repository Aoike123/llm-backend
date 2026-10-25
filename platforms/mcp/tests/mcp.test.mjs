import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {TOOLS,validateInput} from '../manifest.mjs';
import {openImport} from '../client.mjs';
test('strict tool schemas reject unknown fields, bad IDs and unsafe seeds',()=>{
  assert.equal(TOOLS.length,11);assert.ok(TOOLS.some(t=>t.name==='generate_audio'));assert.ok(TOOLS.some(t=>t.name==='generate_video'));assert.ok(TOOLS.some(t=>t.name==='download_artifact'));assert.throws(()=>validateInput('generate_video_v2',{}),/Unknown media tool/);assert.throws(()=>validateInput('generate_video',{}),/request_id is required/);assert.ok(validateInput('import_media',{path:'/tmp/video.mp4',kind:'video'}));assert.ok(validateInput('import_media',{path:'/tmp/audio.wav',kind:'audio'}));for(const t of TOOLS)assert.ok(!t.name.includes('workbench'));
  assert.throws(()=>validateInput('run_goldfish_workflow',{request_id:'x',prompt:'x',reference_asset_ids:Array(10).fill('a')}),/count/);
  assert.throws(()=>validateInput('run_goldfish_workflow',{request_id:'x',prompt:'x',loras:{combat:{enabled:'yes'}}}),/boolean/);
  assert.throws(()=>validateInput('run_goldfish_workflow',{request_id:'x',prompt:'x',resolution:{megapixels:NaN}}),/invalid/);
  assert.throws(()=>validateInput('generate_image',{request_id:'x',prompt:'x',model:'qwen-image21',seed:2**53}),/seed/);
  assert.throws(()=>validateInput('get_job',{job_id:'../../etc/passwd'}));assert.throws(()=>validateInput('list_media_models',{token:'x'}));
});
test('prompt accepts 32000-character briefs and overflow reports its length',()=>{
  const long='字'.repeat(32000),base={request_id:'long-prompt',model:'flux2-klein',prompt:long};
  assert.ok(validateInput('generate_image',base));
  assert.ok(validateInput('run_goldfish_workflow',{request_id:'long-goldfish',prompt:long}));
  assert.throws(()=>validateInput('generate_image',{...base,prompt:long+'字'}),/arguments\.prompt exceeds 32000 characters \(got 32001\)/);
  assert.throws(()=>validateInput('run_goldfish_workflow',{request_id:'long-goldfish',prompt:long+'字'}),/exceeds 32000 characters \(got 32001\)/);
});
test('Goldfish rejects disabled lift routes using effective sampling defaults',()=>{
  const input={request_id:'selflift',prompt:'A continuous shot'};
  for(const sampling of [{upscaler_model:'none'},{upscaler_model:'none',rho:0}]){
    assert.throws(()=>validateInput('run_goldfish_workflow',{...input,sampling}),/sampling\.upscaler_model=none requires sampling\.rho > 0/);
  }
  for(const sampling of [undefined,{}, {rho:0},{rho:0,upscaler_model:'h3_upscaler_lms_v0.1.safetensors'},{rho:.6,upscaler_model:'none',w_min:1,w_max:1}]){
    assert.equal(validateInput('run_goldfish_workflow',{...input,...(sampling===undefined?{}:{sampling})}).request_id,input.request_id);
  }
});
test('local file import refuses symlinks, root escapes and nonregular files',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mcp-import-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'allowed'));await writeFile(join(root,'allowed','ok.png'),'png');await writeFile(join(root,'outside'),'secret');await symlink(join(root,'outside'),join(root,'allowed','escape'));
  const fd=await openImport(join(root,'allowed','ok.png'),[join(root,'allowed')]);assert.equal((await fd.readFile()).toString(),'png');await fd.close();
  await assert.rejects(openImport(join(root,'allowed','escape'),[join(root,'allowed')]),/outside/);await assert.rejects(openImport(join(root,'allowed'),[join(root,'allowed')]),/regular/);
});
test('official SDK stdio initializes, discovers image tools and Goldfish workflow, reports calls and returns resource links',async t=>{
  const events=[],job={job_id:'job_'+'a'.repeat(32),state:'queued'},artifact={artifact_id:'artifact_'+'b'.repeat(32),uri:'media://artifacts/artifact_'+'b'.repeat(32),mime_type:'image/png',local_path:'/tmp/output.png'};let forwardedPrompt=0;
  const gateway=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks).toString('utf8');res.setHeader('Content-Type','application/json');if(req.url==='/internal/mcp/events'){events.push(JSON.parse(raw));res.end('{}');}else if(req.url==='/v1/media/jobs'){assert.equal(req.headers.authorization,'Bearer test-key');forwardedPrompt=Math.max(forwardedPrompt,JSON.parse(raw).arguments?.prompt?.length??0);res.end(JSON.stringify(job));}else if(req.url.startsWith('/v1/media/artifacts/'))res.end(JSON.stringify(artifact));else{res.statusCode=404;res.end('{}');}});
  await new Promise(r=>gateway.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>gateway.close(r)));
  const transport=new StdioClientTransport({command:process.execPath,args:[new URL('../cli.mjs',import.meta.url).pathname,'stdio'],env:{...process.env,MEDIA_GATEWAY_URL:'http://127.0.0.1:'+gateway.address().port,MEDIA_API_KEY:'test-key',MEDIA_TELEMETRY_TOKEN:'test-token'},stderr:'pipe'});
  let errors='';transport.stderr?.on('data',x=>errors+=x);const client=new Client({name:'integration-test',version:'1.0'});t.after(()=>client.close());await client.connect(transport);
  const tools=await client.listTools();assert.equal(tools.tools.length,11);const models=await client.callTool({name:'list_media_models',arguments:{}});assert.equal(models.structuredContent.models.length,3);assert.ok(models.structuredContent.models.every(model=>['image','audio'].includes(model.kind)));assert.equal(models.structuredContent.runtime_topology,undefined);assert.equal(models.structuredContent.workflows[0].tool,'generate_video');
  const accepted=await client.callTool({name:'generate_image',arguments:{request_id:'one',model:'qwen-image21',prompt:'cup'}});assert.equal(accepted.structuredContent.job_id,job.job_id);
  const speech=await client.callTool({name:'generate_audio',arguments:{request_id:'audio-one',text:'你好[shan4]',reference_asset_id:'asset_voice'}});assert.equal(speech.structuredContent.job_id,job.job_id);
  const goldfish=await client.callTool({name:'run_goldfish_workflow',arguments:{request_id:'goldfish-one',prompt:'A continuous shot',reference_asset_ids:['asset_a','asset_b','asset_c']}});assert.equal(goldfish.structuredContent.job_id,job.job_id);
  const longPrompt=await client.callTool({name:'run_goldfish_workflow',arguments:{request_id:'goldfish-long',prompt:'字'.repeat(32000)}});assert.notEqual(longPrompt.isError,true);assert.equal(forwardedPrompt,32000);
  const badLift=await client.callTool({name:'run_goldfish_workflow',arguments:{request_id:'goldfish-invalid',prompt:'A continuous shot',sampling:{upscaler_model:'none'}}});assert.equal(badLift.isError,true);assert.match(badLift.content[0].text,/requires sampling\.rho > 0/);
  const media=await client.callTool({name:'get_artifact',arguments:{artifact_id:artifact.artifact_id}});assert.equal(media.content[1].type,'resource_link');
  const resource=await client.readResource({uri:artifact.uri});assert.equal(resource.contents[0].mimeType,'application/json');
  const invalid=await client.callTool({name:'generate_image',arguments:{prompt:'x'}});assert.equal(invalid.isError,true);
  await client.close();assert.ok(events.some(e=>e.type==='initialized'&&e.client_name==='integration-test'&&e.protocol_version));assert.equal(events.filter(e=>e.type==='call'&&e.tool==='generate_image').length,2);assert.equal(errors,'');
});
