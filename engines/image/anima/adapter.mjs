// Anima v1.1 on the shared native ComfyUI runtime: the cataloged canvas graphs, filled in per request.
// Text-to-image uses the Turbo or Aesthetic graph; an edit is an image-to-image redraw of one reference.
import {randomUUID} from 'node:crypto';
import {seed,choice,str,fail} from '../../../platforms/workbench/lib/engine-sdk.mjs';
import {idle,ready,interrupt,workflowGraph,uploadFile,runPrompt,imageOutput,recoverPrompt,beforeSubmission} from '../../shared/comfyui/client.mjs';
const QUALITY={turbo:'anima-turbo-text',aesthetic:'anima-aesthetic-text'};
// Anima reads quality and rating tags first; Aesthetic is tuned without score_* tags.
const TAGS={turbo:'masterpiece, best quality, score_7, safe',aesthetic:'masterpiece, best quality, safe'};
// About one megapixel in multiples of 64, the resolution Anima was trained around.
const ASPECT={'1:1':[1024,1024],'3:4':[896,1152],'4:3':[1152,896],'9:16':[768,1344],'16:9':[1344,768]};
const STRENGTH={type:'number',minimum:0.05,maximum:1,default:0.6,description:'Redraw strength (denoise); lower keeps more of the reference'};
const common={quality:choice(Object.keys(QUALITY),'turbo'),negative_prompt:str(4000)};
const id=()=>randomUUID().replaceAll('-','');

export async function buildAnimaGraph(capability,d,{uploadImage}={}){
  const quality=d.quality??'turbo',reference=capability==='image.edit';
  if(!QUALITY[quality])throw new Error('quality must be turbo or aesthetic');
  const graph=await workflowGraph(reference?'anima-turbo-image':QUALITY[quality]);
  if(reference&&quality==='aesthetic'){
    // The image graph is the Turbo template; Aesthetic swaps its model and sampler settings in.
    const aesthetic=await workflowGraph(QUALITY.aesthetic);
    graph['1'].inputs.unet_name=aesthetic['1'].inputs.unet_name;
    for(const key of ['steps','cfg','sampler_name','scheduler'])graph['7'].inputs[key]=aesthetic['7'].inputs[key];
  }
  graph['4'].inputs.text=TAGS[quality]+', '+d.prompt;
  if(d.negative_prompt)graph['5'].inputs.text=d.negative_prompt;
  graph['7'].inputs.seed=d.seed??42;
  if(reference){
    graph['10'].inputs.image=await uploadImage(Buffer.from(d.images_b64[0],'base64'));
    graph['7'].inputs.denoise=d.strength??0.6;
  }else{
    const [width,height]=ASPECT[d.aspect_ratio??'1:1']??[];if(!width)throw new Error('Unsupported aspect_ratio');
    Object.assign(graph['6'].inputs,{width,height});
  }
  // A preview node keeps the result in ComfyUI's temp directory; the job directory holds the copy.
  graph['9']={class_type:'PreviewImage',inputs:{images:graph['9'].inputs.images}};
  return graph;
}

export default {
  idle,ready,interrupt,
  params:{
    'image.generate':()=>({...common,aspect_ratio:choice(Object.keys(ASPECT),'1:1')}),
    'image.edit':()=>({...common,strength:STRENGTH}),
  },
  notes:{
    'image.generate':()=>'anime/illustration style; Danbooru-style tags or natural language; quality and rating tags are prepended',
    'image.edit':()=>'image-to-image redraw of exactly one reference (about 1 MP), not instruction editing; strength sets how much changes',
  },
  validate(capability,input){
    if(capability==='image.edit'&&input.reference_asset_ids?.length!==1)throw fail('Anima redraws exactly one reference image');
  },
  assets(capability,input,{asset}){return capability==='image.edit'?input.reference_asset_ids.map(id=>asset(id,'image')):[];},
  // The same body shape as the synchronous /v1/images/* API.
  async payload(capability,input,{bytes}){
    const d={prompt:input.prompt,seed:input.seed??42,quality:input.quality??'turbo'};
    for(const key of ['negative_prompt','aspect_ratio','strength'])if(input[key]!==undefined)d[key]=input[key];
    if(capability==='image.edit')d.images_b64=[(await bytes(input.reference_asset_ids[0])).toString('base64')];
    return d;
  },
  syncValidate(capability,body){
    if(capability==='image.edit'&&body.images_b64?.length!==1)throw fail('Anima redraws exactly one image (images_b64)');
  },
  async execute(capability,d,{base,onSubmitted}){
    const started=performance.now();
    const graph=await beforeSubmission(()=>buildAnimaGraph(capability,d,{uploadImage:raw=>uploadFile(base,raw,'png','image/png')}));
    const {prompt_id,entry}=await runPrompt(base,graph,{onSubmitted,label:'Anima workflow'});
    const image=await imageOutput(base,entry);
    return {created:Math.floor(Date.now()/1000),data:[{b64_json:image.toString('base64')}],metrics:{prompt_id,generation_seconds:(performance.now()-started)/1000,quality:d.quality??'turbo'}};
  },
  effective(capability,input){
    const quality=input.quality??'turbo',e={quality,seed:input.seed??42};
    return capability==='image.edit'?{...e,mode:'image-to-image',strength:input.strength??0.6}:{...e,mode:'text-to-image',size:(ASPECT[input.aspect_ratio??'1:1']).join('x')};
  },
  recover:(job,ctx)=>recoverPrompt(job,ctx,async(base,entry)=>({data:[{b64_json:(await imageOutput(base,entry)).toString('base64')}]})),
};
