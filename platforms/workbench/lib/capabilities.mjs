// Capabilities are the public contract, independent of which engine serves them. Engines join a
// capability by declaring it on a model in engine.json; their adapter adds the parameters only
// that model accepts. Clients see one tool per group (image, video, audio); each capability keeps
// its own strict schema for validation.
import {ID,choice,object,CAPABILITIES,TOOL_GROUPS,COMMON_TOOLS,validateSchema,resolveCapability} from './media-tools.mjs';
export {ID,CAPABILITIES,TOOL_GROUPS,COMMON_TOOLS,capabilityForTool,capabilityForSync,resolveCapability,isGenerationTool,validateToolInput} from './media-tools.mjs';
import {registry} from './registry.mjs';
import {runtimeFor,runtimeTopology} from './runtime-topology.mjs';
export {runtimeTopology};
async function adapterFor(model){return registry.adapter(model.engine);}
// Parameters a model accepts beyond the capability's base ones.
async function paramsOf(model,capability){return (await adapterFor(model))?.params?.[capability]?.(model)??{};}
// Expert parameters an adapter keeps out of the tool list (the gateway still validates them).
async function advancedOf(model,capability){return new Set((await adapterFor(model))?.advanced?.[capability]??[]);}
// Collapsed form of an advanced object: no fields listed, so clients pay for one line, not the tree.
function collapse(key,schema,models){
  const text=schema.description?.replace(/[。.]$/,''),what=text?text+(/[\u4e00-\u9fff]$/.test(text)?'。':'. '):'';
  return {type:'object',description:what+'Advanced, optional; omit for the defaults. Fields: list_media_models {"model":"'+models.join('" / "')+'"}.'};
}

// Media models (chat models are listed by /v1/models), each with its extra parameters.
export async function mediaModels(){
  const rows=[];
  for(const model of registry.models().filter(m=>m.capabilities.some(c=>CAPABILITIES[c]))){
    const capabilities=model.capabilities.filter(c=>CAPABILITIES[c]),parameters={},parameter_schemas={};
    for(const c of capabilities){const key=CAPABILITIES[c].group+(CAPABILITIES[c].task?'#'+CAPABILITIES[c].task:''),params=await paramsOf(model,c);parameters[key]=Object.keys(params);parameter_schemas[key]=params;}
    rows.push({id:model.id,engine:model.engine,kind:model.kind,...model.info,capabilities,parameters,parameter_schemas,
      ...((await adapterFor(model))?.describe?.(model)??{}),execution_runtime:runtimeFor(model.engine)});
  }
  return rows;
}
export function routes(){
  return Object.entries(CAPABILITIES).map(([capability,c])=>({...registry.routing(capability),tool:c.group,task:c.task,label:c.label,kind:c.kind,sync:c.sync??null})).filter(r=>r.providers.length);
}
// The strict schema of one capability: its base fields, every enabled model's parameters and model.
export async function capabilityTool(capability){
  const c=CAPABILITIES[capability],route=registry.routing(capability),properties={...c.base},notes=[],advanced=new Map();
  for(const modelId of [route.primary,...route.fallbacks,...route.providers.filter(p=>p!==route.primary&&!route.fallbacks.includes(p))]){
    const model=registry.model(modelId),params=await paramsOf(model,capability);
    for(const [key,schema] of Object.entries(params))properties[key]??=schema;
    for(const key of await advancedOf(model,capability))advanced.set(key,[...(advanced.get(key)??[]),modelId]);
    const note=(await adapterFor(model))?.notes?.[capability]?.(model);
    notes.push(modelId+(modelId===route.primary?' (primary)':'')+(Object.keys(params).length?': '+Object.keys(params).join(', '):'')+(note?' — '+note:''));
  }
  properties.model={...choice(['auto',...route.providers],'auto'),description:'auto uses the primary model and, if it cannot start, the fallbacks in order. Naming a model pins it and disables fallback.'};
  return {name:c.tool,description:c.description+'. Models: '+notes.join('; ')+'.',inputSchema:object(properties,c.required),example:c.example,capability,notes,advanced};
}
// A group tool merges its enabled capabilities: the union of their fields, the fields all of them
// require, and task to choose between them.
async function groupTool(group,enabled){
  const members=[];for(const capability of enabled)members.push({capability,c:CAPABILITIES[capability],tool:await capabilityTool(capability)});
  const properties={},models=new Set();
  for(const {tool} of members)for(const [key,schema] of Object.entries(tool.inputSchema.properties))if(key!=='model')properties[key]??=tool.advanced.has(key)?collapse(key,schema,tool.advanced.get(key)):schema;
  for(const {tool} of members)for(const id of tool.inputSchema.properties.model.enum)models.add(id);
  if(members.length>1)properties.task={...choice(members.map(m=>m.c.task)),description:members.map(m=>m.c.task+': '+m.c.description).join('; ')+(members.some(m=>m.c.infer)?'. Omitted: inferred from the inputs.':'. Omitted: '+members[0].c.task+'.')};
  properties.model={...choice([...models],'auto'),description:'auto uses the primary model of the task and, if it cannot start, the fallbacks in order. Naming a model pins it and disables fallback.'};
  const required=members.map(m=>m.tool.inputSchema.required).reduce((a,b)=>a.filter(k=>b.includes(k)));
  const lines=members.map(m=>(members.length>1?'['+m.c.task+'] ':'')+m.c.description+' — '+m.tool.notes.join('; '));
  return {name:group,description:TOOL_GROUPS[group].description+' '+lines.join(' | '),inputSchema:object(properties,required),example:members[0].c.example};
}
export async function tools(){
  const enabled=new Set(routes().map(r=>r.capability)),generated=[];
  for(const group of Object.keys(TOOL_GROUPS)){const members=Object.keys(CAPABILITIES).filter(c=>CAPABILITIES[c].group===group&&enabled.has(c));if(members.length)generated.push(await groupTool(group,members));}
  // Keep the catalog order stable: generation tools first, then directory, jobs and artifacts.
  return [...generated,...COMMON_TOOLS];
}
// The MCP view: sync-API-only facts stay out; full parameter schemas are given per model on request.
export async function catalog(){return {...ID,tools:await tools(),models:(await mediaModels()).map(({sync_api,...model})=>model),capabilities:routes().map(({sync,...route})=>route),workflows:await workflows()};}
export async function workflows(){
  const rows=[];for(const model of registry.models())rows.push(...((await adapterFor(model))?.workflows??[]));return rows;
}

// Strict validation of a generation call: resolve the capability, then check its own schema.
// Returns the capability and the arguments without the task selector.
export async function validateGeneration(name,input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Object.assign(new Error('arguments must be an object'),{status:400});
  const capability=resolveCapability(name,input);
  if(!capability)throw Object.assign(new Error(input.task!==undefined?'Unknown task '+input.task+' for '+name:'Unknown media tool: '+name),{status:400});
  if(!registry.routing(capability).providers.length)throw Object.assign(new Error('No enabled engine provides '+capability),{status:404,code:'CAPABILITY_UNAVAILABLE'});
  const {task,...args}=input;
  validateSchema((await capabilityTool(capability)).inputSchema,args);
  return {capability,args};
}

// Models that can serve this request, in the order they should be tried. Extra parameters narrow
// the chain to models that accept them; a pinned model is the only candidate. Synchronous API
// bodies keep each engine's own wire format, so only the adapter checks them.
export async function candidates(capability,input,{assets,artifact,sync=false}={}){
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
      (sync?adapter?.syncValidate??adapter?.validate:adapter?.validate)?.call(adapter,capability,input,{model,assets,artifact});accepted.push(model);
    }catch(e){reason??=e;if(pinned)throw Object.assign(e,{status:e.status??400});}
  }
  if(!accepted.length)throw Object.assign(reason??new Error('No model accepts this request'),{status:reason?.status??400});
  return {route,models:accepted,pinned};
}
