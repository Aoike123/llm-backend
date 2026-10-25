'use client';
import {useEffect,useRef,useState} from 'react';
import {Icon,ActionButton} from './ui-controls.mjs';
import {forecastBudget,kvBudgetBytes,budgetStatus} from '../lib/llm.mjs';
const defaultPresets=[['long-single',256,1,'长上下文'],['long',192,2,'双路任务'],['custom',128,3,'均衡并发'],['custom',64,6,'多路任务'],['throughput',64,8,'八路并发']];
const count=n=>n.toLocaleString('zh-CN');
const gib=n=>Number.isFinite(n)&&n>0?(n/2**30).toLocaleString('zh-CN',{maximumFractionDigits:3})+' GiB':'待测';
export default function ModeSwitch({data,onData,onDraft,onApplying,onApplied}){
  const [presets,setPresets]=useState(defaultPresets),[activePreset,setActivePreset]=useState(-1),[presetsReady,setPresetsReady]=useState(false),[presetError,setPresetError]=useState('');
  const tabs=useRef(null),nameInput=useRef(null);
  const validPresets=rows=>Array.isArray(rows)&&rows.length>=1&&rows.length<=8&&rows.every(row=>Array.isArray(row)&&row.length===4&&Number.isInteger(row[1])&&row[1]>=1&&row[1]<=256&&Number.isInteger(row[2])&&row[2]>=1&&row[2]<=8&&typeof row[3]==='string'&&row[3].trim().length>0&&row[3].length<=16);
  useEffect(()=>{try{const saved=JSON.parse(localStorage.getItem('workbench.llm-presets.v1'));if(validPresets(saved))setPresets(saved);}catch{}setPresetsReady(true);},[]);
  useEffect(()=>{if(!presetsReady||!validPresets(presets))return;try{localStorage.setItem('workbench.llm-presets.v1',JSON.stringify(presets));setPresetError('');}catch{setPresetError('浏览器无法保存方案，请检查存储权限。');}},[presets,presetsReady]);
  const policy=data?.llm_policy;
  const [context,setContext]=useState(64),[lanes,setLanes]=useState(8),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [eager,setEager]=useState(false),[kvBytes,setKvBytes]=useState(kvBudgetBytes(65536));
  const [kvText,setKvText]=useState((kvBudgetBytes(65536)/2**30).toFixed(3));
  useEffect(()=>{setKvText(previous=>previous!==''&&Math.round(Number(previous)*2**30)===kvBytes?previous:kvBytes===''?'':(kvBytes/2**30).toFixed(3));},[kvBytes]);
  function editBudget(value){setKvText(value);setKvBytes(value===''?'':Math.round(Number(value)*2**30));setDirty(true);}
  const lock=useRef(false);
  const applying=busy||!!data?.pending_llm_mode;
  const actualKv=applying||data?.current_model!=='llm'?null:data?.llm_engine?.pool_allocated_bytes;
  const lastPlan=useRef(null);
  useEffect(()=>{if(data?.kv_forecast)lastPlan.current=data.kv_forecast;},[data?.kv_forecast]);
  const plan=data?.kv_forecast??lastPlan.current;
  useEffect(()=>{if(policy&&!dirty){setContext(policy.context_tokens/1024);setLanes(policy.concurrency);setEager(policy.eager??false);setKvBytes(policy.kv_budget_bytes??kvBudgetBytes(policy.context_tokens));}},[policy?.context_tokens,policy?.concurrency,policy?.eager,policy?.kv_budget_bytes,dirty]);
  const valid=Number.isInteger(context)&&context>=1&&context<=256&&Number.isInteger(lanes)&&lanes>=1&&lanes<=8&&Number.isSafeInteger(kvBytes)&&kvBytes>=2**30&&kvBytes<=32*2**30;
  const forecastFor=(c,n)=>forecastBudget(policy,c*1024,n,data?.kv_budget,plan,applying,eager,kvBytes,
    (data?.kv_budget?.capacity_tokens!=null&&c*1024===policy?.context_tokens&&n===policy?.concurrency&&!applying)?data?.llm_engine?.pool_allocated_bytes:undefined,
    {preview_plan:data?.kv_preview_plan,calibration:data?.kv_calibration,vram_total_bytes:data?.values?.vram_total,weights_bytes:data?.llm_engine?.weights_bytes,graph_capture_bytes:data?.llm_engine?.graph_capture_bytes});
  // 满载显存余量是主指标；token 容量是与它并列的独立约束。
  const budget=forecastFor(context,lanes);
  const capacity=budget.capacity_tokens??budget.estimated_capacity_tokens,demand=budget.demand_tokens;
  const vramMargin=budget.usable_pool_margin_bytes,requiredPool=budget.required_pool_bytes,feasiblePool=budget.feasible_pool_bytes;
  const capacityMargin=budget.capacity_margin_tokens??budget.estimated_capacity_margin_tokens;
  // 引擎会把 1K–256K × 1–8 路的布局全部规划出来，所以未启动的配置也有可判定的数字（标记为预计）。
  const historical=budget.preview_basis==='historical-layout';
  const isPlanned=budget.source==='planned'||budget.source==='historical-plan';
  const capacityLabel=isPlanned?'预计容量':'实测容量';
  const status=budgetStatus(budget),over=status==='exceeded';
  const tight=status==='tight'||status==='unverified';
  const presetForecast=(c,n)=>{const value=forecastFor(c,n),state=budgetStatus(value);
    if(value.shortfall_tokens>0)return `预计 KV 缺口 ${(value.shortfall_tokens/1024).toFixed(1)}K`;
    if(state==='exceeded')return '预计显存或预算不足';
    if(state==='unknown')return '布局待测';
    return value.full_load_verified?'满载已校准':'满载待验证';};
  const changed=!!policy&&(!data?.llm_mode&&data?.model==='llm'||context*1024!==policy.context_tokens||lanes!==policy.concurrency||eager!==(policy.eager??false)||kvBytes!==policy.kv_budget_bytes);
  const engine=data?.llm_engine;
  const applied=!applying&&data?.current_model==='llm'&&engine&&engine.context_tokens===context*1024&&engine.concurrency===lanes&&engine.eager===eager&&engine.kv_budget_bytes===kvBytes;
  const budgetColor=status==='unknown'?'#a0abc0':over?'#f08a8a':tight?'#efc47d':'#92dfd0';
  const headline=!valid?'请输入有效的额度':over?'所选配置存在容量或预算缺口':status==='unknown'?'该配置布局待测':status==='unverified'?(historical?'历史布局估算 · 满载未验证':'启动模型估算 · 满载未验证'):status==='tight'?'满载实测余量偏小':'满载已校准';
  useEffect(()=>{onDraft?.({context,lanes,eager,kvBytes,changed});},[context,lanes,eager,kvBytes,changed,onDraft]);
  useEffect(()=>{if(policy&&!dirty)setActivePreset(previous=>presets[previous]?.[1]===policy.context_tokens/1024&&presets[previous]?.[2]===policy.concurrency?previous:presets.findIndex(([,c,n])=>c===policy.context_tokens/1024&&n===policy.concurrency));},[policy?.context_tokens,policy?.concurrency,dirty,presetsReady]);
  function selectPreset(index){if(applying)return;const row=presets[index];setActivePreset(index);setContext(row[1]);setLanes(row[2]);setDirty(true);setError('');}
  function addPreset(){if(applying||presets.length>=8)return;const index=presets.length;setPresets(rows=>[...rows,['custom',context||64,lanes||1,'方案 '+(index+1)]]);setActivePreset(index);setDirty(true);requestAnimationFrame(()=>{nameInput.current?.focus({preventScroll:true});nameInput.current?.select();});}
  function removePreset(index){if(presets.length<=1)return;const rows=presets.filter((_,i)=>i!==index);setPresets(rows);if(activePreset===index){const next=Math.min(index,rows.length-1);setActivePreset(next);setContext(rows[next][1]);setLanes(rows[next][2]);setDirty(true);setError('');}else if(activePreset>index)setActivePreset(activePreset-1);}
  function renamePreset(value){setPresets(rows=>rows.map((row,i)=>i===activePreset?[row[0],row[1],row[2],value]:row));}
  function tabKey(e,index){let next;if(e.key==='ArrowRight')next=(index+1)%presets.length;else if(e.key==='ArrowLeft')next=(index-1+presets.length)%presets.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=presets.length-1;else return;e.preventDefault();selectPreset(next);tabs.current?.querySelectorAll('[role="tab"]')[next]?.focus();}

  async function apply(){
    if(lock.current||!valid||!changed)return;lock.current=true;setBusy(true);onApplying?.(true);setError('');
    const mode=context===192&&lanes===2?'long':context===256&&lanes===1?'long-single':context===64&&lanes===8?'throughput':'custom';
    try{const r=await fetch('/api/llm-mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode,context_tokens:context*1024,concurrency:lanes,eager,kv_budget_bytes:kvBytes})});const result=await r.json();if(!r.ok)throw Error(result.error??'设置未保存');onData(old=>({...old,llm_policy:result.policy,selected_llm_mode:mode,kv_budget:result.budget??old.kv_budget}));setDirty(false);onApplied?.();}
    catch(e){setError(e.message);}finally{lock.current=false;setBusy(false);onApplying?.(false);}
  }
  function change(set,value){set(value);setDirty(true);setError('');if(activePreset>=0)setPresets(rows=>rows.map((row,i)=>i===activePreset?[row[0],set===setContext?value:row[1],set===setLanes?value:row[2],row[3]]:row));}
  return <section className="qwen-config" style={{'--budget-color':budgetColor}} aria-busy={applying}>
    <div className="config-presets">
      <div className="config-section-label"><h3>任务方案</h3><span>保存在此浏览器 · {presets.length} / 8</span></div>
      <div className="kv-tabs-row"><div className="kv-config-tabs" ref={tabs} role="tablist" aria-label="上下文方案">{presets.map(([,c,n,label],i)=><div className={'kv-config-tab'+(activePreset===i?' selected':'')} key={i} role="presentation"><button role="tab" disabled={applying} id={'config-tab-'+i} aria-selected={activePreset===i} aria-controls="config-controls" tabIndex={activePreset===i||activePreset<0&&i===0?0:-1} onClick={()=>selectPreset(i)} onKeyDown={e=>tabKey(e,i)} title={presetForecast(c,n)}><span>{label||'未命名方案'}</span><small>{c||'—'}K <i>×</i> {n||'—'} 路</small></button><button className="config-tab-close" aria-label={'删除方案 '+(label||i+1)} disabled={applying||presets.length<=1} onClick={()=>removePreset(i)}><Icon name="close"/></button></div>)}</div><ActionButton icon="plus" className="config-tab-add" aria-label="新增方案" disabled={applying||presets.length>=8} onClick={addPreset}/></div>
      <div className="kv-config-name"><label htmlFor="config-name">方案名称</label><input ref={nameInput} id="config-name" value={activePreset>=0?presets[activePreset]?.[3]??'':''} placeholder="选择或新增方案" disabled={applying||activePreset<0} maxLength={16} onChange={e=>renamePreset(e.target.value)} onBlur={()=>{if(activePreset>=0&&!presets[activePreset][3].trim())renamePreset('方案 '+(activePreset+1));}}/><span>{presetError||'选择方案后可继续微调'}</span></div>
    </div>
    <div className="config-editor" id="config-controls" role="tabpanel" aria-labelledby={activePreset>=0?'config-tab-'+activePreset:undefined}>
      <div className="config-section-label"><h3>推理参数</h3><span className="config-draft-tag">{applying?'正在应用':changed?'未应用草稿':'已保存配置'}</span></div>
      <div className="kv-sliders">
        {[['每路上下文','输入、思考与回答共用',context,setContext,1,256,'K tokens'],['并发上限','同时处理的请求数',lanes,setLanes,1,8,'路']].map(([label,help,value,set,min,max,unit])=><div className="kv-slider-card" key={label}>
          <div className="kv-slider-top"><div><label htmlFor={unit==='路'?'lanes-value':'context-value'}>{label}</label><p>{help}</p></div><div className="kv-number"><input id={unit==='路'?'lanes-value':'context-value'} type="number" disabled={applying} aria-label={label} min={min} max={max} step="1" value={value} onChange={e=>change(set,e.target.value===''?'':Number(e.target.value))}/><span>{unit}</span></div></div>
          <input className="kv-range" type="range" disabled={applying} aria-label={label+'滑块'} min={min} max={max} step="1" value={value||min} onChange={e=>change(set,Number(e.target.value))} style={{'--kv-fill':'var(--service-accent)','--kv-pos':(Math.max(0,Math.min(100,((value||min)-min)/(max-min)*100)))+'%'}}/>
          <div className="kv-ticks">{(unit==='路'?[1,2,3,4,5,6,7,8]:[1,64,128,192,256]).map(n=><button key={n} aria-pressed={value===n} disabled={applying} style={{left:((n-min)/(max-min)*100)+'%'}} onClick={()=>change(set,n)}>{n}{unit==='路'?'':'K'}</button>)}</div>
        </div>)}
      </div>
      <div className="config-secondary">
        <section className="config-pool"><div className="setting-heading"><label htmlFor="kv-pool">KV 缓存预算</label><ActionButton variant="quiet" icon="external" className="budget-reset" disabled={applying||!Number.isSafeInteger(requiredPool)||requiredPool<2**30||requiredPool>32*2**30} onClick={()=>{setKvBytes(requiredPool);setKvText((requiredPool/2**30).toFixed(3));setDirty(true);}}>按需求填入</ActionButton></div><div className="pool-editor"><ActionButton icon="minus" aria-label="减少 KV 预算" disabled={applying||!valid||kvBytes<=2**30} onClick={()=>editBudget((Math.max(1,kvBytes/2**30-.25)).toFixed(3))}/><input id="kv-pool" aria-label="KV 预算 GiB" type="number" min="1" max="32" step="0.001" value={kvText} disabled={applying} onChange={e=>editBudget(e.target.value)}/><span>GiB</span><ActionButton icon="plus" aria-label="增加 KV 预算" disabled={applying||!valid||kvBytes>=32*2**30} onClick={()=>editBudget((Math.min(32,kvBytes/2**30+.25)).toFixed(3))}/></div><p>独立预算 · 每次增减 0.25 GiB</p></section>
        <section className="config-execution"><div className="setting-heading"><h3>执行模式</h3><button id="eager-mode" className="eager-switch" type="button" role="switch" aria-label="Eager 模式" aria-checked={eager} disabled={applying} onClick={()=>{setEager(!eager);setDirty(true);}}><i/></button></div><strong>{eager?'Eager':'图捕获'}</strong><p>{eager?'直接执行，降低图捕获显存占用':'关闭图捕获可切换至 Eager'}</p></section>
      </div>
    </div>
    <aside className="config-preview" aria-label="显存预算预览">
      <div className="config-section-label"><h3>容量预览</h3><span>{historical?'历史布局 · 草稿估算':'随草稿更新'}</span></div>
      <div className="config-margin-label">满载可用余量 <span>{budget.full_load_verified?'已校准':historical?'历史估算':'估算'}</span></div>
      <div className="kv-remaining" style={{color:vramMargin==null?undefined:vramMargin<0?'#f08a8a':budget.full_load_verified?'#92dfd0':'#efc47d'}}>{vramMargin==null?'缺少布局':(vramMargin<0?'−':vramMargin>0?'+':'')+(Math.abs(vramMargin)/2**30).toFixed(2)}<span>{vramMargin==null?'':'GiB'}</span></div>
      <p className="budget-formula">min（可分配池，配置 KV 预算）− 满载需求池</p>{historical&&<p className="config-preview-basis">来自上次 Qwen 引擎生成的布局；重启后以实际分配为准。</p>}
      <p className="config-preview-basis">同时考虑显存上限与 KV 预算；正数为余量，负数为缺口。</p>
      <div className="kv-blocks" aria-hidden="true">{Array.from({length:32},(_,i)=><i key={i} className={requiredPool&&feasiblePool&&i<Math.ceil(Math.min(1,requiredPool/Math.min(feasiblePool,Number(kvBytes)||feasiblePool))*32)?'used':''}/>)}</div>
      <dl className="config-capacity"><div><dt>满载需求池</dt><dd>{gib(requiredPool)}</dd></div><div><dt>预计可分配池</dt><dd>{gib(feasiblePool)}</dd></div><div><dt>配置 KV 预算</dt><dd>{gib(kvBytes)}</dd></div><div><dt>需求后显存余量</dt><dd>{budget.vram_margin_bytes==null?'待测':(budget.vram_margin_bytes<0?'−':'+')+(Math.abs(budget.vram_margin_bytes)/2**30).toFixed(2)+' GiB'}</dd></div><div><dt>预算预留后显存余量</dt><dd>{budget.budget_margin_bytes==null?'待测':(budget.budget_margin_bytes<0?'−':'+')+(Math.abs(budget.budget_margin_bytes)/2**30).toFixed(2)+' GiB'}</dd></div><div><dt>当前实际分配</dt><dd>{gib(actualKv)}</dd></div></dl>
      <div className="config-token-total"><div><span>满载上下文需求</span><strong>{valid?count(demand/1024):'—'}<small>K tokens</small></strong></div><span>{context||'—'}K × {lanes||'—'} 路</span></div>
      <details className="config-diagnostics"><summary><span>显存与布局明细</span><span className="disclosure-action"><span>查看</span><Icon name="chevron"/></span></summary><div>
        <section className="budget-section"><h4>两项显存约束</h4><div className="budget-row"><span>预算预留后余量</span><b>{budget.budget_margin_bytes==null?'待测':(budget.budget_margin_bytes/2**30).toFixed(2)+' GiB'}</b></div><div className="budget-row"><span>满载需求后余量</span><b>{budget.vram_margin_bytes==null?'待测':(budget.vram_margin_bytes/2**30).toFixed(2)+' GiB'}</b></div></section>
        <section className="budget-section"><h4>上下文容量</h4><div className="budget-row"><span>{capacityLabel}</span><b>{capacity==null?'待测':count(capacity)+' tokens'}</b></div><div className="budget-row"><span>容量{capacityMargin<0?'缺口':'余量'}</span><b>{capacityMargin==null?'待测':(Math.abs(capacityMargin)/1024).toFixed(1)+'K tokens'}</b></div></section>
        <section className="budget-breakdown"><h4>显存占用与布局</h4><dl>{[['整卡容量',budget.vram_total_bytes],['模型权重',budget.weights_bytes],['图捕获',budget.graph_capture_bytes],['计算缓冲（估算）',budget.buffer_bytes]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{Number.isFinite(value)?(value/2**30).toFixed(2)+' GiB':'待测'}</dd></div>)}</dl>{budget.factors&&<p>GDN {budget.factors.gdn} · 预填充 {budget.factors.prefill_tokens} · {budget.factors.pool_blocks} 块</p>}</section>
      </div></details>
    </aside>
    <div className="config-commit">
      <div className="config-verdict" role="status" aria-live="polite"><strong><i/>{headline}</strong><p>{!valid?'请输入有效上下文、并发和 KV 预算。':status==='unknown'?'缺少该组合的布局规划，启动后测量；不沿用其他配置容量。':over?`约束缺口：${budget.violations.map(v=>({allocation:'配置池超过预计可分配显存',vram:'满载池需求超过预计可分配显存',budget:'KV 预算小于满载池需求',tokens:'KV token 容量不足'})[v]).join('；')}。`:budget.full_load_verified?'按该配置满载采样校准。':'池需求按引擎布局计算；尚未验证满载预填充和解码峰值。'}</p></div>
      <div className="config-submit"><div><span>{changed?'待应用':'已保存'}</span><strong>{context||'—'}K <i>×</i> {lanes||'—'} 路 <small>· {eager?'Eager':'图捕获'} · {gib(kvBytes)}</small></strong><p>{applying?'等待当前任务结束并重启模型…':'应用时等待当前任务结束，再重启模型'}</p></div><ActionButton variant="primary" icon={applying?'restart':'check'} className={applying?'is-loading':''} onClick={apply} disabled={!policy||applying||!changed||!valid}>{applying?'重启中…':!policy?'读取中…':!valid?'检查额度':changed?'应用并重启':applied?'已应用':'已保存'}</ActionButton></div>
      {error&&<p className="bad" role="alert">{error}</p>}
    </div>
  </section>;
}
