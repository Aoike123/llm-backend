import {call} from './backend.mjs';
import {TOPOLOGY} from './runtime-topology.mjs';
// Read the whole native service; never inspect node types or load a workflow/model.
export async function comfyRuntime(request=call){
 const base='http://127.0.0.1:'+TOPOLOGY.runtimes.comfy.port;
 const [health,queue,history]=await Promise.allSettled(['/system_stats','/queue','/history?max_items=100'].map(path=>request(base,path,undefined,3000)));
 const queueAvailable=queue.status==='fulfilled',historyAvailable=history.status==='fulfilled';
 const rows=key=>queueAvailable?(queue.value[key]??[]).map(row=>({number:row[0],prompt_id:row[1]})):[];
 const recent=historyAvailable?Object.entries(history.value).map(([prompt_id,entry])=>{
  const messages=entry.status?.messages??[],start=messages.find(([type])=>type==='execution_start')?.[1]?.timestamp;
  const end=[...messages].reverse().find(([type])=>['execution_success','execution_error','execution_interrupted'].includes(type))?.[1]?.timestamp;
  return {prompt_id,number:entry.prompt?.[0]??null,state:entry.status?.status_str==='error'?'failed':entry.status?.completed?'succeeded':'unknown',finished_at:Number.isFinite(end)?end/1000:null,seconds:Number.isFinite(start)&&Number.isFinite(end)&&end>=start?(end-start)/1000:null};
 }).sort((a,b)=>(b.number??0)-(a.number??0)).slice(0,100):[];
 return {available:health.status==='fulfilled',queue_available:queueAvailable,history_available:historyAvailable,running:rows('queue_running'),pending:rows('queue_pending'),history:recent,history_limit:100,observed_at:new Date().toISOString()};
}
