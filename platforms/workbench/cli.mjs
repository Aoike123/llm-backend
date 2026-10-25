import {spawn,spawnSync} from 'node:child_process';
import {existsSync,openSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {ROOT,call,command} from './lib/backend.mjs';
import {pause} from './lib/core.mjs';
const here=fileURLToPath(new URL('.',import.meta.url)),data=ROOT+'workspace/data/scheduler/',unit='ai-workbench-gateway.service';
// next.config.mjs pins distDir so a build can be staged without disturbing the serving bundle.
const distDir=(await import('./next.config.mjs')).default.distDir;
const [action,model,...args]=process.argv.slice(2),base='http://127.0.0.1:18990';
const status=()=>call(base,'/status',undefined,3000);
async function idle(){const s=await status();if(s.leased||s.switching||s.queued)throw new Error('Active/queued work: wait before stopping workbench');}
async function waitReady(){for(let i=0;i<150;i++){try{console.log(JSON.stringify(await status(),null,2));return;}catch{await pause(200);}}throw new Error('Workbench startup timeout; inspect logs');}
async function main(){
  const managed=existsSync(homedir()+'/.config/systemd/user/'+unit);
  if(['start','stop','restart','logs'].includes(action)&&managed){
    if(action==='logs'){console.log(await command('journalctl',['--user','-u',unit,'-n','60','--no-pager']));return;}
    if(action!=='start'){try{await idle();}catch(e){if(!e.message.includes('fetch failed'))throw e;}}
    await command('systemctl',['--user',action,unit]);if(action!=='stop')await waitReady();return;
  }
  if(action==='status')console.log(JSON.stringify(await status(),null,2));
  else if(action==='logs')console.log(readFileSync(data+'server.log','utf8').slice(-6000));
  else if(action==='start'){
    try{console.log(JSON.stringify(await status()));return;}catch{}
    if(!existsSync(here+distDir+'/BUILD_ID'))throw new Error('Build first: cd platforms/workbench && npm ci && npm run build');
    mkdirSync(data,{recursive:true});const log=openSync(data+'server.log','a');const p=spawn(here+'launch.sh',[],{cwd:ROOT,detached:true,stdio:['ignore',log,log]});p.unref();writeFileSync(data+'server.pid',String(p.pid));await waitReady();
  }else if(action==='stop'){
    await idle();const pid=Number(readFileSync(data+'server.pid','utf8'));if(!readFileSync('/proc/'+pid+'/cmdline','utf8').includes(here+'server.mjs'))throw new Error('PID is not owned workbench');process.kill(pid,'SIGTERM');
    for(let i=0;i<300;i++){try{await status();}catch{return;}await pause(100);}throw new Error('Workbench shutdown timeout');
  }else if(action==='restart'){await command(process.execPath,[fileURLToPath(import.meta.url),'stop']);await command(process.execPath,[fileURLToPath(import.meta.url),'start']);}
  else if(['switch','run'].includes(action)){
    const ticket=await call(base,'/acquire',{model}),timer=setInterval(()=>call(base,'/renew',{token:ticket.token}).catch(()=>{}),30000);
    try{if(action==='switch')console.log('Ready:',model);else{const argv=args[0]==='--'?args.slice(1):args;if(!argv.length)throw new Error('Provide command after --');const result=await new Promise((resolve,reject)=>{const p=spawn(argv[0],argv.slice(1),{cwd:ROOT,stdio:'inherit'});p.on('error',reject);p.on('exit',resolve);});process.exitCode=result??1;}}
    finally{clearInterval(timer);try{await call(base,'/release',{token:ticket.token});}catch{}}
  }else throw new Error('Usage: ./lab scheduler start|stop|restart|status|logs|switch MODEL|run MODEL -- COMMAND');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
