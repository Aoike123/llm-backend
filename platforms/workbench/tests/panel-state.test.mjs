import test from 'node:test';
import assert from 'node:assert/strict';
import {serviceRecords,serviceState,newLogLines,logSummary,cleanLogOutput,engineLogText,followedEngine,engineFollowChanged} from '../lib/panel.mjs';

test('browsing services isolates records and distinguishes loading, active and target engines',()=>{
  const d={model:'flux',current_model:'llm',timestamp:2000,active:0,recent:[
    {model:'llm',finished_at:1900},{model:'flux',finished_at:1950},{model:'flux',finished_at:500},
  ]};
  assert.deepEqual(serviceRecords(d,'flux',15),[{model:'flux',finished_at:1950}]);
  assert.equal(serviceState(null,'flux'),'loading');
  assert.equal(serviceState(d,'flux'),'inactive');
  assert.equal(serviceState(d,'llm'),'ready');
  assert.equal(serviceState({...d,switching:true,switching_target:'flux'},'flux'),'switching');
  assert.equal(serviceState({...d,switching:true,switching_target:'flux'},'llm'),'inactive');
  assert.equal(serviceState({...d,pending_llm_mode:'custom'},'llm'),'switching');
});
test('log tails count new lines across rolling windows and repeated output',()=>{
  assert.equal(cleanLogOutput('\x1b[32mINFO\x1b[0m progress\rcomplete'),'INFO progress\ncomplete');
  assert.deepEqual(newLogLines('a\nb\nb\n','b\nb\nc\n'),['c']);
  assert.deepEqual(newLogLines('a\nb\n','a\nb\n'),[]);
  assert.deepEqual(newLogLines('a\nb\n','new instance\n'),['new instance']);
  assert.deepEqual(newLogLines('','ready\n'),['ready']);
  assert.deepEqual(logSummary(['INFO request done','WARN capacity low','ERROR engine failed','INFO retry']),{
    text:'ERROR engine failed',level:'error',errors:1,
  });
});

test('startup log rendering combines actual progress and media output without old Qwen runtime',()=>{
 const progress={events:[{source:'launcher',message:'download weights'}]};
 assert.match(engineLogText({model:'h3',engine_switch:progress,output:'container startup'},true),/download weights[\s\S]*container startup/);
 const qwen=engineLogText({model:'llm',engine_switch:progress,output:'previous runtime',startup_output:null},true);
 assert.match(qwen,/download weights/);assert.doesNotMatch(qwen,/previous runtime/);
 assert.match(engineLogText({model:'wan',available:false,engine_switch:progress},true),/download weights/);
});

test('engine following resumes on a real engine change while ordinary polling preserves browsing',()=>{
 const running={model:'llm',current_model:'qwen-image'};
 assert.equal(followedEngine(running),'qwen-image');
 assert.equal(engineFollowChanged(undefined,running),false);
 assert.equal(engineFollowChanged('qwen-image',running),false);
 assert.equal(engineFollowChanged('qwen-image',{...running,switching_target:'wan'}),true);
 assert.equal(followedEngine({...running,switching_target:'wan'}),'wan');
 assert.equal(followedEngine({...running,pending_llm_mode:'custom'}),'llm');
 assert.equal(engineFollowChanged('wan',{model:'llm',current_model:'wan'}),false);
 assert.equal(engineFollowChanged('wan',{current_model:null}),false);
 assert.equal(engineFollowChanged(null,{current_model:'flux'}),true);
});
