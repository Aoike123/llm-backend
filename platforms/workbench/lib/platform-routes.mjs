// Console management of engine packages and capability routing. Same-origin local console only.
import {relative} from 'node:path';
import {registry,ROOT} from './registry.mjs';
import {routes,CAPABILITIES} from './capabilities.mjs';
import {localManagement} from './mcp-routes.mjs';
import {send} from './http.mjs';
import {fail} from './media-store.mjs';
async function jsonBody(req,limit=8192){
  if(req.headers['content-type']?.split(';')[0]!=='application/json')throw fail('Use application/json',415);
  let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>limit)throw fail('Request too large',413);chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
}
export function packageRows(){
  return registry.packages.map(pkg=>{
    const m=pkg.manifest,p=m.platform;
    return {id:pkg.id,name:m.name,display_name:p.ui.name,version:p.ui.version??'',description:p.ui.description,category:m.category,status:m.status??null,
      enabled:pkg.enabled,engine:p.engine,symbol:p.ui.symbol,accent:p.ui.accent,path:relative(ROOT,pkg.dir),
      runtime:{id:p.runtime.id,port:p.runtime.port,container:p.runtime.container},
      models:p.models.map(model=>({id:model.id,capabilities:model.capabilities}))};
  });
}
export function platformRoutes(coordinator,lifecycle){
  // An engine in use keeps its lease, queue and loaded weights until that work is done.
  function assertIdle(engine){
    const s=coordinator.status();
    if(s.lease_model===engine||s.switching_target===engine||coordinator.queue.some(r=>r.engine===engine))throw fail('引擎正在使用或排队中，任务结束后再停用',409);
  }
  return async function platform(req,res){
    if(!localManagement(req))return send(res,403,{error:'Local same-origin console only'});
    const path=new URL(req.url,'http://localhost').pathname;
    try{
      if(req.method==='GET'&&path==='/api/platform')return send(res,200,{packages:packageRows(),capabilities:routes(),capability_labels:Object.fromEntries(Object.entries(CAPABILITIES).map(([id,c])=>[id,c.label]))});
      if(req.method!=='POST')return send(res,405,{error:'Method not allowed'});
      if(lifecycle.draining||process.env.WORKBENCH_READ_ONLY==='1')throw fail('Gateway is draining or read-only',503);
      const engine=/^\/api\/platform\/engines\/([A-Za-z0-9_.-]+)$/.exec(path);
      if(engine){
        const body=await jsonBody(req),pkg=registry.package(engine[1]);if(!pkg)throw fail('Unknown engine package',404);
        if(typeof body.enabled!=='boolean')throw fail('enabled must be boolean');
        const key=pkg.manifest.platform.engine;
        if(!body.enabled&&pkg.enabled){
          assertIdle(key);
          // A running container would keep its VRAM after leaving the scheduler's view.
          if((await coordinator.backend.running()).includes(key)){await coordinator.backend.stop(key);}
          if(coordinator.current===key)coordinator.current=null;
        }
        await registry.setEnabled(pkg.id,body.enabled);
        return send(res,200,{packages:packageRows(),capabilities:routes()});
      }
      const routing=/^\/api\/platform\/routing\/([a-z.]+)$/.exec(path);
      if(routing){
        const body=await jsonBody(req);
        if(typeof body.primary!=='string'||!Array.isArray(body.fallbacks)||body.fallbacks.some(id=>typeof id!=='string'))throw fail('primary and fallbacks are required');
        registry.setRouting(routing[1],{primary:body.primary,fallbacks:body.fallbacks,fallback_on_backend_error:body.fallback_on_backend_error===true});
        return send(res,200,{packages:packageRows(),capabilities:routes()});
      }
      return send(res,404,{error:'Unknown platform endpoint'});
    }catch(e){return send(res,e.status??400,{error:e.message});}
  };
}
