// Capabilities are the public contract: one MCP tool and one job/sync route each, independent of
// which engine serves them. Engines join a capability by declaring it on a model in engine.json;
// their adapter adds the parameters only that model accepts.
import {ID,choice,object,CAPABILITIES,COMMON_TOOLS,validateToolInput} from './media-tools.mjs';
export {ID,CAPABILITIES,COMMON_TOOLS,capabilityForTool,capabilityForSync,validateToolInput} from './media-tools.mjs';
import {registry} from './registry.mjs';
import {runtimeFor,runtimeTopology} from './runtime-topology.mjs';
export {runtimeTopology};
async function adapterFor(model){return registry.adapter(model.engine);}
// Parameters a model accepts beyond the capability's base ones.
async function paramsOf(model,capability){return (await adapterFor(model))?.params?.[capability]?.(model)??{};}

// Media models (chat models are listed by /v1/models), each with its extra parameters.
export async function mediaModels(){
  const rows=[];
  for(const model of registry.models().filter(m=>m.capabilities.some(c=>CAPABILITIES[c]))){
    const capabilities=model.capabilities.filter(c=>CAPABILITIES[c]),parameters={};
    for(const c of capabilities)parameters[CAPABILITIES[c].tool]=Object.keys(await paramsOf(model,c));
    rows.push({id:model.id,engine:model.engine,kind:model.kind,...model.info,capabilities,parameters,
      ...((await adapterFor(model))?.describe?.(model)??{}),execution_runtime:runtimeFor(model.engine)});
  }
  return rows;
}
export function routes(){
  return Object.entries(CAPABILITIES).map(([capability,c])=>({...registry.routing(capability),tool:c.tool,label:c.label,kind:c.kind,sync:c.sync??null})).filter(r=>r.providers.length);
}
async function toolFor(capability){
  const c=CAPABILITIES[capability],route=registry.routing(capability),properties={...c.base},notes=[];
  for(const modelId of [route.primary,...route.fallbacks,...route.providers.filter(p=>p!==route.primary&&!route.fallbacks.includes(p))]){
    const model=registry.model(modelId),params=await paramsOf(model,capability);
    for(const [key,schema] of Object.entries(params))properties[key]??=schema;
    const note=(await adapterFor(model))?.notes?.[capability]?.(model);
    notes.push(modelId+(modelId===route.primary?' (primary)':'')+(Object.keys(params).length?': '+Object.keys(params).join(', '):'')+(note?' — '+note:''));
  }
  properties.model={...choice(['auto',...route.providers],'auto'),description:'auto uses the primary model and, if it cannot start, the fallbacks in order. Naming a model pins it and disables fallback.'};
  return {name:c.tool,description:c.description+' Models: '+notes.join('; ')+'.',inputSchema:object(properties,c.required),example:c.example,capability};
}
export async function tools(){
  const generated=[];for(const route of routes())generated.push(await toolFor(route.capability));
  // Keep the catalog order stable: generation tools first, then directory, jobs and artifacts.
  return [...generated,...COMMON_TOOLS];
}
export async function catalog(){return {...ID,tools:await tools(),models:await mediaModels(),capabilities:routes(),workflows:await workflows()};}
export async function workflows(){
  const rows=[];for(const model of registry.models())rows.push(...((await adapterFor(model))?.workflows??[]));return rows;
}

export async function validateInput(name,input){return validateToolInput(await tools(),name,input);}

// Models that can serve this request, in the order they should be tried. Extra parameters narrow
// the chain to models that accept them; a pinned model is the only candidate. Synchronous API
// bodies keep each engine's own wire format, so only the adapter checks them.
export async function candidates(capability,input,{assets,sync=false}={}){
  const route=registry.routing(capability);if(!route.providers.length)throw Object.assign(new Error('No enabled engine provides '+capability),{status:404,code:'CAPABILITY_UNAVAILABLE'});
  const pinned=input.model&&input.model!=='auto';
  if(pinned&&!route.providers.includes(input.model))throw Object.assign(new Error(input.model+' does not provide '+capability+' or is disabled'),{status:400});
  const chain=pinned?[input.model]:[route.primary,...route.fallbacks];
  const base=new Set([...Object.keys(CAPABILITIES[capability].base),'model']),accepted=[];let reason=null;
  for(const modelId of chain){
    const model=registry.model(modelId),adapter=await adapterFor(model),params=await paramsOf(model,capability);
    const extra=sync?[]:Object.keys(input).filter(k=>!base.has(k)&&!Object.hasOwn(params,k));
    try{
      if(extra.length)throw new Error(modelId+' does not accept '+extra.join(', '));
      (sync?adapter?.syncValidate??adapter?.validate:adapter?.validate)?.call(adapter,capability,input,{model,assets});accepted.push(model);
    }catch(e){reason??=e;if(pinned)throw Object.assign(e,{status:e.status??400});}
  }
  if(!accepted.length)throw Object.assign(reason??new Error('No model accepts this request'),{status:reason?.status??400});
  return {route,models:accepted,pinned};
}
