// Called after admission and the shared GPU lease. Never calls the gateway itself.
import {registry} from './registry.mjs';
export async function executeMedia(engine,d,{capability,...options}={}){
  const pkg=registry.enginePackage(engine),adapter=await registry.adapter(engine);
  if(!pkg||!adapter?.execute)throw Object.assign(new Error('Engine '+engine+' is not enabled for media'),{code:'NOT_SUBMITTED'});
  return adapter.execute(capability,d,{...options,engine,base:'http://127.0.0.1:'+pkg.manifest.platform.runtime.port,runtime:pkg.manifest.platform.runtime});
}
