// Qwen3-ASR 1.7B on the shared audio.cpp runtime: an imported audio asset in, a transcript out.
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ready,idle,runTask} from '../../shared/audiocpp/client.mjs';
export default {
  ready,idle,
  notes:{'audio.transcribe':()=>'Chinese, dialects and ~30 languages, auto-detected; recordings up to 30 minutes'},
  assets(capability,input,{asset}){return [asset(input.audio_asset_id,'audio')];},
  payload(capability,input,{asset}){return {audio:asset(input.audio_asset_id,'audio').file};},
  async execute(capability,d,{base,outputDirectory}){
    const result=await runTask(base,'qwen3-asr',{audio:d.audio});
    const text=String(result.text??'').trim(),file=join(outputDirectory,'transcript.json');
    await writeFile(file,JSON.stringify({text,language:result.language??null,segments:result.segments??[]},null,2),{mode:0o600});
    return {artifacts:[{kind:'text',file,mime:'application/json',name:'transcript',media:{characters:[...text].length,language:result.language??null}}],
      metrics:{text,language:result.language??null,wall_ms:result.timing?.wall_ms??null}};
  },
  effective:(capability,input,media)=>({language:media.language}),
};
