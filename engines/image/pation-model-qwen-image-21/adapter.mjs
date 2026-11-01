// Qwen-Image 2.1: text-to-image, RGBA and 1–4 reference edits behind an OpenAI-style API.
import {call,choice,answered,fail} from '../../../platforms/workbench/lib/engine-sdk.mjs';
const PROMPT_LIMIT=4000,PATHS={'image.generate':'/v1/images/generations','image.edit':'/v1/images/edits'};
export default {
  async idle(ctx){return (await call(ctx.base,'/health')).busy===false;},
  async ready(ctx){return (await call(ctx.base,'/health')).status==='ready';},
  params:{'image.generate':model=>({mode:choice(['text-to-image','rgba']),size:choice(model.info.sizes)})},
  notes:{'image.generate':()=>'prompt ≤4000 characters','image.edit':()=>'output 1024×1024, combined reference pixels ≤4194304'},
  validate(capability,input){
    // About 3400 tokens; the 2.1 pipeline does not truncate, so longer prompts are refused.
    if(input.prompt.length>PROMPT_LIMIT)throw fail('Qwen prompt is limited to '+PROMPT_LIMIT+' characters (got '+input.prompt.length+')');
  },
  assets(capability,input,{asset}){
    if(capability!=='image.edit')return [];
    const refs=input.reference_asset_ids.map(id=>asset(id,'image'));
    if(refs.reduce((s,a)=>s+a.width*a.height,0)>4194304)throw fail('Qwen combined reference pixels exceed 4194304');
    if(refs.reduce((s,a)=>s+a.bytes,0)>16*2**20)throw fail('Qwen combined reference files exceed 16 MiB');
    return refs;
  },
  async payload(capability,input,{bytes}){
    const d={prompt:input.prompt,seed:input.seed??42,mode:capability==='image.edit'?'edit':input.mode??'text-to-image',size:input.size??'1024x1024',n:1,steps:40,guidance:1,response_format:'b64_json'};
    if(capability==='image.edit')d.images_b64=await Promise.all(input.reference_asset_ids.map(async id=>(await bytes(id)).toString('base64')));
    return d;
  },
  execute(capability,d,ctx){const {model,...payload}=d;return answered(()=>call(ctx.base,PATHS[capability],payload,1800000));},
  effective(capability,input){return {size:input.size??'1024x1024',mode:capability==='image.edit'?'edit':input.mode??'text-to-image',steps:40,guidance_scale:1};},
};
