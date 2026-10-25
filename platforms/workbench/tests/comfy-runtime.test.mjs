import test from 'node:test';
import assert from 'node:assert/strict';
import {comfyRuntime} from '../lib/comfy-runtime.mjs';
test('native discovery includes arbitrary workflows and redacts prompts and outputs',async()=>{
 const paths=[];const r=await comfyRuntime(async(base,path)=>{
  paths.push(path);assert.equal(base,'http://127.0.0.1:8188');
  if(path==='/system_stats')return {system:{}};
  if(path==='/queue')return {queue_running:[[2,'any-image-workflow',{a:{class_type:'FutureImageNode',inputs:{text:'private'}}}]],queue_pending:[[3,'any-audio-workflow',{}]]};
  return {'custom-workflow':{prompt:[1,'custom-workflow',{node:{class_type:'FutureAudioNode',inputs:{text:'private'}}}],status:{completed:true,status_str:'success',messages:[['execution_start',{timestamp:1000}],['execution_success',{timestamp:5000}]]},outputs:{audio:'private-file'}}};
 });
 assert.equal(r.available,true);assert.equal(r.queue_available,true);assert.equal(r.running[0].prompt_id,'any-image-workflow');assert.equal(r.pending[0].prompt_id,'any-audio-workflow');
 assert.equal(r.history[0].seconds,4);assert.equal(r.history[0].state,'succeeded');assert.equal(r.history[0].finished_at,5);
 assert.equal(JSON.stringify(r).includes('private'),false);assert.ok(paths.includes('/history?max_items=100'));
});
test('history failure preserves live queue and unavailable queue never invents idle',async()=>{
 const r=await comfyRuntime(async(base,path)=>{if(path==='/history?max_items=100')throw Error('history unavailable');return path==='/queue'?{queue_running:[],queue_pending:[[1,'future-native']]}:{system:{}};});
 assert.equal(r.history_available,false);assert.equal(r.queue_available,true);assert.equal(r.pending.length,1);
 const offline=await comfyRuntime(async()=>{throw Error('offline');});assert.equal(offline.available,false);assert.equal(offline.queue_available,false);assert.equal(offline.history_available,false);
});
