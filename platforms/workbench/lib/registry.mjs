// Engine packages are the single source of truth: every engines/<category>/<id>/engine.json
// with a `platform` block registers one scheduler engine, its runtime, console card and the
// models it serves. Enabled flags and capability routing are operator state, kept outside git.
import {readFileSync,readdirSync,existsSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
export const PLATFORM=JSON.parse(readFileSync(ROOT+'platforms/platform.json','utf8'));
const CATEGORY_TYPE={llm:'language',image:'image',video:'video',audio:'audio'};
const CATEGORY_ORDER=Object.keys(CATEGORY_TYPE);

function fail(path,message){throw new Error(path+': '+message);}
function readManifests(enginesDir){
  const packages=[];
  for(const category of readdirSync(enginesDir,{withFileTypes:true})){
    if(!category.isDirectory())continue;
    for(const entry of readdirSync(join(enginesDir,category.name),{withFileTypes:true})){
      const file=join(enginesDir,category.name,entry.name,'engine.json');
      if(!entry.isDirectory()||!existsSync(file))continue;
      const manifest=JSON.parse(readFileSync(file,'utf8'));
      if(manifest.platform)packages.push({id:manifest.deployment_id??entry.name,dir:dirname(file),file,manifest});
    }
  }
  return packages.sort((a,b)=>a.id.localeCompare(b.id));
}
export function validatePackage(pkg){
  const p=pkg.manifest.platform,where=pkg.file;
  for(const key of ['engine','runtime','ui','models'])if(p[key]===undefined)fail(where,'platform.'+key+' is required');
  if(!/^[a-z0-9-]+$/.test(p.engine))fail(where,'platform.engine must be lowercase letters, digits or -');
  for(const key of ['id','name','port','container','launch'])if(p.runtime[key]===undefined)fail(where,'platform.runtime.'+key+' is required');
  if(!Number.isInteger(p.runtime.port))fail(where,'platform.runtime.port must be an integer');
  if(!Array.isArray(p.runtime.launch)||!p.runtime.launch.length)fail(where,'platform.runtime.launch must be a non-empty array');
  for(const key of ['name','description','symbol','accent','panel'])if(p.ui[key]===undefined)fail(where,'platform.ui.'+key+' is required');
  if(!CATEGORY_TYPE[pkg.manifest.category])fail(where,'category must be one of '+Object.keys(CATEGORY_TYPE).join(', '));
  for(const model of p.models){
    if(!/^[a-z0-9.-]+$/.test(model.id??''))fail(where,'model id is invalid');
    if(!Array.isArray(model.capabilities)||!model.capabilities.length)fail(where,model.id+' declares no capabilities');
  }
}

export class Registry{
  // Under `node --test` the operator's state file is neither read nor written: tests see the
  // manifest defaults whatever engines are switched on in this workbench.
  constructor({enginesDir=ROOT+'engines',statePath=process.env.WORKBENCH_PLATFORM_STATE??(process.env.NODE_TEST_CONTEXT?null:ROOT+PLATFORM.state_file)}={}){
    this.enginesDir=enginesDir;this.statePath=statePath;this.adapters=new Map();this.listeners=new Set();this.load();
  }
  readState(){return this.statePath&&existsSync(this.statePath)?JSON.parse(readFileSync(this.statePath,'utf8')):{};}
  // Validates manifests against a candidate state; this.state changes only if it is consistent.
  load(state=this.readState()){
    const packages=readManifests(this.enginesDir);packages.forEach(validatePackage);
    state={engines:state.engines??{},routing:state.routing??{}};
    for(const pkg of packages)pkg.enabled=state.engines[pkg.id]?.enabled??pkg.manifest.platform.default_enabled===true;
    // Conflicts only matter between engines that can run together.
    const seen={engine:new Map(),model:new Map(),port:new Map()};
    for(const pkg of packages.filter(p=>p.enabled)){
      const p=pkg.manifest.platform,claim=(kind,key,owner)=>{const other=seen[kind].get(key);if(other&&other!==owner)fail(pkg.file,kind+' '+key+' is already declared by '+other);seen[kind].set(key,owner);};
      claim('engine',p.engine,pkg.id);for(const model of p.models)claim('model',model.id,pkg.id);claim('port',p.runtime.port,p.runtime.id);
    }
    this.packages=packages;this.state=state;
    for(const listener of this.listeners)listener(this);
    return this;
  }
  onChange(listener){this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
  // Adapters load on first use: they import gateway modules that import this registry.
  async adapterOf(pkg){
    if(!this.adapters.has(pkg.id)){
      const name=pkg.manifest.platform.adapter;if(!name)throw new Error(pkg.file+': platform.adapter is required');
      // A failed import is retried on next use, so fixing the file needs no gateway restart.
      this.adapters.set(pkg.id,import(pathToFileURL(join(pkg.dir,name)).href).then(m=>m.default,e=>{this.adapters.delete(pkg.id);throw e;}));
    }
    return this.adapters.get(pkg.id);
  }
  enabledPackages(){return this.packages.filter(p=>p.enabled);}
  package(id){return this.packages.find(p=>p.id===id)??null;}
  // Scheduler engine key -> package.
  engines(){return Object.fromEntries(this.enabledPackages().map(p=>[p.manifest.platform.engine,p]));}
  enginePackage(engine){return this.engines()[engine]??null;}
  async adapter(engine){const pkg=this.enginePackage(engine);return pkg?this.adapterOf(pkg):null;}
  runtimes(){
    const runtimes={};
    for(const pkg of this.enabledPackages()){
      const p=pkg.manifest.platform,{id,...runtime}=p.runtime;
      const row=runtimes[id]??={...runtime,engines:[]};row.engines.push(p.engine);
    }
    return runtimes;
  }
  // Public model rows, one per served model, in routing priority order.
  models(){
    return this.enabledPackages().flatMap(pkg=>pkg.manifest.platform.models.map(model=>({...model,engine:pkg.manifest.platform.engine,category:pkg.manifest.category,kind:CATEGORY_TYPE[pkg.manifest.category]==='language'?'text':CATEGORY_TYPE[pkg.manifest.category],package:pkg.id})))
      .sort((a,b)=>CATEGORY_ORDER.indexOf(a.category)-CATEGORY_ORDER.indexOf(b.category)||(a.priority??100)-(b.priority??100)||a.id.localeCompare(b.id));
  }
  model(id){return this.models().find(m=>m.id===id)??null;}
  capabilities(){return [...new Set(this.models().flatMap(m=>m.capabilities))];}
  // Primary first, then fallbacks, then any other enabled provider so a new engine is reachable
  // by name without being promoted. Disabled or missing names are skipped silently.
  routing(capability){
    const providers=this.models().filter(m=>m.capabilities.includes(capability)).map(m=>m.id);
    const saved=this.state.routing[capability]??{};
    const chain=[saved.primary,...(saved.fallbacks??[])].filter(id=>providers.includes(id));
    const primary=chain[0]??providers[0]??null;
    const fallbacks=saved.primary||saved.fallbacks?chain.slice(1):providers.slice(1);
    return {capability,primary,fallbacks:[...new Set(fallbacks)].filter(id=>id!==primary),providers,fallback_on_backend_error:saved.fallback_on_backend_error===true};
  }
  persist(){
    if(!this.statePath)return;
    mkdirSync(dirname(this.statePath),{recursive:true});
    const tmp=this.statePath+'.tmp';writeFileSync(tmp,JSON.stringify(this.state,null,2)+'\n',{mode:0o600});renameSync(tmp,this.statePath);
  }
  async setEnabled(id,enabled){
    const pkg=this.package(id);if(!pkg)throw Object.assign(new Error('Unknown engine package: '+id),{status:404});
    const previous=this.state;
    try{this.load({...previous,engines:{...previous.engines,[id]:{...previous.engines[id],enabled:!!enabled}}});if(enabled)await this.adapterOf(this.package(id));}
    catch(e){this.load(previous);throw Object.assign(e,{status:409});}
    this.persist();return this.package(id);
  }
  setRouting(capability,{primary,fallbacks=[],fallback_on_backend_error=false}){
    const {providers}=this.routing(capability);
    if(!providers.length)throw Object.assign(new Error('No enabled engine provides '+capability),{status:404});
    for(const id of [primary,...fallbacks])if(!providers.includes(id))throw Object.assign(new Error(id+' does not provide '+capability),{status:400});
    this.load({...this.state,routing:{...this.state.routing,[capability]:{primary,fallbacks:fallbacks.filter(id=>id!==primary),fallback_on_backend_error:!!fallback_on_backend_error}}});
    this.persist();return this.routing(capability);
  }
  // Console cards come straight from the manifests.
  services(){
    // Language first, then image, video and audio engines, as the console has always listed them.
    const ordered=[...this.enabledPackages()].sort((a,b)=>CATEGORY_ORDER.indexOf(a.manifest.category)-CATEGORY_ORDER.indexOf(b.manifest.category)||a.manifest.platform.ui.name.localeCompare(b.manifest.platform.ui.name));
    return ordered.map(pkg=>{
      const p=pkg.manifest.platform;
      return {id:p.engine,package:pkg.id,...p.ui,type:CATEGORY_TYPE[pkg.manifest.category],category:pkg.manifest.category,status:pkg.manifest.status??null,
        models:p.models.map(m=>({id:m.id,capabilities:m.capabilities})),runtime:p.runtime.id,port:p.runtime.port};
    });
  }
}

export const registry=new Registry();
