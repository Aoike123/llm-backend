// FLUX.2 klein: two implementations (Paiton :7861, Stock Diffusers :7862) behind one engine.
// A request picks one; the other is unloaded first so both never hold VRAM.
import {call,choice,answered,beforeSubmission} from '../../../platforms/workbench/lib/engine-sdk.mjs';
const PORTS={Paiton:7861,'Stock (Diffusers)':7862};
const CONTAINERS={'paiton-flux2-paiton-1':'Paiton','paiton-flux2-stock-1':'Diffusers'};
const healthy=async()=>(await Promise.all(Object.values(PORTS).map(p=>call('http://127.0.0.1:'+p,'/health')))).every(r=>r.ready===true);
export default {
  idle:healthy,
  ready:healthy,
  logContainers(ctx,rows){
    const active=Object.keys(CONTAINERS).filter(name=>rows.includes(name));
    const names=active.map(name=>CONTAINERS[name]);
    return {containers:active.length?active:[ctx.runtime.container],label:names.length?'FLUX / '+names.join(' + '):'FLUX / Paiton'};
  },
  params:{'image.generate':()=>({engine:choice(['paiton','stock'])})},
  payload(capability,input){return {prompt:input.prompt,seed:input.seed??42,engine:(input.engine??'paiton')==='paiton'?'Paiton':'Stock (Diffusers)'};},
  async execute(capability,d){
    const engine=d.engine??'Paiton',port=PORTS[engine];
    await beforeSubmission(async()=>{if(!port)throw new Error('Invalid FLUX engine');await call('http://127.0.0.1:'+(port===7861?7862:7861),'/unload',{});});
    const result=await answered(()=>call('http://127.0.0.1:'+port,'/generate',{prompt:d.prompt,seed:d.seed??42},1800000)),image=result.image;delete result.image;
    return {data:[{b64_json:image}],metrics:result};
  },
};
