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
// A capability is one kind of work. Each belongs to one public tool (its group) under a short
// task name; per-capability names stay accepted as aliases for older clients.
export const CAPABILITIES={
  'image.generate':{group:'generate_image',task:'generate',tool:'generate_image',kind:'image',label:'生图',sync:'/v1/images/generations',
    description:'text to image',
    base:{request_id:requestId,prompt:prompt(''),seed},required:['request_id','prompt'],
    example:{request_id:'image-001',prompt:'A red ceramic cup'}},
  'image.edit':{group:'generate_image',task:'edit',tool:'edit_image',kind:'image',label:'图像编辑',sync:'/v1/images/edits',
    description:'edit 1–4 imported images given as reference_asset_ids (chosen automatically when they are present)',infer:input=>input.reference_asset_ids?.length>0,
    base:{request_id:requestId,prompt:prompt(''),seed,reference_asset_ids:{...list(4),minItems:1}},required:['request_id','prompt','reference_asset_ids'],
    example:{request_id:'edit-001',prompt:'Change the cup to blue',reference_asset_ids:['asset_example']}},
  'video.generate':{group:'generate_video',task:'generate',tool:'generate_video',aliases:['run_goldfish_workflow'],kind:'video',label:'视频生成',sync:'/v1/videos/generations',
    description:'text / reference to video',
    base:{request_id:requestId,prompt:prompt('')},required:['request_id','prompt'],
    example:{request_id:'video-001',prompt:'A continuous cinematic shot.'}},
  'speech.synthesize':{group:'generate_speech',task:'speech',tool:'generate_speech',kind:'audio',label:'语音合成',
    description:'synthesize text, optionally cloning imported reference voices',
    base:{request_id:requestId,text:{...str(5000),description:'合成文本，最长 5000 字。'},seed},required:['request_id','text'],
    example:{request_id:'speech-001',text:'你好，欢迎来到工作台。'}},
  'speech.voice':{group:'register_voice',task:'voice',tool:'register_voice',kind:'text',label:'音色注册',
    description:'register a named voice from audio_asset_id or another audio source; pass the voice artifact later as references[].voice_artifact_id',
    base:{request_id:requestId,name:{...str(80),description:'音色名称，如“男声旁白”。'},group:{...str(80),description:'可选分组，如“旁白”“角色”。'},audio_asset_id:audioAsset},required:['request_id','name'],
    example:{request_id:'voice-001',name:'男声旁白',audio_asset_id:'asset_example'}},
  'audio.separate':{group:'process_audio',task:'separate',tool:'separate_audio',kind:'audio',label:'人声分离',
    description:'split audio_asset_id into vocals and accompaniment artifacts',
    base:{request_id:requestId,audio_asset_id:audioAsset},required:['request_id','audio_asset_id'],
    example:{request_id:'separate-001',task:'separate',audio_asset_id:'asset_example'}},
  'audio.transcribe':{group:'process_audio',task:'transcribe',tool:'transcribe_audio',kind:'text',label:'语音识别',
    description:'transcribe audio_asset_id; the transcript is a JSON artifact and metrics.text',
    base:{request_id:requestId,audio_asset_id:audioAsset},required:['request_id','audio_asset_id'],
    example:{request_id:'transcribe-001',task:'transcribe',audio_asset_id:'asset_example'}},
};
export const TOOL_GROUPS={
  generate_image:{label:'图像',description:'Create an image job: text to image, or edit when reference_asset_ids are given. Poll get_job.'},
  generate_video:{label:'视频',description:'Create a video job. Poll get_job, then get_artifact.'},
  generate_speech:{label:'语音合成',description:'Create a speech job: synthesize text, optionally cloning registered voices (voice_artifact_id from search_voices) or imported clips. Poll get_job.'},
  register_voice:{label:'音色注册',description:'Register a named voice from a 1–30 s clip so generate_speech can reuse it; find and rename voices with search_voices and update_voice. Poll get_job.'},
  process_audio:{label:'音频处理',description:'Create an audio analysis job on an imported clip. Poll get_job.'},
};
// The old single audio tool: still accepted (task picks the work) but no longer listed.
export const LEGACY_GROUPS={generate_audio:['speech.synthesize','speech.voice','audio.separate','audio.transcribe']};
const inGroup=group=>Object.entries(CAPABILITIES).filter(([,c])=>c.group===group);
// Which capability a tool call means: a per-capability name directly; a group by its task,
// else by the inputs (edit when references are given), else its first capability.
export function resolveCapability(tool,input={}){
  if(LEGACY_GROUPS[tool]){const task=input.task;return LEGACY_GROUPS[tool].find(c=>task===undefined?c===LEGACY_GROUPS[tool][0]:CAPABILITIES[c].task===task)??null;}
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
  {name:'browse_media',description:'Start here. Without arguments: the media categories (image, video, speech and voices, audio). With category: opens it, so only that work\'s tools are listed from then on; schemas=true also returns their full definitions.',inputSchema:object({category:choice(['image','video','speech','audio','other']),schemas:{type:'boolean'}}),example:{category:'video'}},
  {name:'list_media_models',description:'Models of the categories you opened (or of category): capabilities with primary and fallback models. With model: its full parameter schemas, including the advanced ones the generation tools keep collapsed. Loads nothing onto the GPU.',inputSchema:object({model:{...str(80),description:'A model id, e.g. minimax-h3.'},category:{...choice(['image','video','speech','audio','other']),description:'Only this category.'}}),example:{}},
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
export const INSTRUCTIONS='Local media generation through the workbench gateway. Start with browse_media: it lists the categories (image, video, speech and voices, audio); opening one lists only that work\'s tools. Generation tools return durable jobs, not media: poll get_job, then get_artifact (download=true saves into the workspace); inspect unknown outcomes before retrying. Parameter descriptions are brief; list_media_models {model} gives full schemas, including collapsed advanced fields. Omit model to use a capability\'s primary model; prefer the engine already running and batch work on it, since switching engines drains the queue and cold-starts the backend.';
// What a client sees first is only browse_media. Opening a category lists the tools of that work,
// plus the ones every kind of work ends with, so a video session never carries the image tools.
// Tools no category names (a new one) fall into "other", so nothing is unreachable.
export const BROWSE='browse_media';
export const CATEGORIES=[
  {id:'image',label:'图像',summary:'文生图，以及基于参考图的编辑',tools:['generate_image','import_media']},
  {id:'video',label:'视频',summary:'文生、图生、参考生视频',tools:['generate_video','import_media']},
  {id:'speech',label:'语音与音色',summary:'语音合成与克隆；注册、查找、改名音色',tools:['generate_speech','register_voice','search_voices','update_voice','import_media']},
  {id:'audio',label:'音频处理',summary:'人声分离、语音识别',tools:['process_audio','import_media']},
];
// Listed with every opened category: follow a job, fetch its artifacts, look up models.
export const TASK_TOOLS=['list_media_models','get_job','list_jobs','cancel_job','get_artifact'];
const SHARED_TOOLS=['import_media'];
// Models, routes and workflows of the given categories only: a capability's tool says which
// category it belongs to, so a video session never reads the image models.
export function scopeMedia(media,categories){
  const names=new Set(categories.flatMap(c=>c.tools));
  return {...media,models:media.models.filter(m=>m.capabilities.some(cap=>names.has(CAPABILITIES[cap]?.group))),capabilities:media.capabilities.filter(r=>names.has(r.tool)),workflows:(media.workflows??[]).filter(w=>!w.tool||names.has(w.tool))};
}
export function categoriesOf(tools){
  const present=new Set(tools.map(t=>t.name)),named=new Set([BROWSE,...TASK_TOOLS,...CATEGORIES.flatMap(c=>c.tools)]);
  const extra=tools.filter(t=>!named.has(t.name)).map(t=>t.name);
  return [...CATEGORIES,...(extra.length?[{id:'other',label:'其他',summary:'其他可用工具',tools:extra}]:[])]
    .map(c=>({...c,tools:c.tools.filter(name=>present.has(name))})).filter(c=>c.tools.some(name=>!SHARED_TOOLS.includes(name)));
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
