import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {acquireProcessLock} from '../lib/process-lock.mjs';

async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'workbench-lock-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return join(dir,'node.lock');
}
test('live owner excludes a second starter and release is idempotent',async t=>{
  const path=await fixture(t),release=await acquireProcessLock(path);
  t.after(release);
  await assert.rejects(acquireProcessLock(path),/already running/);
  await release();await release();
  const recovered=await acquireProcessLock(path);await recovered();
});
test('legacy locks, PID reuse, corrupt files and EPERM cannot block startup',async t=>{
  const path=await fixture(t);
  t.mock.method(process,'kill',()=>{throw Object.assign(new Error('permission denied'),{code:'EPERM'});});
  for(const raw of [String(process.pid),JSON.stringify({pid:1,boot:'previous-boot',start:'1'}),'bad data','']){
    await writeFile(path,raw);
    const release=await acquireProcessLock(path);
    assert.equal(await readFile(path,'utf8'),raw);
    await release();
  }
});
test('simultaneous starters have exactly one owner',async t=>{
  const path=await fixture(t);
  const results=await Promise.allSettled(Array.from({length:20},()=>acquireProcessLock(path)));
  const owners=results.filter(r=>r.status==='fulfilled');
  for(const owner of owners)t.after(owner.value);
  assert.equal(owners.length,1);
  for(const result of results.filter(r=>r.status==='rejected'))assert.match(result.reason.message,/already running/);
});
test('different paths have independent locks',async t=>{
  const path=await fixture(t),a=await acquireProcessLock(path),b=await acquireProcessLock(path+'-other');
  t.after(a);t.after(b);
});
const moduleUrl=new URL('../lib/process-lock.mjs',import.meta.url).href;
async function childOwner(t,path){
  const child=spawn(process.execPath,['--input-type=module','-e',`
    import {acquireProcessLock} from ${JSON.stringify(moduleUrl)};
    await acquireProcessLock(process.argv[1]);
    console.log('locked');
    setInterval(()=>{},1000);
  `,path],{stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  let stderr='';child.stderr.on('data',data=>stderr+=data);
  await Promise.race([
    once(child.stdout,'data').then(([data])=>assert.match(data.toString(),/locked/)),
    once(child,'exit').then(([code,signal])=>{throw new Error(`Child exited: ${code}/${signal}: ${stderr}`);}),
  ]);
  return child;
}
for(const signal of ['SIGTERM','SIGKILL'])test(`kernel releases lock after owner receives ${signal}`,{timeout:10000},async t=>{
  const path=await fixture(t),child=await childOwner(t,path);
  await assert.rejects(acquireProcessLock(path),/already running/);
  const exited=once(child,'exit');child.kill(signal);await exited;
  const recovered=await acquireProcessLock(path);await recovered();
});
test('kernel releases lock on startup failure',async t=>{
  const path=await fixture(t);
  const child=spawn(process.execPath,['--input-type=module','-e',`
    import {acquireProcessLock} from ${JSON.stringify(moduleUrl)};
    await acquireProcessLock(process.argv[1]);
    throw new Error('simulated startup failure');
  `,path],{stdio:'ignore'});
  const [code]=await once(child,'exit');assert.equal(code,1);
  const release=await acquireProcessLock(path);await release();
});
