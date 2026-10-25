import test from 'node:test';
import assert from 'node:assert/strict';
import {Backend} from '../lib/backend.mjs';
import {runtimeFor,runtimeTopology,sameRuntime} from '../lib/runtime-topology.mjs';
import {MODELS} from '../../mcp/manifest.mjs';

test('H3 is the only Comfy runtime and Wan is unavailable',async()=>{
 const backend=new Backend();backend.rows=async()=>['paiton-h3-comfyui-1'];
 assert.deepEqual(await backend.running(),['h3']);assert.equal(runtimeFor('wan'),null);
 assert.equal(sameRuntime('h3','flux'),false);assert.equal(backend.models.h3[1],8188);
 assert.equal(backend.models.wan,undefined);assert.equal(MODELS.some(m=>m.id==='wan22'),false);
});

test('both video readiness and idle checks use the unified port and protect pending native work',async()=>{
  const backend=new Backend();backend.rows=async()=>['paiton-h3-comfyui-1'];
  const previous=globalThis.fetch;let pending=true;
  globalThis.fetch=async url=>{
    assert.equal(new URL(url).port,'8188');
    return {ok:true,text:async()=>JSON.stringify(String(url).endsWith('/queue')?{queue_running:[],queue_pending:pending?[[1,'native-prompt']]:[]}:{system:{}})};
  };
  try{for(const model of ['h3']){assert.equal(await backend.ready(model),true);assert.equal(await backend.idle(model),false);}pending=false;assert.equal(await backend.idle('h3'),true);}
  finally{globalThis.fetch=previous;}
});

test('discovery describes capabilities without claiming a loaded model; live topology reports H3',()=>{
  const catalog=runtimeTopology();assert.equal(catalog.capabilities_only,true);assert.equal(catalog.current_runtime,null);
  for(const model of MODELS)assert.equal(model.execution_runtime,runtimeFor(model.engine));
  const live=runtimeTopology({current:'h3',leased:false,queued:0,switching:false});
  assert.equal(live.capabilities_only,false);assert.equal(live.current_runtime,'comfy');assert.equal(live.current_engine,'h3');
  assert.match(live.native_queue,/ComfyUI/);
});
