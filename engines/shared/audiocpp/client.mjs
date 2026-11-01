// Client for the shared audio.cpp runtime. The server reports no busy state, so the gateway counts
// the requests it has in flight; after a gateway restart it cannot know, and unloading every model
// (which waits for running inference) is the one reliable idle check.
import {call,answered} from '../../../platforms/workbench/lib/engine-sdk.mjs';
let inFlight=0,verified=false;
export async function ready(ctx){return (await call(ctx.base,'/health',undefined,5000)).status==='ok';}
export async function idle(ctx){
  if(inFlight>0)return false;
  if(!verified){await call(ctx.base,'/v1/tasks/unload_all_models',{},1800000);verified=true;}
  return true;
}
// One generic task. HTTP errors are final; a lost answer stays uncertain.
export async function runTask(base,model,request,timeout=1800000){
  inFlight++;
  try{return await answered(()=>call(base,'/v1/tasks/run',{model,request},timeout));}
  finally{inFlight--;}
}
