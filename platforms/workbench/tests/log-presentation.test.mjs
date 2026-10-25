import test from 'node:test';
import assert from 'node:assert/strict';
import {presentLog,logDigest} from '../lib/log-presentation.mjs';
test('throughput and speculative metrics are distinct, and raw details are retained',()=>{
 const raw='2026-10-16T06:59:25.060201148Z (APIServer pid=1) INFO 10-16 06:59:25 [loggers.py:310] Engine 000: Avg prompt throughput: 0.0 tokens/s, Avg generation throughput: 122.7 tokens/s, Running: 1 reqs, Waiting: 0 reqs, GPU KV cache usage: 11.7%, Prefix cache hit rate: 0.0%';
 const row=presentLog(raw);assert.equal(row.raw,raw);assert.equal(row.time,'14:59:25');assert.equal(row.kind,'throughput');assert.deepEqual(row.metrics[0],['生成',122.7,'tok/s']);assert.match(logDigest(raw),/执行 1 路/);assert.doesNotMatch(logDigest(raw),/pid=|2026-/);
 const spec=presentLog('SpecDecoding metrics: Mean acceptance length: 3.71, Avg Draft acceptance rate: 38.7%');assert.equal(spec.kind,'speculation');assert.deepEqual(spec.metrics,[['接受长度',3.71,'tokens'],['接受率',38.7,'%']]);
});
test('unknown output, tracebacks and requests retain complete messages',()=>{
 const raw='2026-10-16T06:59:25.060201148Z ERROR: '+ 'diagnostic '.repeat(200);const row=presentLog(raw);assert.equal(row.level,'error');assert.equal(row.message,'diagnostic '.repeat(200));assert.equal(row.raw,raw);
 assert.equal(presentLog('    at long stack frame').message,'    at long stack frame');
 const req=presentLog('INFO: 127.0.0.1:39 - "POST /v1/chat/completions HTTP/1.1" 503 Service Unavailable');assert.equal(req.level,'error');assert.equal(req.title,'POST /v1/chat/completions');assert.deepEqual(req.metrics,[['HTTP',503,'']]);
});
test('image and video logs expose sampling progress and execution completion',()=>{
 const raw='2026-10-16T07:10:00.000Z 50%|█████     | 10/20 [00:12<00:12,  1.20s/it]';
 const row=presentLog(raw);assert.equal(row.kind,'progress');assert.equal(row.raw,raw);assert.deepEqual(row.metrics,[['进度',50,'%'],['采样步',10,'/ 20'],['已用','00:12',''],['预计剩余','00:12',''],['步速',1.2,'s/it']]);
 assert.equal(presentLog('100%|██████████| 4/4 [00:03<00:00, 1.20it/s]').kind,'progress');
 const done=presentLog('Prompt executed in 24.56 seconds');assert.equal(done.kind,'completion');assert.deepEqual(done.metrics,[['执行耗时',24.56,'秒']]);
 assert.equal(presentLog('unexpected 150%|...| 30/20 [00:12]').kind,'message');
});
