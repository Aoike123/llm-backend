// Internal media API schemas. MCP exports only its supported image subset.
import {GOLDFISH_CONTROLS,validateGoldfishControls} from './goldfish-controls.mjs';
import {runtimeFor,runtimeTopology} from './runtime-topology.mjs';
export {runtimeTopology};
export const ID={name:'local-media',version:'0.1.0',transport:'stdio'};
// Every string field declares its bound; there is no implicit default.
const str=maxLength=>({type:'string',minLength:1,maxLength});
// Long structured video briefs routinely exceed 2000 characters. 32000 Chinese
// characters stay under the 128 KiB job body and 256 KiB stdio frame limits.
const PROMPT_MAX_LENGTH=32000;
const prompt=note=>({...str(PROMPT_MAX_LENGTH),description:'提示词，最长 '+PROMPT_MAX_LENGTH+' 字符。'+note});
const id={...str(80),pattern:'^[a-zA-Z0-9_-]+$'};
const seed={type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER,default:42};
const list=(maxItems)=>({type:'array',items:id,maxItems});
const choice=(values,def)=>({type:'string',enum:values,...(def===undefined?{}:{default:def})});
const object=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const common={request_id:{...id,description:'Unique per owner. Reuse for a retry; different content with same ID is rejected.'},prompt:prompt('Qwen 图片模型最长 4000 字符（约 3400 token，2.1 管线不截断）。'),seed};
export const MODELS=[
  {id:'flux2-klein',engine:'flux',kind:'image',tasks:['text-to-image'],engines:['paiton','stock'],size:'backend native'},
  {id:'qwen-image21',engine:'qwen-image',kind:'image',tasks:['text-to-image','rgba','edit'],sizes:['1024x1024','2048x2048'],edit_size:'1024x1024',max_reference_images:4,steps:40,guidance_scale:1},
  {id:'minimax-h3',engine:'h3',kind:'video',tasks:['text-to-video','first-frame','first-last-frame','multimodal-reference'],max_reference_images:9,max_reference_videos:3,total_reference_video_seconds:15,presets:['turbo8','turbo4','reference','reference-turbo4']},
  {id:'cosyvoice3-rl',engine:'tts',kind:'audio',
   tasks:['text-to-speech','voice-clone','instruct'],
   min_reference_seconds:3,max_reference_seconds:30,max_text_characters:5000,
   pinyin_tags:'[拼音+声调]',
   pinyin_tones:[1,2,3,4,5],
   pinyin_examples:['[shan4] → [sh][àn]','[chong2] → [ch][óng]','[lv4] → [l][ǜ]','[an4] → [àn]'],
   pinyin_rules:'拼音音节不带声调；ü 写作 v；声调 5 或省略表示轻声；未识别的标注按普通文本处理'}
].map(model=>({...model,execution_runtime:runtimeFor(model.engine)}));
export const VIDEO_TOOL={name:'generate_video',description:'H3 视频生成（MiniMax-H3 原版 ComfyUI 工作流）。图像0–9张、视频0–3段、独立音频0–3段，总参考文件≤12；数组顺序对应工作流槽位，省略即关闭。可控制参考组、六层 LoRA、SelfLift 采样、画幅与分辨率、显存优化与输出。返回持久任务ID，用 get_job / get_artifact / download_artifact 取回结果。',inputSchema:object({request_id:common.request_id,prompt:prompt('用 <Picture N>/<Video N>/<Audio N> 引用素材；长提示会增加原生编码耗时，不会被截断。'),reference_asset_ids:list(9),reference_video_asset_ids:list(3),reference_audio_asset_ids:list(3),seed:{...seed,default:905138662823835},duration_seconds:{type:'integer',minimum:4,maximum:15,default:10},...GOLDFISH_CONTROLS},['request_id','prompt']),example:{request_id:'video-001',prompt:'Use <Picture 1>, <Picture 2> and <Picture 3> as character and scene references. A continuous cinematic shot.',reference_asset_ids:['asset_character1','asset_character2','asset_scene'],duration_seconds:10,loras:{combat:{enabled:true,strength:0.65},motion_speed:{enabled:false}},optimizations:{low_vram_enabled:true,head_chunks:4},output:{include_audio:true}}};
export const TOOLS=[
  VIDEO_TOOL,
  {name:'list_media_models',description:'List local image/video models and their supported parameters. Does not load a model.',inputSchema:object(),example:{}},
  {name:'import_media',description:'Import a local image/video/audio from the resource disk (/media/aoike/Resource_Trad/Assets, /media/aoike/Resource_Trad/Project), the workspace or MEDIA_IMPORT_ROOTS. Returns an owned asset_id; no URL fetching. Images are normalized to PNG.',inputSchema:object({path:str(4096),kind:choice(['image','video','audio'])},['path','kind']),example:{path:'/media/aoike/Resource_Trad/Project/demo/reference.png',kind:'image'}},
  {name:'generate_image',description:'Accept a durable image job. Poll get_job; acceptance does not mean generation finished. FLUX: engine only; Qwen: mode and size only.',inputSchema:object({...common,model:choice(['flux2-klein','qwen-image21']),engine:choice(['paiton','stock']),mode:choice(['text-to-image','rgba']),size:choice(['1024x1024','2048x2048'])},['request_id','model','prompt']),example:{request_id:'image-001',model:'qwen-image21',prompt:'A red ceramic cup',size:'1024x1024'}},
  {name:'edit_image',description:'Accept a Qwen image edit job with 1–4 imported image asset IDs. Output is 1024×1024. Combined reference pixels ≤4194304.',inputSchema:object({...common,reference_asset_ids:{...list(4),minItems:1}},['request_id','prompt','reference_asset_ids']),example:{request_id:'edit-001',prompt:'Change the cup to blue',reference_asset_ids:['asset_example']}},
  {name:'generate_audio',description:'Accept a durable speech job. Requires an imported audio asset (3–30 s) as the voice reference. Text supports [pinyin+tone] tags such as [shan4]; see pronunciation in list_media_models.',inputSchema:object({request_id:{...id,description:'Unique per owner. Reuse for a retry; different content with same ID is rejected.'},text:{...str(5000),description:'合成文本，最长 5000 字。拼音标注规则见 list_media_models 的 pinyin_tags/pinyin_tones/pinyin_examples：如 [shan4] → [sh][àn]。'},reference_asset_id:{...id,description:'已导入的参考音频 asset_id（3–30 秒，import_media kind=audio）。'},reference_text:{...str(2000),description:'参考音频对应的文字，用于零样本克隆。'},instruct:{...str(500),description:'自然语言风格指令，如“新闻播报、语速稍快”；服务端会自动补 You are a helpful assistant. 前缀。'},speed:{type:'number',minimum:0.5,maximum:2,default:1,description:'语速倍率，0.5–2，默认 1。'},seed:{...seed,description:'随机种子；相同参数与种子可复现。'}} ,['request_id','text','reference_asset_id']),example:{request_id:'audio-001',text:'今天我去见[shan4]田芳。',reference_asset_id:'asset_example',reference_text:'希望你以后能够做的比我还好呦。'}},
  {name:'get_job',description:'Read an owned job. Optional bounded wait up to 20 seconds. Disconnect does not cancel a job. unknown requires inspection; never automatically resubmit.',inputSchema:object({job_id:id,wait_seconds:{type:'integer',minimum:0,maximum:20}},['job_id']),example:{job_id:'job_example',wait_seconds:10}},
  {name:'list_jobs',description:'List only jobs owned by this API identity, newest first, with offset pagination.',inputSchema:object({offset:{type:'integer',minimum:0,maximum:100000},limit:{type:'integer',minimum:1,maximum:100}}),example:{limit:20}},
  {name:'cancel_job',description:'Cancel only before dispatch to the backend. Running jobs are not interruptible. A false cancellable flag is authoritative.',inputSchema:object({job_id:id},['job_id']),example:{job_id:'job_example'}},
  {name:'get_artifact',description:'Get an owned completed artifact, its local path and an MCP resource link. Does not return large base64 media.',inputSchema:object({artifact_id:id},['artifact_id']),example:{artifact_id:'artifact_example'}},
  {name:'download_artifact',description:'Download a completed artifact into the AI workspace. Defaults to <workspace>/downloads/<artifact_id>.<ext>; an explicit path must stay inside MEDIA_DOWNLOAD_ROOTS. Returns the written path, byte size, sha256 and a short-lived signed content_url.',inputSchema:object({artifact_id:id,path:{...str(4096),description:'Optional destination file path. Relative paths resolve against MEDIA_DOWNLOAD_ROOTS[0].'}},['artifact_id']),example:{artifact_id:'artifact_example',path:'artifacts/result.mp4'}}
];
export function validateToolInput(tools,name,input){
  if(name==='run_goldfish_workflow')name='generate_video';
  const tool=tools.find(t=>t.name===name);if(!tool)throw new Error('Unknown media tool');
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
  check(tool.inputSchema,input,'arguments');
  if(name==='generate_video'||name==='run_goldfish_workflow')validateGoldfishControls(input);
  return input;
}

export const validateInput=(name,input)=>validateToolInput(TOOLS,name,input);
