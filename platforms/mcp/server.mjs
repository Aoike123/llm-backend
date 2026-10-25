import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema,ListResourcesRequestSchema,ReadResourceRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {randomUUID} from 'node:crypto';
import {ID,TOOLS,MODELS,WORKFLOWS,validateInput} from './manifest.mjs';
import {configuration,request,openImport,downloadArtifact} from './client.mjs';
export async function start(){
  const config=await configuration(),instance_id='instance_'+randomUUID().replaceAll('-','');let sequence=0,protocol_version,reporting=Promise.resolve(),closing=false;
  // Event ordering is per process; a failed report cannot block media tools.
  function report(event){
    if(!config.telemetry_token)return Promise.resolve();
    const input={...event,instance_id,sequence:sequence++};
    reporting=reporting.then(()=>request(config,'/internal/mcp/events',{method:'POST',headers:{'x-media-telemetry-token':config.telemetry_token},body:JSON.stringify(input),timeout:2000})).catch(()=>{});return reporting;
  }
  const server=new Server(ID,{capabilities:{tools:{},resources:{}},instructions:'Local image generation, image editing and H3 video generation. Generation tools return durable jobs, not completed media: poll get_job and inspect unknown outcomes before retrying; download_artifact writes results into the workspace. Prefer the engine that is already running: check list_media_models first, batch work on the same engine, and avoid switching engines between jobs because a switch drains the queue and cold-starts the backend.'});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:TOOLS.map(({example,...tool})=>({...tool,annotations:{readOnlyHint:['list_media_models','get_job','list_jobs','get_artifact'].includes(tool.name),destructiveHint:false,openWorldHint:false}}))}));
  async function invoke(name,input){
    validateInput(name,input);
    if(name==='list_media_models')return {models:MODELS,workflows:WORKFLOWS};
    if(name==='import_media'){
      const fd=await openImport(input.path,config.import_roots);
      try{return await request(config,'/v1/media/assets?kind='+input.kind,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:fd.createReadStream({autoClose:false}),timeout:120000});}finally{await fd.close();}
    }
    if(name==='download_artifact')return downloadArtifact(config,input.artifact_id,input.path);
    if(['generate_image','edit_image','generate_video','generate_audio','run_goldfish_workflow'].includes(name))return request(config,'/v1/media/jobs',{method:'POST',body:JSON.stringify({tool:name==='run_goldfish_workflow'?'generate_video':name,arguments:input})});
    if(name==='get_job')return request(config,'/v1/media/jobs/'+input.job_id+'?wait_seconds='+(input.wait_seconds??0));
    if(name==='list_jobs')return request(config,'/v1/media/jobs?'+new URLSearchParams(input));
    if(name==='cancel_job')return request(config,'/v1/media/jobs/'+input.job_id+'/cancel',{method:'POST'});
    if(name==='get_artifact')return request(config,'/v1/media/artifacts/'+input.artifact_id);
  }
  server.setRequestHandler(CallToolRequestSchema,async req=>{
    const started=performance.now(),name=req.params.name;let result;
    try{
      result=await invoke(name,req.params.arguments??{});
      void report({type:'call',tool:name,status:'success',duration_ms:performance.now()-started,job_id:result.job_id});
      return {structuredContent:result,content:[{type:'text',text:JSON.stringify(result)},...(name==='get_artifact'?[{type:'resource_link',uri:result.uri,name:result.artifact_id,mimeType:'application/json',description:'Artifact metadata resource; use local_path for image/video viewing.'}]:[])]};
    }catch(e){void report({type:'call',tool:name,status:'error',duration_ms:performance.now()-started});return {isError:true,content:[{type:'text',text:e.message}]};}
  });
  server.setRequestHandler(ListResourcesRequestSchema,async()=>({resources:[]}));
  server.setRequestHandler(ReadResourceRequestSchema,async req=>{
    const match=/^media:\/\/artifacts\/(artifact_[a-f0-9]{32})$/.exec(req.params.uri);if(!match)throw new Error('Invalid artifact URI');
    const result=await request(config,'/v1/media/artifacts/'+match[1]);
    // Resource reads stay small even for videos; clients open the local path from metadata.
    return {contents:[{uri:req.params.uri,mimeType:'application/json',text:JSON.stringify(result)}]};
  });
  // 32000-character prompts can approach 96 KiB as UTF-8; keep a 2x frame margin.
  const transport=new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:262144});
  const send=transport.send.bind(transport);transport.send=message=>{if(message.result?.protocolVersion)protocol_version=message.result.protocolVersion;return send(message);};
  server.oninitialized=()=>void report({type:'initialized',client_name:server.getClientVersion()?.name,protocol_version});
  server.onerror=()=>console.error('MCP protocol error');
  await server.connect(transport);void report({type:'heartbeat'});
  const heartbeat=setInterval(()=>void report({type:'heartbeat'}),15000);heartbeat.unref();
  async function close(){if(closing)return;closing=true;clearInterval(heartbeat);await report({type:'closed'});await server.close();}
  process.stdin.once('end',()=>void close());process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
  return {server,close};
}
