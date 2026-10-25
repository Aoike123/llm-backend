import {call} from './backend.mjs';
import {runGoldfish} from './goldfish-workflow.mjs';
import {video} from './media.mjs';
// Called after admission and the single shared GPU lease. Never calls the gateway itself.
export async function executeMedia(model,d,{path='/v1/images/generations',preparedVideos,onSubmitted,outputDirectory}={}){
  if(d.workflow==='yz-h3-ultimate-original')return runGoldfish(d,{onSubmitted,outputDirectory,preparedVideos});
  if(model==='tts')return call('http://127.0.0.1:18986','/v1/audio/speech',d,1800000);
  if(model==='qwen-image'){
    const {model:_,...payload}=d;return call('http://127.0.0.1:8191',path,payload,1800000);
  }
  if(model==='flux'){
    const engine=d.engine??'Paiton';if(!['Paiton','Stock (Diffusers)'].includes(engine))throw new Error('Invalid FLUX engine');
    const port=engine==='Paiton'?7861:7862;
    await call('http://127.0.0.1:'+(port===7861?7862:7861),'/unload',{});
    const result=await call('http://127.0.0.1:'+port,'/generate',{prompt:d.prompt,seed:d.seed??42},1800000),image=result.image;delete result.image;
    return {data:[{b64_json:image}],metrics:result};
  }
  return video(model,d,{preparedVideos,onSubmitted,outputDirectory});
}
