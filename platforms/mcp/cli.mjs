import {mkdir,readFile,stat,open,rename} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {configPath,configuration} from './client.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
async function setup(){
  const file=configPath();try{await stat(file);await configuration();console.log('已有可读取的配置：'+file);return;}catch(e){if(e.code!=='ENOENT')throw e;}
  const home=homedir(),base=process.env.MEDIA_GATEWAY_URL??'http://127.0.0.1:18982',telemetryRoot=process.env.MEDIA_STORAGE_ROOT??join(home,'文档/llm-backend/MCP');
  // Read credential material before creating the key, so a failed setup leaves no unused key.
  const {token}=JSON.parse(await readFile(join(telemetryRoot,'调用记录/secret.json'),'utf8'));
  const url=new URL(base);if(url.origin!=='http://127.0.0.1:18982'&&(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.protocol!=='http:'))throw new Error('Use a loopback gateway');
  const controller=new URL(base);controller.port=process.env.WORKBENCH_PORT??'13000';controller.pathname='/api/access-keys';
  const response=await fetch(controller,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'create',name:'本机媒体 MCP',maxConcurrent:1,requestsPerMinute:600,maxQueued:8}),signal:AbortSignal.timeout(10000)});
  const value=await response.json();if(!response.ok||!value.secret)throw new Error('Unable to create local MCP API key');
  await mkdir(dirname(file),{recursive:true,mode:0o700});const temp=file+'.tmp-'+process.pid,fd=await open(temp,'wx',0o600);
  try{await fd.writeFile(JSON.stringify({version:1,base:url.origin,api_key:value.secret,telemetry_token:token},null,2)+'\n');await fd.sync();}finally{await fd.close();}await rename(temp,file);
  console.log('已保存本机 MCP 配置（0600）：'+file);console.log('接入命令：'+root+'lab mcp stdio');
}
try{
  const command=process.argv[2];
  if(command==='stdio'){const {start}=await import('./server.mjs');await start();}
  else if(command==='setup')await setup();
  else if(command==='check'){const config=await configuration();const response=await fetch(config.base+'/health',{signal:AbortSignal.timeout(5000)});console.log(JSON.stringify({gateway:response.ok,transport:'stdio',config:configPath()}));if(!response.ok)process.exitCode=1;}
  else console.log('用法：./lab mcp setup | stdio | check');
}catch(e){console.error('MCP: '+e.message);process.exitCode=1;}
