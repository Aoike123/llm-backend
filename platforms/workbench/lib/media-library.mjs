// Console views over durable jobs: one place decides how jobs and their artifacts are filtered,
// grouped and summarised, so the task center, the asset library and engine pages agree.
import {createReadStream} from 'node:fs';
import {mkdir,stat,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import sharp from 'sharp';
import {capabilityForTool} from './capabilities.mjs';
import {fail} from './media-store.mjs';

const run=promisify(execFile);
const TERMINAL=new Set(['succeeded','failed','cancelled','unknown']);
// State groups the console filters by; unknown counts as a failure for the reader.
export const STATE_GROUPS={active:s=>!TERMINAL.has(s),succeeded:s=>s==='succeeded',failed:s=>s==='failed'||s==='unknown',cancelled:s=>s==='cancelled'};
export const ARTIFACT_KINDS=['image','video','audio','text'];
const created=job=>job.created_at??job.updated_at??'';
const newestFirst=(a,b)=>created(b).localeCompare(created(a));

// The words a person typed, shortened for lists; the full request stays out of console listings.
export function promptOf(job,{full=false}={}){
  const r=job.request??{};
  const text=[r.prompt,r.text].find(v=>typeof v==='string'&&v.trim());
  if(!text)return null;
  return full?text.trim():text.trim().replace(/\s+/g,' ').slice(0,280);
}

// The local console's detail view shows the whole request as submitted (prompt, spoken text,
// reference transcripts, instructions); lists get a one-line excerpt. The public API never does.
export function jobRow(jobs,job,{full=false}={}){
  const row={...jobs.public(job),capability:job.capability??capabilityForTool(job.tool),prompt:promptOf(job,{full})};
  if(full)row.input=job.request??null;
  return row;
}

function page(url){
  const offset=Number(url.searchParams.get('offset')??0),limit=Number(url.searchParams.get('limit')??30);
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw fail('Invalid pagination');
  return {offset,limit};
}
const count=(rows,key)=>rows.reduce((counts,row)=>{const k=key(row);if(k!=null)counts[k]=(counts[k]??0)+1;return counts;},{});

// Jobs, newest first. Facets count each dimension with the other filters applied, so a filter bar
// always shows what choosing a value would return.
export function listJobs(jobs,url){
  const {offset,limit}=page(url);
  const engine=url.searchParams.get('engine')||null,state=url.searchParams.get('state')||null,kind=url.searchParams.get('kind')||null;
  if(state&&!STATE_GROUPS[state])throw fail('Invalid state filter');
  const all=[...jobs.jobs.values()];
  const match=(job,skip)=>(skip==='engine'||!engine||job.engine===engine)&&(skip==='state'||!state||STATE_GROUPS[state](job.state))&&(skip==='kind'||!kind||job.kind===kind);
  const rows=all.filter(job=>match(job)).sort(newestFirst);
  const group=s=>Object.keys(STATE_GROUPS).find(g=>STATE_GROUPS[g](s));
  return {jobs:rows.slice(offset,offset+limit).map(job=>jobRow(jobs,job)),total:rows.length,offset,limit,has_more:offset+limit<rows.length,
    facets:{engine:count(all.filter(j=>match(j,'engine')),j=>j.engine),state:count(all.filter(j=>match(j,'state')),j=>group(j.state)),kind:count(all.filter(j=>match(j,'kind')),j=>j.kind)}};
}

// Every artifact of every succeeded job, flattened and newest first.
// Registered voices: the voice artifact of each succeeded voice job, with its clip for listening.
// Names and groups are the artifact's own metadata, so the console and get_job show the same label.
function voiceRows(jobs,{engine=null,owner=null}={}){
  return [...jobs.jobs.values()].filter(job=>job.state==='succeeded'&&(!engine||job.engine===engine)&&(!owner||job.owner_id===owner)&&(job.capability??capabilityForTool(job.tool))==='speech.voice').sort(newestFirst).flatMap(job=>{
    const voice=job.artifacts?.find(a=>a.name==='voice');if(!voice)return [];
    const clip=job.artifacts.find(a=>a.name==='clip');
    return [{artifact_id:voice.artifact_id,name:voice.media?.name??null,group:voice.media?.group??null,transcript:voice.media?.transcript??null,seconds:voice.media?.seconds??null,frames:voice.media?.frames??null,
      clip_artifact_id:clip?.artifact_id??null,job_id:job.job_id,request_id:job.request_id,engine:job.engine,model:job.served_by??job.model,created_at:job.created_at,renamed_at:voice.media?.renamed_at??null}];
  });
}
const groupsOf=voices=>[...new Set(voices.map(v=>v.group).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
export function listVoices(jobs,url){
  const voices=voiceRows(jobs,{engine:url?.searchParams.get('engine')||null});
  return {voices,groups:groupsOf(voices),total:voices.length};
}

// Fuzzy voice lookup for a client model. Each whitespace-separated word must hit the name, group
// or transcript, either as a substring or by character-bigram similarity (so "男旁白" still finds
// "男声旁白"); name hits outrank group hits, which outrank transcript hits.
const fold=text=>String(text??'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
const bigrams=text=>{const chars=[...text.replaceAll(' ','')];return chars.length<2?new Set(chars):new Set(chars.slice(1).map((c,i)=>chars[i]+c));};
function similarity(word,field){
  if(!field)return 0;
  if(field.includes(word))return 1;
  const a=bigrams(word),b=bigrams(field);if(!a.size||!b.size)return 0;
  let shared=0;for(const g of a)if(b.has(g))shared++;
  return shared/a.size*0.8;
}
export function searchVoices(jobs,owner,{query='',group=null,limit=10,offset=0}={}){
  const words=fold(query).split(' ').filter(Boolean),wanted=group&&fold(group);
  const scored=voiceRows(jobs,{owner}).filter(v=>!wanted||fold(v.group)===wanted).flatMap(v=>{
    if(!words.length)return [{voice:v,score:0}];
    const fields=[[fold(v.name),3],[fold(v.group),2],[fold(v.transcript),1]];let total=0;
    for(const word of words){
      const best=Math.max(...fields.map(([text,weight])=>similarity(word,text)*weight));
      if(best<0.5)return [];total+=best;
    }
    return [{voice:v,score:total}];
  });
  // Stable sort: equal scores keep the newest-first order of voiceRows.
  scored.sort((a,b)=>b.score-a.score);
  return {voices:scored.slice(offset,offset+limit).map(({voice,score})=>({...voice,score:Number(score.toFixed(2))})),total:scored.length,offset,limit,has_more:offset+limit<scored.length,groups:groupsOf(voiceRows(jobs,{owner}))};
}
export function listArtifacts(jobs,url){
  const {offset,limit}=page(url);
  const engine=url.searchParams.get('engine')||null,kind=url.searchParams.get('kind')||null;
  // A work category narrows the whole listing (and its facets) to its capabilities and kinds.
  const listParam=key=>url.searchParams.get(key)?.split(',').filter(Boolean)??null,capabilities=listParam('capability'),kinds=listParam('kinds');
  if(kind&&!ARTIFACT_KINDS.includes(kind)||kinds?.some(k=>!ARTIFACT_KINDS.includes(k)))throw fail('Invalid kind filter');
  const items=[...jobs.jobs.values()].filter(job=>job.state==='succeeded').sort(newestFirst).flatMap(job=>(job.artifacts??[]).map(artifact=>({
    artifact_id:artifact.artifact_id,kind:artifact.kind,mime_type:artifact.mime_type,bytes:artifact.bytes,name:artifact.name??null,media:artifact.media??null,
    job_id:job.job_id,engine:job.engine,model:job.served_by??job.model,capability:job.capability??capabilityForTool(job.tool),created_at:job.created_at,prompt:promptOf(job)})))
    .filter(a=>(!capabilities||capabilities.includes(a.capability))&&(!kinds||kinds.includes(a.kind)));
  const rows=items.filter(a=>(!engine||a.engine===engine)&&(!kind||a.kind===kind));
  return {artifacts:rows.slice(offset,offset+limit),total:rows.length,offset,limit,has_more:offset+limit<rows.length,
    facets:{engine:count(items.filter(a=>!kind||a.kind===kind),a=>a.engine),kind:count(items.filter(a=>!engine||a.engine===engine),a=>a.kind)}};
}

// Artifacts never change once saved, so the browser may keep them; Range lets video seek and lets
// galleries read only the first frames.
export async function streamFile(req,res,{path,mime_type,bytes}){
  const headers={'Content-Type':mime_type,'Accept-Ranges':'bytes','Cache-Control':'private, max-age=31536000, immutable','X-Content-Type-Options':'nosniff'};
  const range=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range??'');
  let start=0,end=bytes-1,status=200;
  if(range&&(range[1]||range[2])){
    start=range[1]?Number(range[1]):Math.max(0,bytes-Number(range[2]));end=range[1]&&range[2]?Math.min(Number(range[2]),bytes-1):bytes-1;
    if(start>end||start>=bytes){res.writeHead(416,{'Content-Range':'bytes */'+bytes});return res.end();}
    status=206;headers['Content-Range']=`bytes ${start}-${end}/${bytes}`;
  }
  headers['Content-Length']=end-start+1;res.writeHead(status,headers);
  if(req.method==='HEAD')return res.end();
  const stream=createReadStream(path,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
}

// Small WebP previews for images and videos (a frame half a second in), cached on the state disk
// next to the job records, so lists never load originals.
export const THUMB_WIDTHS=[320,640];
const rendering=new Map();
// A gallery page asks for dozens of previews at once; render two at a time so ffmpeg and sharp
// never exhaust the service's thread limit.
let running=0;const waiting=[];
async function limited(work){
  if(running>=2)await new Promise(resolve=>waiting.push(resolve));
  running++;try{return await work();}finally{running--;waiting.shift()?.();}
}
async function videoFrame(file){
  const {stdout}=await run('ffmpeg',['-nostdin','-v','error','-threads','1','-ss','0.5','-i',file,'-threads','1','-frames:v','1','-f','image2pipe','-c:v','png','-'],{encoding:'buffer',timeout:30000,maxBuffer:64*2**20});
  if(!stdout.length)throw fail('Video has no frame',422);
  return stdout;
}
export async function thumbnail(store,artifact,width){
  if(!THUMB_WIDTHS.includes(width))throw fail('Invalid thumbnail width');
  if(!['image','video'].includes(artifact.kind))throw fail('Thumbnails exist for images and videos only');
  const directory=join(store.state,'thumbs'),path=join(directory,`${artifact.artifact_id}-${width}.webp`);
  try{return {path,mime_type:'image/webp',bytes:(await stat(path)).size};}catch(e){if(e.code!=='ENOENT')throw e;}
  // Two tiles asking for the same preview share one render.
  if(!rendering.has(path))rendering.set(path,limited(async()=>{
    await mkdir(directory,{recursive:true});
    const partial=path+'.'+process.pid+'.partial';
    await sharp(artifact.kind==='video'?await videoFrame(artifact.local_path):artifact.local_path).rotate().resize({width,height:width,fit:'inside',withoutEnlargement:true}).webp({quality:78}).toFile(partial);
    await rename(partial,path);
  }).finally(()=>rendering.delete(path)));
  await rendering.get(path);
  return {path,mime_type:'image/webp',bytes:(await stat(path)).size};
}
