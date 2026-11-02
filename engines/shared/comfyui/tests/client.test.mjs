import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('an API result is moved out of the canvas with every file of its prompt; other canvas work stays',async t=>{
  const root=await mkdtemp(join(tmpdir(),'artifacts-'));t.after(()=>rm(root,{recursive:true,force:true}));
  process.env.MEDIA_ARTIFACTS_ROOT=root;t.after(()=>{delete process.env.MEDIA_ARTIFACTS_ROOT;});
  const {saveVideoOutput}=await import('../client.mjs');
  const api=join(root,'canvas/api');await mkdir(api,{recursive:true});
  for(const name of ['goldfish-abc_00001-audio.mp4','goldfish-abc_00001.mp4','goldfish-abc_00001.png','h3-other_00001_.mp4'])await writeFile(join(api,name),name);
  await writeFile(join(root,'canvas/YZ_H3__00001.mp4'),'canvas work');
  // VHS_VideoCombine lists only the mp4 with audio; the silent copy and preview are not in history.
  const entry={status:{status_str:'success'},outputs:{364:{gifs:[{filename:'goldfish-abc_00001-audio.mp4',subfolder:'api',type:'output'}]}}};
  const job=join(root,'videos/2026-11/job_x');
  const saved=await saveVideoOutput('http://unused',entry,job);
  assert.equal(saved.local_path,join(job,'output.mp4'));
  assert.equal(await readFile(saved.local_path,'utf8'),'goldfish-abc_00001-audio.mp4');
  assert.deepEqual((await readdir(api)).sort(),['h3-other_00001_.mp4']);
  assert.deepEqual(await readdir(join(root,'canvas')),['YZ_H3__00001.mp4','api'].sort());
});
