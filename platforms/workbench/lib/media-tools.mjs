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
export const CAPABILITIES={
  'image.generate':{tool:'generate_image',kind:'image',label:'生图',sync:'/v1/images/generations',
    description:'Accept a durable image job. Poll get_job; acceptance does not mean generation finished.',
    base:{request_id:requestId,prompt:prompt('各模型的长度上限见 list_media_models。'),seed},required:['request_id','prompt'],
    example:{request_id:'image-001',prompt:'A red ceramic cup'}},
  'image.edit':{tool:'edit_image',kind:'image',label:'图像编辑',sync:'/v1/images/edits',
    description:'Accept an image edit job with 1–4 imported image asset IDs.',
    base:{request_id:requestId,prompt:prompt('各模型的长度上限见 list_media_models。'),seed,reference_asset_ids:{...list(4),minItems:1}},required:['request_id','prompt','reference_asset_ids'],
    example:{request_id:'edit-001',prompt:'Change the cup to blue',reference_asset_ids:['asset_example']}},
  'video.generate':{tool:'generate_video',aliases:['run_goldfish_workflow'],kind:'video',label:'视频生成',sync:'/v1/videos/generations',
    description:'Accept a durable video job. Returns a job ID; use get_job / get_artifact / download_artifact to retrieve the result.',
    base:{request_id:requestId,prompt:prompt('')},required:['request_id','prompt'],
    example:{request_id:'video-001',prompt:'A continuous cinematic shot.'}},
  'speech.synthesize':{tool:'generate_speech',kind:'audio',label:'语音合成',
    description:'Accept a durable speech job: synthesize text, optionally cloning imported reference voices. Poll get_job.',
    base:{request_id:requestId,text:{...str(5000),description:'合成文本，最长 5000 字。'},seed},required:['request_id','text'],
    example:{request_id:'speech-001',text:'你好，欢迎来到工作台。'}},
  'audio.separate':{tool:'separate_audio',kind:'audio',label:'人声分离',
    description:'Accept a durable job that splits an imported audio asset into vocals and accompaniment. Poll get_job; each stem is an artifact.',
    base:{request_id:requestId,audio_asset_id:{...id,description:'已导入的音频 asset_id（import_media kind=audio）。'}},required:['request_id','audio_asset_id'],
    example:{request_id:'separate-001',audio_asset_id:'asset_example'}},
  'audio.transcribe':{tool:'transcribe_audio',kind:'text',label:'语音识别',
    description:'Accept a durable job that transcribes an imported audio asset. Poll get_job; the transcript is a JSON artifact and also returned in metrics.text.',
    base:{request_id:requestId,audio_asset_id:{...id,description:'已导入的音频 asset_id（import_media kind=audio）。'}},required:['request_id','audio_asset_id'],
    example:{request_id:'transcribe-001',audio_asset_id:'asset_example'}},
};
export const capabilityForTool=tool=>Object.entries(CAPABILITIES).find(([,c])=>c.tool===tool||c.aliases?.includes(tool))?.[0]??null;
export const capabilityForSync=path=>Object.entries(CAPABILITIES).find(([,c])=>c.sync===path)?.[0]??null;

// Gateway-level tools that exist whatever engines are installed.
export const COMMON_TOOLS=[
  {name:'list_media_models',description:'List the enabled media capabilities, their recommended (primary) and fallback models, and each model\'s parameters. Does not load a model.',inputSchema:object(),example:{}},
  {name:'import_media',description:'Import a local image/video/audio from the resource disk (/media/aoike/Resource_Trad/Assets, /media/aoike/Resource_Trad/Project), the workspace or MEDIA_IMPORT_ROOTS. Returns an owned asset_id; no URL fetching. Images are normalized to PNG.',inputSchema:object({path:str(4096),kind:choice(['image','video','audio'])},['path','kind']),example:{path:'/media/aoike/Resource_Trad/Project/demo/reference.png',kind:'image'}},
  {name:'get_job',description:'Read an owned job. Optional bounded wait up to 20 seconds. Disconnect does not cancel a job. unknown requires inspection; never automatically resubmit. served_by names the model that actually ran it.',inputSchema:object({job_id:id,wait_seconds:{type:'integer',minimum:0,maximum:20}},['job_id']),example:{job_id:'job_example',wait_seconds:10}},
  {name:'list_jobs',description:'List only jobs owned by this API identity, newest first, with offset pagination.',inputSchema:object({offset:{type:'integer',minimum:0,maximum:100000},limit:{type:'integer',minimum:1,maximum:100}}),example:{limit:20}},
  {name:'cancel_job',description:'Cancel a job. Queued jobs are cancelled at once. Running jobs on an interruptible backend (ComfyUI) are interrupted and become cancelled once it stops; other running requests finish on their own. A false cancellable flag is authoritative.',inputSchema:object({job_id:id},['job_id']),example:{job_id:'job_example'}},
  {name:'get_artifact',description:'Get an owned completed artifact, its local path and an MCP resource link. Does not return large base64 media.',inputSchema:object({artifact_id:id},['artifact_id']),example:{artifact_id:'artifact_example'}},
  {name:'download_artifact',description:'Download a completed artifact into the AI workspace. Defaults to <workspace>/downloads/<artifact_id>.<ext>; an explicit path must stay inside MEDIA_DOWNLOAD_ROOTS. Returns the written path, byte size, sha256 and a short-lived signed content_url.',inputSchema:object({artifact_id:id,path:{...str(4096),description:'Optional destination file path. Relative paths resolve against MEDIA_DOWNLOAD_ROOTS[0].'}},['artifact_id']),example:{artifact_id:'artifact_example',path:'artifacts/result.mp4'}},
];

export function validateToolInput(toolList,name,input){
  const capability=capabilityForTool(name),canonical=capability?CAPABILITIES[capability].tool:name;
  const tool=toolList.find(t=>t.name===canonical);if(!tool)throw new Error('Unknown media tool: '+name);
  return validateSchema(tool.inputSchema,input);
}
