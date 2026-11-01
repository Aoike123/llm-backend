// BS-RoFormer on the shared audio.cpp runtime: vocals and accompaniment as two WAV artifacts.
import {join} from 'node:path';
import {saveWav,fail} from '../../../platforms/workbench/lib/engine-sdk.mjs';
import {ready,idle,runTask} from '../../shared/audiocpp/client.mjs';
export default {
  ready,idle,
  notes:{'audio.separate':()=>'music source separation; the vocals artifact can be a speech reference directly'},
  assets(capability,input,{asset}){return [asset(input.audio_asset_id,'audio')];},
  payload(capability,input,{asset}){return {audio:asset(input.audio_asset_id,'audio').file};},
  async execute(capability,d,{base,outputDirectory}){
    const result=await runTask(base,'bs-roformer',{audio:d.audio});
    const stems=result.named_audio_outputs??[];if(!stems.length)throw fail('Separation returned no stems');
    const artifacts=[];
    for(const stem of stems){
      if(!/^[a-z_]+$/.test(stem.id??''))throw fail('Separation returned an unnamed stem');
      const file=join(outputDirectory,stem.id+'.wav');artifacts.push({kind:'audio',file,mime:'audio/wav',name:stem.id,media:await saveWav(file,stem.audio)});
    }
    return {artifacts,metrics:{wall_ms:result.timing?.wall_ms??null,stems:artifacts.map(a=>a.name)}};
  },
};
