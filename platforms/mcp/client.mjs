import {open,realpath,readFile,mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,delimiter,join,dirname,extname} from 'node:path';
import {homedir} from 'node:os';
const RESOURCE_ROOT='/media/aoike/Resource_Trad';
// Defaults follow the resource disk instead of being frozen into each saved config.
export const defaultImportRoots=()=>[process.env.MEDIA_ASSETS_ROOT??join(RESOURCE_ROOT,'Assets'),join(RESOURCE_ROOT,'Project')];
export const configPath=()=>process.env.MEDIA_MCP_CONFIG??join(homedir(),'.config/llm-backend/media-mcp.json');
export async function configuration(){
  let saved={};try{saved=JSON.parse(await readFile(configPath(),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const config={...saved,base:process.env.MEDIA_GATEWAY_URL??saved.base??'http://127.0.0.1:18982',api_key:process.env.MEDIA_API_KEY??saved.api_key,telemetry_token:process.env.MEDIA_TELEMETRY_TOKEN??saved.telemetry_token,import_roots:process.env.MEDIA_IMPORT_ROOTS?.split(delimiter).filter(Boolean)??saved.import_roots??[]};
  const url=new URL(config.base);
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('P1 gateway URL must be a loopback HTTP origin');
  config.base=url.origin;if(!config.api_key)throw new Error('Missing media credential. Run ./lab mcp setup first.');return config;
}
export async function request(config,path,{method='GET',body,headers={},timeout=30000}={}){
  const response=await fetch(config.base+path,{method,headers:{Authorization:'Bearer '+config.api_key,...headers,...(body&&typeof body==='string'?{'Content-Type':'application/json'}:{})},body,...(body&&typeof body!=='string'?{duplex:'half'}:{}),redirect:'error',signal:AbortSignal.timeout(timeout)});
  const result=await response.json();if(!response.ok)throw Object.assign(new Error(typeof result.error==='string'?result.error:'Media gateway request failed'),{status:response.status});return result;
}
const inside=(root,file)=>{const rel=relative(root,file);return rel===''||(!rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&rel!=='..'&&!isAbsolute(rel));};
export async function openImport(path,roots){
  if(!isAbsolute(path))throw new Error('Import path must be absolute');
  const canonical=await realpath(path),allowed=[];
  for(const root of roots){try{allowed.push(await realpath(resolve(root)));}catch{}}
  if(!allowed.some(root=>inside(root,canonical)))throw new Error('Import path is outside MEDIA_IMPORT_ROOTS and the workspace');
  const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const info=await fd.stat();if(!info.isFile()||info.size<=0||info.size>128*2**20)throw new Error('Import must be a nonempty regular file ≤128 MiB');
    // Verify the opened inode, not merely a pre-open string (including symlink races in parents).
    const actual=await realpath('/proc/self/fd/'+fd.fd);if(!allowed.some(root=>inside(root,actual)))throw new Error('Opened file escaped import roots');
    return fd;
  }catch(e){await fd.close();throw e;}
}

const EXTENSIONS={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','video/mp4':'.mp4','audio/wav':'.wav','audio/mpeg':'.mp3'};
export const downloadRoots=(config={})=>{
  const configured=process.env.MEDIA_DOWNLOAD_ROOTS?.split(delimiter).filter(Boolean);
  const fallback=[process.cwd()];
  const roots=configured?.length?configured:(config.download_roots?.length?config.download_roots:fallback);
  return roots.map(root=>resolve(root));
};
// Configured roots extend the resource disk; the workspace an agent writes artifacts into is readable too.
export const importRoots=(config={})=>[...new Set([...defaultImportRoots(),...(config.import_roots??[]),...downloadRoots(config)].map(root=>resolve(root)))];
// Artifacts land inside an allowed root; the metadata call keeps the extension truthful.
export async function downloadArtifact(config,artifactId,destination){
  const artifact=await request(config,'/v1/media/artifacts/'+artifactId);
  const response=await fetch(config.base+'/v1/media/artifacts/'+artifactId+'/content',{headers:{Authorization:'Bearer '+config.api_key},redirect:'error',signal:AbortSignal.timeout(600000)});
  if(!response.ok)throw Object.assign(new Error('Artifact download failed with HTTP '+response.status),{status:response.status});
  const bytes=Buffer.from(await response.arrayBuffer());
  if(artifact.bytes!==undefined&&bytes.length!==artifact.bytes)throw new Error('Artifact size mismatch');
  const roots=downloadRoots(config);
  const suffix=EXTENSIONS[artifact.mime_type]||extname(artifact.local_path??'')||'.bin';
  const target=destination?(isAbsolute(destination)?resolve(destination):resolve(roots[0],destination)):join(roots[0],'downloads',artifactId+suffix);
  if(!roots.some(root=>inside(root,target)))throw new Error('Download path is outside MEDIA_DOWNLOAD_ROOTS');
  await mkdir(dirname(target),{recursive:true,mode:0o700});
  const parent=await realpath(dirname(target));
  if(!roots.some(root=>inside(root,parent)))throw new Error('Download path escaped MEDIA_DOWNLOAD_ROOTS');
  const handle=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(bytes);}finally{await handle.close();}
  return {artifact_id:artifactId,local_path:target,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),mime_type:artifact.mime_type,content_url:artifact.content_url??null};
}
