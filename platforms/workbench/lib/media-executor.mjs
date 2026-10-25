import {call} from './backend.mjs';
import {runGoldfish} from './goldfish-workflow.mjs';
import {video,beforeSubmission} from './media.mjs';
// Called after admission and the single shared GPU lease. Never calls the gateway itself.
// A single-request backend that answered with an HTTP error has finished; only a lost answer is uncertain.
const answered=async request=>{try{return await request();}catch(e){if(e.status)e.code='BACKEND_FAILED';throw e;}};
export async function executeMedia(model,d,{path='/v1/images/generations',preparedVideos,onSubmitted,outputDirectory}={}){
  if(d.workflow==='yz-h3-ultimate-original')return runGoldfish(d,{onSubmitted,outputDirectory,preparedVideos});
  if(model==='tts')return answered(()=>call('http://127.0.0.1:18986','/v1/audio/speech',d,1800000));
  if(model==='qwen-image'){
    const {model:_,...payload}=d;return answered(()=>call('http://127.0.0.1:8191',path,payload,1800000));
  }
  if(model==='flux'){
    const engine=d.engine??'Paiton',port=engine==='Paiton'?7861:7862;
    await beforeSubmission(async()=>{if(!['Paiton','Stock (Diffusers)'].includes(engine))throw new Error('Invalid FLUX engine');await call('http://127.0.0.1:'+(port===7861?7862:7861),'/unload',{});});
    const result=await answered(()=>call('http://127.0.0.1:'+port,'/generate',{prompt:d.prompt,seed:d.seed??42},1800000)),image=result.image;delete result.image;
    return {data:[{b64_json:image}],metrics:result};
  }
  return video(model,d,{preparedVideos,onSubmitted,outputDirectory});
}
