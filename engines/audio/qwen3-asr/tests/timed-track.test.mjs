import test from 'node:test';
import assert from 'node:assert/strict';
import {timedTrack} from '../adapter.mjs';
const word=(word,start,end)=>({word,start_sample:start*16000,end_sample:end*16000});
test('words become seconds and segments split at pauses',()=>{
  const track=timedTrack({words:[word('你',1,1.2),word('好',1.2,1.5),word('hello',1.6,2),word('world',2,2.4),word('再',5,5.2),word('见',5.2,5.5)]});
  assert.deepEqual(track.segments.map(s=>[s.text,s.start,s.end]),[['你好 hello world',1,2.4],['再见',5,5.5]]);
  assert.equal(track.words.length,6);
  assert.equal(track.text,'你好 hello world 再见');
});
test('no speech gives an empty track',()=>{assert.deepEqual(timedTrack({words:[]}).segments,[]);});
