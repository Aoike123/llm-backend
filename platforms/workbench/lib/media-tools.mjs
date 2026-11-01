// The media contract with no engine knowledge: schema helpers, capability definitions and the
// gateway-level tools. Shared by the gateway and the MCP server process.
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
export const prompt=note=>({...str(PROMPT_MAX_LENGTH),description:'提示词，最长 '+PROMPT_MAX_LENGTH+' 字符。'+note});

export function validateSchema(schema,input,path='arguments'){
  function check(s,v,path){
    if(s.type==='object'){
      if(!v||typeof v!=='object'||Array.isArray(v))throw new Error(path+' must be an object');
      for(const k of s.required??[])if(v[k]===undefined)throw new Error(path+'.'+k+' is required');
      for(const [k,value] of Object.entries(v)){if(!Object.hasOwn(s.properties,k))throw new Error('Unsupported parameter: '+k);check(s.properties[k],value,path+'.'+k);}
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

const requestId={...id,description:'Unique per owner. Reuse for a retry; different content with same ID is rejected.'};
// A capability is one kind of work. Each belongs to one public tool (its group) under a short
// task name; per-capability names stay accepted as aliases for older clients.
export const CAPABILITIES={
  'image.generate':{group:'generate_image',task:'generate',tool:'generate_image',kind:'image',label:'生图',sync:'/v1/images/generations',
    description:'text to image',
    base:{request_id:requestId,prompt:prompt('各模型的长度上限见 list_media_models。'),seed},required:['request_id','prompt'],
    example:{request_id:'image-001',prompt:'A red ceramic cup'}},
  'image.edit':{group:'generate_image',task:'edit',tool:'edit_image',kind:'image',label:'图像编辑',sync:'/v1/images/edits',
    description:'edit 1–4 imported images given as reference_asset_ids (chosen automatically when they are present)',infer:input=>input.reference_asset_ids?.length>0,
    base:{request_id:requestId,prompt:prompt('各模型的长度上限见 list_media_models。'),seed,reference_asset_ids:{...list(4),minItems:1}},required:['request_id','prompt','reference_asset_ids'],
    example:{request_id:'edit-001',prompt:'Change the cup to blue',reference_asset_ids:['asset_example']}},
  'video.generate':{group:'generate_video',task:'generate',tool:'generate_video',aliases:['run_goldfish_workflow'],kind:'video',label:'视频生成',sync:'/v1/videos/generations',
    description:'text / reference to video',
    base:{request_id:requestId,prompt:prompt('')},required:['request_id','prompt'],
    example:{request_id:'video-001',prompt:'A continuous cinematic shot.'}},
  'speech.synthesize':{group:'generate_audio',task:'speech',tool:'generate_speech',kind:'audio',label:'语音合成',
    description:'synthesize text, optionally cloning imported reference voices',
    base:{request_id:requestId,text:{...str(5000),description:'task=speech：合成文本，最长 5000 字。'},seed},required:['request_id','text'],
    example:{request_id:'speech-001',task:'speech',text:'你好，欢迎来到工作台。'}},
  'audio.separate':{group:'generate_audio',task:'separate',tool:'separate_audio',kind:'audio',label:'人声分离',
    description:'split audio_asset_id into vocals and accompaniment artifacts',
    base:{request_id:requestId,audio_asset_id:{...id,description:'task=separate/transcribe：已导入的音频 asset_id（import_media kind=audio）。'}},required:['request_id','audio_asset_id'],
    example:{request_id:'separate-001',task:'separate',audio_asset_id:'asset_example'}},
  'audio.transcribe':{group:'generate_audio',task:'transcribe',tool:'transcribe_audio',kind:'text',label:'语音识别',
    description:'transcribe audio_asset_id; the transcript is a JSON artifact and metrics.text',
    base:{request_id:requestId,audio_asset_id:{...id,description:'task=separate/transcribe：已导入的音频 asset_id（import_media kind=audio）。'}},required:['request_id','audio_asset_id'],
    example:{request_id:'transcribe-001',task:'transcribe',audio_asset_id:'asset_example'}},
};
export const TOOL_GROUPS={
  generate_image:{label:'图像',description:'Accept a durable image job. Poll get_job; acceptance does not mean generation finished.'},
  generate_video:{label:'视频',description:'Accept a durable video job. Poll get_job, then get_artifact (download=true saves it).'},
  generate_audio:{label:'音频',description:'Accept a durable audio job; task selects the work. Poll get_job; outputs are artifacts.'},
};
const inGroup=group=>Object.entries(CAPABILITIES).filter(([,c])=>c.group===group);
// Which capability a tool call means: a per-capability name directly; a group by its task,
// else by the inputs (edit when references are given), else its first capability.
export function resolveCapability(tool,input={}){
  const direct=Object.entries(CAPABILITIES).find(([,c])=>c.tool===tool||c.aliases?.includes(tool));
  if(direct&&!TOOL_GROUPS[tool])return direct[0];
  const members=inGroup(tool);if(!members.length)return null;
  if(input.task!==undefined)return members.find(([,c])=>c.task===input.task)?.[0]??null;
  return (members.find(([,c])=>c.infer?.(input))??members[0])[0];
}
export const isGenerationTool=tool=>!!TOOL_GROUPS[tool]||Object.values(CAPABILITIES).some(c=>c.tool===tool||c.aliases?.includes(tool));
// Kept for stored jobs and checks that have no input to look at.
export const capabilityForTool=tool=>resolveCapability(tool);
export const capabilityForSync=path=>Object.entries(CAPABILITIES).find(([,c])=>c.sync===path)?.[0]??null;

const page={offset:{type:'integer',minimum:0,maximum:100000},limit:{type:'integer',minimum:1,maximum:100}};
// Gateway-level tools that exist whatever engines are installed.
export const COMMON_TOOLS=[
  {name:'list_media_models',description:'List the enabled media capabilities, their recommended (primary) and fallback models, and each model\'s parameters. Does not load a model.',inputSchema:object(),example:{}},
  {name:'import_media',description:'Import a local image/video/audio from the resource disk (/media/aoike/Resource_Trad/Assets, /media/aoike/Resource_Trad/Project), the workspace or MEDIA_IMPORT_ROOTS. Returns an owned asset_id; no URL fetching. Images are normalized to PNG; audio (or a video\'s soundtrack) up to 30 minutes is stored as WAV.',inputSchema:object({path:str(4096),kind:choice(['image','video','audio'])},['path','kind']),example:{path:'/media/aoike/Resource_Trad/Project/demo/reference.png',kind:'image'}},
  {name:'get_job',description:'Read an owned job, or list owned jobs newest first when job_id is omitted (offset/limit). Optional bounded wait up to 20 seconds. Disconnect does not cancel a job. unknown requires inspection; never automatically resubmit. served_by names the model that actually ran it.',inputSchema:object({job_id:id,wait_seconds:{type:'integer',minimum:0,maximum:20},...page}),example:{job_id:'job_example',wait_seconds:10}},
  {name:'cancel_job',description:'Cancel a job. Queued jobs are cancelled at once. Running jobs on an interruptible backend (ComfyUI) are interrupted and become cancelled once it stops; other running requests finish on their own. A false cancellable flag is authoritative.',inputSchema:object({job_id:id},['job_id']),example:{job_id:'job_example'}},
  {name:'get_artifact',description:'Get an owned completed artifact, its local path and an MCP resource link. With download=true (or a path) it is also saved into the AI workspace — default <workspace>/downloads/<artifact_id>.<ext>; a path must stay inside MEDIA_DOWNLOAD_ROOTS — and the result adds the written path, byte size, sha256 and a short-lived signed content_url.',inputSchema:object({artifact_id:id,download:{type:'boolean'},path:{...str(4096),description:'Optional destination file path; implies download. Relative paths resolve against MEDIA_DOWNLOAD_ROOTS[0].'}},['artifact_id']),example:{artifact_id:'artifact_example',download:true}},
];
// Older tool names, still accepted but no longer listed.
export const LEGACY_TOOLS={list_jobs:'get_job',download_artifact:'get_artifact'};

export function validateToolInput(toolList,name,input){
  const canonical=LEGACY_TOOLS[name]??(isGenerationTool(name)?CAPABILITIES[resolveCapability(name,input)]?.group??name:name);
  const tool=toolList.find(t=>t.name===canonical);if(!tool)throw new Error('Unknown media tool: '+name);
  return validateSchema(tool.inputSchema,input);
}
