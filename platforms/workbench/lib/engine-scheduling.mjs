// One policy for API admission and GPU leases. Turns count actual GPU grants,
// starting after ensure() completes, so cold loading does not consume a turn.
export class EngineScheduling {
  constructor({minBatchRequests=2,maxBatchRequests=4,maxBatchSeconds=120,maxWaitSeconds=300}={}) {
    for(const [name,value] of Object.entries({minBatchRequests,maxBatchRequests,maxBatchSeconds,maxWaitSeconds})) {
      if(!Number.isInteger(value)||value<1)throw new Error(`Invalid engine scheduling ${name}`);
    }
    if(minBatchRequests>maxBatchRequests)throw new Error('minBatchRequests exceeds maxBatchRequests');
    this.policy={minBatchRequests,maxBatchRequests,maxBatchSeconds,maxWaitSeconds};
    this.turn=null;
  }
  granted(engine,now) {
    if(this.turn?.engine!==engine)this.turn={engine,startedAt:now,requests:0};
    this.turn.requests++;
  }
  choose(requests,current,now) {
    if(!requests.length)return {request:null,reason:'empty'};
    const ordered=[...requests].sort((a,b)=>a.enqueuedAt-b.enqueuedAt);
    const same=ordered.find(job=>job.engine===current),other=ordered.find(job=>job.engine!==current);
    if(!same)return {request:ordered[0],reason:'oldest_waiting_engine'};
    if(!other)return {request:same,reason:'reuse_only_waiting_engine'};
    const turn=this.turn?.engine===current?this.turn:null,p=this.policy;
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
    return {policy:this.policy,turn:this.turn?{engine:this.turn.engine,requests:this.turn.requests,elapsed_seconds:Math.max(0,now-this.turn.startedAt)}:null,
      next_engine:decision.request?.engine??null,reason:decision.reason,
      waiting_by_engine:Object.fromEntries([...new Set(requests.map(job=>job.engine))].map(engine=>[engine,requests.filter(job=>job.engine===engine).length]))};
  }
}
