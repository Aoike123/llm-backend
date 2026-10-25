import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import React from 'react';
import {renderToString} from 'react-dom/server';
import {loadBindings,transform} from 'next/dist/build/swc/index.js';
import {servingPolicy,policyBudget,forecastBudget} from '../lib/llm.mjs';

test('panel renders while loading and shows deficits and unverified estimates without crashing',async()=>{
 await loadBindings();
 const source=await readFile(new URL('../app/mode-switch.jsx',import.meta.url),'utf8');
 const result=await transform(source,{filename:'mode-switch.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},
  transform:{react:{runtime:'automatic'}}},module:{type:'es6'}});
 const path=new URL(`../app/.panel-render-${process.pid}.mjs`,import.meta.url);
 try{
  await writeFile(path,result.code);
  const {default:Panel}=await import(path.href);
  const render=data=>renderToString(React.createElement(Panel,{data,onData:()=>{}}));
  assert.match(render(null),/布局待测/);
  const policy=servingPolicy('custom',65536,8),sample={block_bytes:14336000,blocks_per_request:103,gdn:'lazy',prefill_tokens:4096};
  const plan={version:2,context_tokens:65536,concurrency:8,eager:false,kv_budget_bytes:policy.kv_budget_bytes,
   matrix:{'65536:8:graph':sample}};
  const data={model:'llm',llm_mode:'loaded',llm_policy:policy,kv_budget:policyBudget(policy,393216),kv_forecast:plan,
   llm_engine:{kv_budget_bytes:policy.kv_budget_bytes},values:{}};
  const html=render(data);
  assert.match(html,/所选配置存在容量或预算缺口/);
  assert.match(html,/KV token 容量不足/);
  assert.doesNotMatch(html,/满载在显存内|满载显存余量与 token 容量都满足/);
  const enough={...plan,matrix:{'65536:8:graph':{...sample,blocks_per_request:60}}};
  assert.match(render({...data,kv_forecast:enough,kv_budget:policyBudget(policy,600000)}),/启动模型估算 · 满载未验证/);
  const enoughHtml=render({...data,kv_forecast:enough,kv_budget:policyBudget(policy,600000)});
  const preview=forecastBudget(policy,65536,8,policyBudget(policy,600000),enough,false,false,policy.kv_budget_bytes);
  const shown=/class="kv-remaining"[^>]*>([^<]+)/.exec(enoughHtml)[1];
  assert.equal(shown,'+'+(preview.usable_pool_margin_bytes/2**30).toFixed(2));
  assert.notEqual(shown,'+'+(preview.full_load_margin_bytes/2**30).toFixed(2));
  assert.match(enoughHtml,/满载可用余量|预算预留后显存余量/);

  assert.match(/class="kv-remaining"[^>]*>([^<]+)/.exec(html)[1],/^−/);
  const offline=render({...data,current_model:'h3',kv_forecast:null,kv_budget:policyBudget(policy,null),kv_preview_plan:{...enough,preview_only:true}});
  assert.match(offline,/历史布局估算 · 满载未验证/);
  assert.doesNotMatch(offline,/缺少布局|该配置布局待测/);
 }finally{await unlink(path).catch(()=>{});}
});
