import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
export class Metrics {
  workflows=new Map();
  workflow(event){
    const {id,model,phase}=event;
    if(!/^[a-f0-9-]{36}$/.test(id??'')||model!=='h3'||!['start','finish'].includes(phase))throw new Error('Invalid native workflow event');
    if(this.state.recent.some(r=>r.workflow_id===id))return;
    const current=this.workflows.get(id);
    if(current&&current!==model)throw new Error('Workflow model mismatch');
    if(phase==='start'){if(!current){this.workflows.set(id,model);this.start(model);}return;}
    const {seconds,queue_seconds,outcome,finished_at}=event;
    if(!['success','error'].includes(outcome)||!Number.isFinite(seconds)||seconds<0||!Number.isFinite(queue_seconds)||queue_seconds<0||queue_seconds>seconds||!Number.isFinite(finished_at)||finished_at<=0)throw new Error('Invalid native workflow timing');
    if(!current)this.start(model);
    this.finish(model,outcome,seconds,queue_seconds,{workflow_id:id,source:'comfyui-native',finished_at});
    this.workflows.delete(id);
  }
  constructor(path) {this.path=path;this.active={};this.state={totals:[],last_seconds:{},last_queue:{},recent:[]};if(path){try{const state=JSON.parse(readFileSync(path));if(Array.isArray(state.totals)&&Array.isArray(state.recent)&&state.last_seconds&&state.last_queue)this.state=state;}catch{}}}
  start(model){this.active[model]=(this.active[model]??0)+1;}
  finish(model,outcome,elapsed,queue,details={}){
    this.active[model]--;let row=this.state.totals.find(r=>r.model===model&&r.outcome===outcome);
    if(!row){row={model,outcome,count:0,seconds:0};this.state.totals.push(row);}row.count++;row.seconds+=elapsed;
    this.state.last_seconds[model]=elapsed;this.state.last_queue[model]=queue;this.state.recent.push({model,outcome,seconds:elapsed,queue_seconds:queue,finished_at:Date.now()/1000,...details});this.state.recent=this.state.recent.slice(-30);
    if(this.path){mkdirSync(dirname(this.path),{recursive:true});writeFileSync(this.path+'.tmp',JSON.stringify(this.state));renameSync(this.path+'.tmp',this.path);}
  }
  snapshot(){return {active:{...this.active},recent:[...this.state.recent]};}
  prometheus(coordinator){
    const s=coordinator.status(),lines=[],metric=(name,value,labels={})=>lines.push(name+(Object.keys(labels).length?'{'+Object.entries(labels).map(([k,v])=>k+'='+JSON.stringify(v)).join(',')+'}':'')+' '+value);
    metric('lab_scheduler_queued',s.queued);metric('lab_scheduler_active_leases',s.active_leases);metric('lab_scheduler_switching',Number(s.switching));
    for(const model of Object.keys(coordinator.backend.models))metric('lab_scheduler_current',Number(s.current===model),{model});
    for(const [model,n] of Object.entries(this.active))metric('lab_gateway_active_requests',n,{model});
    for(const {model,outcome,count,seconds} of this.state.totals){metric('lab_gateway_requests_total',count,{model,outcome});metric('lab_gateway_request_seconds_sum',seconds,{model,outcome});}
    for(const [model,n] of Object.entries(this.state.last_seconds))metric('lab_gateway_last_request_seconds',n,{model});
    for(const [model,n] of Object.entries(this.state.last_queue))metric('lab_gateway_last_queue_seconds',n,{model});
    for(const [model,n] of Object.entries(Object.fromEntries(this.state.recent.map(r=>[r.model,r.finished_at]))))metric('lab_gateway_last_completed_timestamp_seconds',n,{model});
    return lines.join('\n')+'\n';
  }
}
