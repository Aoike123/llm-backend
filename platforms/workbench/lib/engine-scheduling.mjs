// Batching policy for the single GPU queue. Turns count actual GPU grants,
// starting after ensure() completes, so cold loading does not consume a turn.
// Batches are per runtime, not per engine: engines sharing one process (H3 and Anima on ComfyUI,
// the audio.cpp engines) switch without a restart, so their requests reuse the loaded runtime
// together and only a different runtime has to wait for its turn.
export class EngineScheduling {
  constructor({minBatchRequests=2,maxBatchRequests=4,maxBatchSeconds=120,maxWaitSeconds=300}={},{groupOf=engine=>engine}={}) {
    for(const [name,value] of Object.entries({minBatchRequests,maxBatchRequests,maxBatchSeconds,maxWaitSeconds})) {
      if(!Number.isInteger(value)||value<1)throw new Error(`Invalid engine scheduling ${name}`);
    }
    if(minBatchRequests>maxBatchRequests)throw new Error('minBatchRequests exceeds maxBatchRequests');
    this.policy={minBatchRequests,maxBatchRequests,maxBatchSeconds,maxWaitSeconds};
    this.turn=null;this.groupOf=groupOf;
  }
  group(engine){return engine==null?null:this.groupOf(engine)??engine;}
  granted(engine,now) {
    const runtime=this.group(engine);
    if(this.turn?.runtime!==runtime)this.turn={runtime,engine,startedAt:now,requests:0};
    this.turn.engine=engine;this.turn.requests++;
  }
  choose(requests,current,now) {
    if(!requests.length)return {request:null,reason:'empty'};
    const ordered=[...requests].sort((a,b)=>a.enqueuedAt-b.enqueuedAt);
    // Requests for any engine on the loaded runtime count as reuse, oldest first.
    const runtime=this.group(current),same=ordered.find(job=>this.group(job.engine)===runtime),other=ordered.find(job=>this.group(job.engine)!==runtime);
    if(!same)return {request:ordered[0],reason:'oldest_waiting_engine'};
    if(!other)return {request:same,reason:'reuse_only_waiting_engine'};
    const turn=this.turn?.runtime===runtime?this.turn:null,p=this.policy;
    if(turn&&now-turn.startedAt>=p.maxBatchSeconds)return {request:other,reason:'batch_time_limit'};
    // Finish a small batch even when old queues are already aged; otherwise
    // multiple aged engines would alternate after every single request.
    if((turn?.requests??0)<p.minBatchRequests)return {request:same,reason:'minimum_engine_batch'};
    if(turn.requests>=p.maxBatchRequests)return {request:other,reason:'batch_request_limit'};
    if(now-other.enqueuedAt>=p.maxWaitSeconds)return {request:other,reason:'waiting_engine_aged'};
    return {request:same,reason:'reuse_loaded_engine'};
  }
  status(requests,current,now) {
    const decision=this.choose(requests,current,now);
    return {policy:this.policy,turn:this.turn?{runtime:this.turn.runtime,engine:this.turn.engine,requests:this.turn.requests,elapsed_seconds:Math.max(0,now-this.turn.startedAt)}:null,
      next_engine:decision.request?.engine??null,next_runtime:this.group(decision.request?.engine),reason:decision.reason,
      waiting_by_engine:Object.fromEntries([...new Set(requests.map(job=>job.engine))].map(engine=>[engine,requests.filter(job=>job.engine===engine).length]))};
  }
}
