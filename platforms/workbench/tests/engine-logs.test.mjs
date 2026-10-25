import test from 'node:test';
import assert from 'node:assert/strict';
import {successfulProbe,EngineLogBuffer} from '../lib/engine-logs.mjs';
const line=(n,text)=>`2026-10-16T05:30:${String(n).padStart(2,'0')}.000000000Z ${text}`;
test('successful read-only probes are hidden across all engines, failures and generation survive',()=>{
 for(const path of ['/health','/v1/models','/metrics','/queue','/system_stats','/is_sleeping'])assert.equal(successfulProbe(`INFO: 127.0.0.1:1 - "GET ${path}?x=1 HTTP/1.1" 200 OK`),true);
 for(const value of ['INFO: "GET /health HTTP/1.1" 503 Unavailable','ERROR: health check /health failed','ERROR: \"GET /health HTTP/1.1\" 200 unexpected','INFO: "POST /v1/chat/completions HTTP/1.1" 200 OK','INFO: "GET /history/abc HTTP/1.1" 200 OK','Avg generation throughput: 42 tokens/s','100%|████| 30/30'])assert.equal(successfulProbe(value),false);
});
test('probe flood cannot evict retained engine output, and raw mode remains available',()=>{
 const b=new EngineLogBuffer();b.ingest(line(0,'model loaded')+'\n'+line(1,'"POST /generate HTTP/1.1" 200 OK'));
 b.ingest(Array.from({length:2000},(_,i)=>`2026-10-16T05:31:00.${String(i).padStart(9,'0')}Z INFO: "GET /health HTTP/1.1" 200 OK`).join('\n'));
 assert.match(b.output(),/model loaded/);assert.match(b.output(),/POST \/generate/);assert.doesNotMatch(b.output(),/GET \/health/);
 assert.match(b.output({includeProbes:true}),/GET \/health/);assert.equal(b.suppressed,2000);assert.equal(b.raw.length,1000);
 b.ingest('2026-10-16T05:32:00.000000000Z ERROR: "GET /health HTTP/1.1" 500 Internal Server Error');assert.match(b.output(),/500 Internal Server Error/);
});
test('inclusive cursor overlap preserves new duplicate lines without replaying previous output',()=>{
 const b=new EngineLogBuffer(),first=line(0,'step'),second=line(1,'step');b.ingest(first+'\n'+first);
 b.ingest(first+'\n'+first+'\n'+first+'\n'+second);
 assert.deepEqual(b.runtime,[first,first,first,second]);b.ingest(second);assert.equal(b.runtime.length,4);
});
test('runtime retention is bounded and an empty probe-only view stays empty',()=>{
 const b=new EngineLogBuffer();b.ingest(line(0,'"GET /health HTTP/1.1" 200 OK'));assert.equal(b.output(),'');
 b.ingest(Array.from({length:1000},(_,i)=>'message '+i).join('\n'));assert.equal(b.runtime.length,500);
 b.ingest('x'.repeat(2*1024*1024));assert.ok(b.output().length<=1024*1024);
});
