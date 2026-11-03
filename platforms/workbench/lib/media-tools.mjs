// The media contract with no engine knowledge: schema helpers, capability definitions and the
// gateway-level tools. Shared by the gateway and the MCP server process.
import {importRoots} from './storage.mjs';
// Every string field declares its bound; there is no implicit default.
export const str=maxLength=>({type:'string',minLength:1,maxLength});
export const id={...str(80),pattern:'^[a-zA-Z0-9_-]+$'};
export const seed={type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER,default:42};
export const list=maxItems=>({type:'array',items:id,maxItems});
export const choice=(values,def)=>({type:'string',enum:values,...(def===undefined?{}:{default:def})});
export const object=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
// Long structured video briefs routinely exceed 2000 characters. 32000 Chinese
// characters stay under the 128 KiB job body and 256 KiB stdio frame limits.
export const PROMPT_MAX_LENGTH=32000;
const audioAsset={...id,description:'Imported audio asset_id (import_media kind=audio).'};
export const prompt=note=>({...str(PROMPT_MAX_LENGTH),description:'提示词，最长 '+PROMPT_MAX_LENGTH+' 字符。'+note});

export function validateSchema(schema,input,path='arguments'){
  function check(s,v,path){
    if(s.type==='object'){
      if(!v||typeof v!=='object'||Array.isArray(v))throw new Error(path+' must be an object');
      for(const k of s.required??[])if(v[k]===undefined)throw new Error(path+'.'+k+' is required');
      // A collapsed (advanced) object lists no properties here; the gateway checks it in full.
      if(s.properties)for(const [k,value] of Object.entries(v)){if(!Object.hasOwn(s.properties,k))throw new Error('Unsupported parameter: '+k);check(s.properties[k],value,path+'.'+k);}
    }else if(s.type==='array'){
      if(!Array.isArray(v)||v.length<(s.minItems??0)||v.length>s.maxItems)throw new Error(path+' has invalid item count');v.forEach((x,i)=>check(s.items,x,path+'.'+i));
    }else if(s.type==='string'){
      if(typeof v!=='string'||!v.trim()||v.length<s.minLength||(s.pattern&&!new RegExp(s.pattern).test(v)))throw new Error(path+' is invalid');
      if(s.maxLength!==undefined&&v.length>s.maxLength)throw new Error(path+' exceeds '+s.maxLength+' characters (got '+v.length+')');
    }else if(s.type==='number'){
      if(typeof v!=='number'||!Number.isFinite(v)||v<(s.minimum??-Infinity)||v>(s.maximum??Infinity))throw new Error(path+' is invalid');
    }else if(s.type==='integer'){
      if(!Number.isSafeInteger(v)||v<(s.minimum??-Infinity)||v>(s.maximum??Infinity)||(s.multipleOf&&v%s.multipleOf))throw new Error(path+' is invalid');
    }else if(s.type==='boolean'&&typeof v!=='boolean')throw new Error(path+' must be boolean');
    if(s.enum&&!s.enum.includes(v))throw new Error(path+' must be one of '+s.enum.join(', '));
  }
  check(schema,input,path);return input;
}

export const ID={name:'local-media',version:'0.5.0',transport:'stdio'};

const requestId={...id,description:'Idempotency key; reuse it to retry.'};
// A capability is one kind of work. What the public contract looks like (tool, task, category,
// synchronous path, base parameters) is declared by the engine package that provides it, in
// `platform.surface` of its engine.json; the registry hands the merged declarations to
// defineCapabilities, and the MCP process receives the same ones inside the gateway catalog.
// Nothing here names an engine or a capability: these objects start empty and are filled live.
export const CAPABILITIES={};
export const TOOL_GROUPS={};
// Older single tools that fanned out into several (generate_audio): name -> members and default.
export const LEGACY_GROUPS={};
let DEFINITIONS={};
// Schema shorthands a manifest can use for the shared field shapes: {"$use":"request_id"}.
const PRESETS={request_id:()=>requestId,seed:()=>seed,id:()=>id,prompt:s=>prompt(s.note??''),id_list:s=>({...list(s.max),...(s.min?{minItems:s.min}:{})})};
function expand(schema){
  if(Array.isArray(schema))return schema.map(expand);
  if(!schema||typeof schema!=='object')return schema;
  if(schema.$use){const {$use,note,max,min,...rest}=schema,make=PRESETS[$use];if(!make)throw new Error('Unknown schema preset '+$use);return {...make({note,max,min}),...rest};}
  return Object.fromEntries(Object.entries(schema).map(([k,v])=>[k,expand(v)]));
}
const KINDS=['image','video','audio','text'];
// What a declaration must say. Returns the problems as text; empty when it is consistent.
export function checkDefinitions(definitions){
  const problems=[],slots=new Map(),tools=new Map(),syncs=new Map();
  for(const [capability,d] of Object.entries(definitions)){
    const at=capability+': ';
    if(!/^[a-z]+\.[a-z]+$/.test(capability))problems.push(at+'the capability id is <area>.<action>, lowercase');
    for(const key of ['group','kind','label','description','base','required','example','group_info','category'])if(d[key]===undefined)problems.push(at+'surface.'+key+' is required');
    if(!KINDS.includes(d.kind))problems.push(at+'kind must be one of '+KINDS.join(', '));
    if(d.group_info&&['label','summary','description'].some(k=>typeof d.group_info[k]!=='string'))problems.push(at+'group_info needs label, summary and description');
    if(d.category&&['id','label','summary'].some(k=>typeof d.category[k]!=='string'))problems.push(at+'category needs id, label and summary');
    if(d.category?.id==='other')problems.push(at+'category id "other" is reserved');
    for(const key of d.required??[])if(!Object.hasOwn(d.base??{},key))problems.push(at+'required field '+key+' is not in base');
    const slot=d.group+'/'+(d.task??''),prior=slots.get(slot);if(prior)problems.push(at+'task '+(d.task??'(none)')+' of '+d.group+' is also declared by '+prior);slots.set(slot,capability);
    for(const name of [d.tool??d.group,...(d.aliases??[])]){const other=tools.get(name);if(other&&other!==capability&&name!==d.group)problems.push(at+'tool name '+name+' is also used by '+other);tools.set(name,capability);}
    if(d.sync!==undefined){if(!/^\/v1\/[a-z0-9/_-]+$/.test(d.sync))problems.push(at+'sync must be a /v1/ path');const other=syncs.get(d.sync);if(other)problems.push(at+'sync path '+d.sync+' is also '+other);syncs.set(d.sync,capability);}
  }
  // Capabilities sharing one tool must agree on how it is described and where it is filed.
  const byGroup=new Map();for(const [capability,d] of Object.entries(definitions))byGroup.set(d.group,[...(byGroup.get(d.group)??[]),[capability,d]]);
  for(const [group,members] of byGroup){
    const first=members[0][1];
    for(const [capability,d] of members.slice(1)){
      if(JSON.stringify(d.group_info)!==JSON.stringify(first.group_info))problems.push(capability+': group_info of '+group+' differs from '+members[0][0]);
      if(d.category?.id!==first.category?.id)problems.push(capability+': category of '+group+' differs from '+members[0][0]);
    }
    if(members.length>1&&members.some(([,d])=>d.task===undefined))problems.push(group+': capabilities sharing a tool each need a task');
  }
  return problems;
}
// Replaces the live objects with these declarations (raw, as written in manifests or sent in the
// catalog), in their given order.
export function defineCapabilities(definitions){
  const problems=checkDefinitions(definitions);if(problems.length)throw new Error(problems.join('; '));
  for(const object of [CAPABILITIES,TOOL_GROUPS,LEGACY_GROUPS])for(const key of Object.keys(object))delete object[key];
  DEFINITIONS=structuredClone(definitions);
  for(const [capability,d] of Object.entries(definitions)){
    const {infer,group_info,legacy_groups,...rest}=d;
    CAPABILITIES[capability]={...rest,base:expand(d.base),tool:d.tool??d.group,...(infer?{infer:input=>input[infer.present]?.length>0}:{})};
    TOOL_GROUPS[d.group]??=group_info;
    for(const [name,options] of Object.entries(legacy_groups??{})){const entry=LEGACY_GROUPS[name]??={members:[],default:null};entry.members.push(capability);if(options?.default)entry.default=capability;}
  }
  for(const entry of Object.values(LEGACY_GROUPS))entry.default??=entry.members[0];
}
// The declarations as given, for the catalog the MCP process reads.
export const definitionsOf=()=>structuredClone(DEFINITIONS);
const inGroup=group=>Object.entries(CAPABILITIES).filter(([,c])=>c.group===group);
// Which capability a tool call means: a per-capability name directly; a group by its task,
// else by the inputs (edit when references are given), else its first capability.
export function resolveCapability(tool,input={}){
  const legacy=LEGACY_GROUPS[tool];
  if(legacy)return input.task===undefined?legacy.default:legacy.members.find(c=>CAPABILITIES[c].task===input.task)??null;
  const direct=Object.entries(CAPABILITIES).find(([,c])=>c.tool===tool||c.aliases?.includes(tool));
  if(direct&&!TOOL_GROUPS[tool])return direct[0];
  const members=inGroup(tool);if(!members.length)return null;
  if(input.task!==undefined)return members.find(([,c])=>c.task===input.task)?.[0]??null;
  return (members.find(([,c])=>c.infer?.(input))??members[0])[0];
}
export const isGenerationTool=tool=>!!TOOL_GROUPS[tool]||!!LEGACY_GROUPS[tool]||Object.values(CAPABILITIES).some(c=>c.tool===tool||c.aliases?.includes(tool));
// Kept for stored jobs and checks that have no input to look at.
export const capabilityForTool=tool=>resolveCapability(tool);
export const capabilityForSync=path=>Object.entries(CAPABILITIES).find(([,c])=>c.sync===path)?.[0]??null;

const page={offset:{type:'integer',minimum:0,maximum:100000},limit:{type:'integer',minimum:1,maximum:100}};
// Gateway-level tools that exist whatever engines are installed.
export const COMMON_TOOLS=[
  {name:'browse_media',description:'Start here. Without arguments: the categories of work the enabled engines offer. With category: opens it, so only that work\'s tools are listed from then on; schemas=true also returns their full definitions.',inputSchema:object({category:{...str(40),description:'A category id from the list.'},schemas:{type:'boolean'}}),example:{category:'video'}},
  {name:'list_media_models',description:'Models of the categories you opened (or of category): capabilities with primary and fallback models. With model: its full parameter schemas, including the advanced ones the generation tools keep collapsed. Loads nothing onto the GPU.',inputSchema:object({model:{...str(80),description:'A model id, e.g. minimax-h3.'},category:{...str(40),description:'Only this category.'}}),example:{}},
  {name:'import_media',description:'Import a local image/video/audio from the import roots ('+importRoots().join(', ')+'), the workspace or MEDIA_IMPORT_ROOTS; returns an asset_id. Images become PNG; audio (or a video soundtrack) up to 30 minutes becomes WAV.',inputSchema:object({path:str(4096),kind:choice(['image','video','audio'])},['path','kind']),example:{path:'/media/aoike/Resource_Trad/Project/demo/reference.png',kind:'image'}},
  {name:'search_voices',description:'Find registered voices by name, group or transcript (fuzzy, best first); no query lists them. A hit\'s artifact_id is generate_speech references[].voice_artifact_id; clip_artifact_id plays it via get_artifact.',inputSchema:object({query:{...str(200),description:'Words to find, e.g. “男声 旁白”; each must match name, group or transcript; typos tolerated.'},group:{...str(80),description:'Only this exact group.'},...page}),example:{query:'男声 旁白'}},
  {name:'update_voice',description:'Rename a registered voice or move it to another group. Its artifact_id stays the same.',inputSchema:object({voice_artifact_id:id,name:{...str(80),description:'New name.'},group:{...str(80),description:'New group.'}},['voice_artifact_id']),example:{voice_artifact_id:'artifact_example',name:'女声旁白'}},
  {name:'get_job',description:'Read one job and wait up to 20 s for it to change. A disconnect does not cancel it. state unknown needs inspection, never an automatic resubmit; served_by names the model that ran it.',inputSchema:object({job_id:id,wait_seconds:{type:'integer',minimum:0,maximum:20}},['job_id']),example:{job_id:'job_example',wait_seconds:10}},
  {name:'list_jobs',description:'List your jobs, newest first.',inputSchema:object({...page}),example:{limit:10}},
  {name:'cancel_job',description:'Cancel a job: queued ones at once, running ones only on an interruptible backend (ComfyUI). A false cancellable flag is authoritative.',inputSchema:object({job_id:id},['job_id']),example:{job_id:'job_example'}},
  {name:'get_artifact',description:'A finished artifact: local path and resource link. download=true (or a path) also saves it into the workspace (default <workspace>/downloads/<artifact_id>.<ext>; a path must be inside MEDIA_DOWNLOAD_ROOTS) and adds byte size, sha256 and a signed content_url.',inputSchema:object({artifact_id:id,download:{type:'boolean'},path:{...str(4096),description:'Destination file; implies download.'}},['artifact_id']),example:{artifact_id:'artifact_example',download:true}},
];
// Older tool names, still accepted but no longer listed.
export const LEGACY_TOOLS={download_artifact:'get_artifact'};

export function validateToolInput(toolList,name,input){
  const canonical=LEGACY_TOOLS[name]??(isGenerationTool(name)?CAPABILITIES[resolveCapability(name,input)]?.group??name:name);
  const tool=toolList.find(t=>t.name===canonical);if(!tool)throw new Error('Unknown media tool: '+name);
  // The old generate_audio took task for every kind of work; the split tools without a task field do not.
  if(LEGACY_GROUPS[name]&&input?.task!==undefined&&!tool.inputSchema.properties.task){const {task,...rest}=input;validateSchema(tool.inputSchema,rest);return input;}
  return validateSchema(tool.inputSchema,input);
}

// What a model reads from this server, shared by the MCP process and the console's model view so
// the two can never differ: the server instructions, the listed tools and list_media_models.
export const INSTRUCTIONS='Local media generation through the workbench gateway. Start with browse_media: it lists the categories of work available; opening one lists only that work\'s tools. Generation tools return durable jobs, not media: poll get_job, then get_artifact (download=true saves into the workspace); inspect unknown outcomes before retrying. Parameter descriptions are brief; list_media_models {model} gives full schemas, including collapsed advanced fields. Omit model to use a capability\'s primary model; prefer the engine already running and batch work on it, since switching engines drains the queue and cold-starts the backend.';
// What a client sees first is only browse_media. Opening a category lists the tools of that work,
// plus the ones every kind of work ends with, so a video session never carries the image tools.
// Tools no category names (a new one) fall into "other", so nothing is unreachable.
export const BROWSE='browse_media';
// Listed with every opened category: follow a job, fetch its artifacts, look up models.
export const TASK_TOOLS=['list_media_models','get_job','list_jobs','cancel_job','get_artifact'];
const SHARED_TOOLS=['import_media'];
// Categories come from the capabilities' own declarations (category + the companion tools they
// name, such as the voice library); a tool nothing names falls into "other", so nothing is
// unreachable.
export function categoriesOf(tools){
  const present=new Set(tools.map(t=>t.name)),byId=new Map();
  for(const c of Object.values(CAPABILITIES)){
    if(!c.category)continue;
    const entry=byId.get(c.category.id)??{id:c.category.id,label:c.category.label,summary:c.category.summary,tools:[]};
    for(const name of [c.group,...(c.category.companions??[])])if(!entry.tools.includes(name))entry.tools.push(name);
    byId.set(entry.id,entry);
  }
  const named=new Set([BROWSE,...TASK_TOOLS,...SHARED_TOOLS,...[...byId.values()].flatMap(c=>c.tools)]);
  const extra=tools.filter(t=>!named.has(t.name)).map(t=>t.name);
  return [...byId.values(),...(extra.length?[{id:'other',label:'其他',summary:'其他可用工具',tools:extra}]:[])]
    .map(c=>{const own=c.tools.filter(name=>present.has(name));return {...c,own:own.length,tools:[...own,...SHARED_TOOLS.filter(name=>present.has(name))]};}).filter(c=>c.own).map(({own,...c})=>c);
}
// Models, routes and workflows of the given categories only: a capability's tool says which
// category it belongs to, so a video session never reads the image models.
export function scopeMedia(media,categories){
  const names=new Set(categories.flatMap(c=>c.tools));
  return {...media,models:media.models.filter(m=>m.capabilities.some(cap=>names.has(CAPABILITIES[cap]?.group))),capabilities:media.capabilities.filter(r=>names.has(r.tool)),workflows:(media.workflows??[]).filter(w=>!w.tool||names.has(w.tool))};
}
// The tools of one category as opened: its own, then the task tools.
export const categoryTools=(tools,category)=>{const names=new Set([...category.tools,...TASK_TOOLS]);return tools.filter(t=>names.has(t.name));};
// What tools/list returns for the categories opened so far (none: only browse_media).
export function visibleTools(tools,opened=new Set()){
  const names=new Set([BROWSE]);
  for(const category of categoriesOf(tools))if(opened.has(category.id))for(const t of categoryTools(tools,category))names.add(t.name);
  return tools.filter(t=>names.has(t.name));
}
const firstSentence=text=>{const first=/^(.*?[。.])(\s|$)/.exec(text??'')?.[1]??text??'';return first.length>110?first.slice(0,109)+'…':first;};
// browse_media's answer: the categories, or one category's tools (names and purposes; full
// definitions on request, for clients that do not refresh their tool list).
export function browseResult(tools,{category,schemas=false}={}){
  const categories=categoriesOf(tools);
  if(!category)return {categories:categories.map(({id,label,summary,tools})=>({category:id,label,summary,tools:tools.filter(name=>!SHARED_TOOLS.includes(name))})),next:'Call browse_media {"category": <category>} to open one; its tools are then listed.'};
  const found=categories.find(c=>c.id===category);if(!found)throw new Error('Unknown or unavailable category '+category+'; available: '+categories.map(c=>c.id).join(', '));
  const opened=categoryTools(tools,found);
  return {category:found.id,label:found.label,tools:opened.map(t=>({name:t.name,purpose:firstSentence(t.description)})),
    note:'These tools are now listed. If your client has not refreshed its tool list, call them by name anyway'+(schemas?'.':'; browse_media with schemas=true returns their definitions.'),
    ...(schemas?{definitions:listedTools(opened)}:{})};
}

// What the model sees is a lighter copy of the schema: the gateway and this server still validate
// the full one, so patterns and bounds that only guard ids and short names need not take up context.
function lean(schema){
  if(!schema||typeof schema!=='object')return schema;
  const {pattern,minLength,additionalProperties,...rest}=schema;
  if(rest.maxLength<=200)delete rest.maxLength;
  if(Array.isArray(rest.required)&&!rest.required.length)delete rest.required;
  if(rest.properties)rest.properties=Object.fromEntries(Object.entries(rest.properties).map(([k,v])=>[k,lean(v)]));
  if(rest.items)rest.items=lean(rest.items);
  return rest;
}
export const listedTools=tools=>tools.map(tool=>({name:tool.name,description:tool.description,inputSchema:lean(tool.inputSchema),annotations:{readOnlyHint:['browse_media','list_media_models','get_job','list_jobs','search_voices'].includes(tool.name),destructiveHint:false,openWorldHint:false}}));
// The overview stays small; one model's full schemas (advanced fields included) on request.
export function modelsView(media,model){
  if(model){const found=media.models.find(m=>m.id===model);if(!found)throw new Error('Unknown model '+model+'; omit model to list them');return {model:found,capabilities:media.capabilities.filter(c=>c.providers.includes(found.id))};}
  return {models:media.models.map(({parameter_schemas,...m})=>m),capabilities:media.capabilities,workflows:media.workflows};
}
