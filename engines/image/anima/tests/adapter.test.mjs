import test from 'node:test';
import assert from 'node:assert/strict';
import adapter,{buildAnimaGraph} from '../adapter.mjs';
import {workflowGraph} from '../../../shared/comfyui/client.mjs';

test('text graphs keep the cataloged loaders and fill prompt, size, seed and a preview output',async()=>{
  const turbo=await buildAnimaGraph('image.generate',{prompt:'1girl, cloak',seed:7,aspect_ratio:'16:9',negative_prompt:'blurry'});
  const template=await workflowGraph('anima-turbo-text');
  for(const node of ['1','2','3'])assert.deepEqual(turbo[node],template[node]);
  assert.equal(turbo['4'].inputs.text,'masterpiece, best quality, score_7, safe, 1girl, cloak');
  assert.equal(turbo['5'].inputs.text,'blurry');
  assert.deepEqual([turbo['6'].inputs.width,turbo['6'].inputs.height],[1344,768]);
  assert.equal(turbo['7'].inputs.seed,7);assert.equal(turbo['7'].inputs.steps,10);
  assert.deepEqual(turbo['9'],{class_type:'PreviewImage',inputs:{images:template['9'].inputs.images}});
  const aesthetic=await buildAnimaGraph('image.generate',{prompt:'sky',quality:'aesthetic'});
  assert.match(aesthetic['1'].inputs.unet_name,/aesthetic/);assert.equal(aesthetic['7'].inputs.cfg,4);
  // Aesthetic is tuned without score_* tags and keeps the template negative prompt by default.
  assert.doesNotMatch(aesthetic['4'].inputs.text,/score_/);assert.equal(aesthetic['5'].inputs.text,(await workflowGraph('anima-aesthetic-text'))['5'].inputs.text);
  await assert.rejects(buildAnimaGraph('image.generate',{prompt:'x',aspect_ratio:'2:1'}),/aspect_ratio/);
});

test('an edit uploads its one reference into the image graph; Aesthetic swaps model and sampler',async()=>{
  const uploads=[],uploadImage=async raw=>{uploads.push(raw.toString());return 'ref.png';};
  const d={prompt:'flat colors',images_b64:[Buffer.from('png').toString('base64')],strength:0.4,quality:'aesthetic'};
  const graph=await buildAnimaGraph('image.edit',d,{uploadImage});
  assert.deepEqual(uploads,['png']);assert.equal(graph['10'].inputs.image,'ref.png');
  assert.equal(graph['7'].inputs.denoise,0.4);assert.deepEqual(graph['7'].inputs.latent_image,['12',0]);
  assert.match(graph['1'].inputs.unet_name,/aesthetic/);assert.equal(graph['7'].inputs.steps,30);assert.equal(graph['7'].inputs.sampler_name,'er_sde');
});

test('edits take exactly one reference and the payload matches the synchronous body',async()=>{
  assert.throws(()=>adapter.validate('image.edit',{reference_asset_ids:['a','b']}),/exactly one/);
  adapter.validate('image.edit',{reference_asset_ids:['a']});adapter.validate('image.generate',{});
  const payload=await adapter.payload('image.edit',{prompt:'p',reference_asset_ids:['a'],strength:0.5},{bytes:async()=>Buffer.from('img')});
  assert.deepEqual(payload,{prompt:'p',seed:42,quality:'turbo',strength:0.5,images_b64:[Buffer.from('img').toString('base64')]});
  assert.deepEqual(adapter.effective('image.generate',{aspect_ratio:'3:4'}),{quality:'turbo',seed:42,mode:'text-to-image',size:'896x1152'});
});

test('execution returns the preview PNG and reports the prompt before waiting',async t=>{
  const events=[],previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});
  globalThis.fetch=async(url,options)=>{
    const path=new URL(url).pathname;events.push(path);
    if(path==='/prompt')return Response.json({prompt_id:'p1'});
    if(path==='/history/p1')return Response.json({p1:{status:{status_str:'success'},outputs:{9:{images:[{filename:'a.png',subfolder:'',type:'temp'}]}}}});
    if(path==='/view')return new Response(Buffer.from('image-bytes'));
    throw new Error('unexpected '+path);
  };
  const submitted=[];
  const result=await adapter.execute('image.generate',{prompt:'cup'},{base:'http://127.0.0.1:8188',onSubmitted:async b=>submitted.push(b.prompt_id)});
  assert.deepEqual(submitted,['p1']);assert.deepEqual(events,['/prompt','/history/p1','/view']);
  assert.equal(Buffer.from(result.data[0].b64_json,'base64').toString(),'image-bytes');assert.equal(result.metrics.prompt_id,'p1');
});
