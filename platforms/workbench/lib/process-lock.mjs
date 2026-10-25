import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {resolve} from 'node:path';

// Linux abstract sockets are atomic, have no filesystem entry, and are released
// by the kernel on exit (including SIGKILL). Never infer ownership from a PID.
export async function acquireProcessLock(path){
  const name='\0ai-workbench-'+createHash('sha256').update(resolve(path)).digest('hex');
  const server=createServer(socket=>socket.destroy());
  await new Promise((resolve,reject)=>{
    const onError=error=>{
      if(error.code==='EADDRINUSE')reject(new Error('Workbench already running',{cause:error}));
      else reject(error);
    };
    server.once('error',onError);
    server.listen(name,()=>{server.removeListener('error',onError);resolve();});
  });
  server.unref();
  let closing;
  return ()=>closing??=new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
