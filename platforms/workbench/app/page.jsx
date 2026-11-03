'use client';
import {useCallback,useEffect,useState} from 'react';
import ModeSwitch from './mode-switch';
import {Icon,ActionButton} from './ui-controls.mjs';
import CpuVisionCard from './cpu-vision-card';
import EngineLogs from './engine-logs';
import AccessKeyManager from './access-keys';
import McpPanel from './mcp-panel';
import {Overview,TaskCenter,ApiPanel,GatewayRecords} from './control-center';
import EnginesPanel from './engines-panel';
import VoiceLibrary from './voice-library';
import {Gallery,JobTable,JobDrawer} from './media-library';
import {useDisclosureAnimation} from './use-disclosure-animation.mjs';
import {useRoute} from './use-route.mjs';
import {SERVICES,setServices,TYPE_LABEL,serviceName,serviceState,serviceRecords,fmt,clock,followedEngine} from '../lib/panel.mjs';
// Shown until the gateway's first snapshot names the real services.
const PENDING={id:null,name:'读取中',version:'',description:'',type:'language',panel:null,accent:'#b8a3ff',symbol:'·',models:[]};
import {ResponsiveContainer,AreaChart,Area,XAxis,YAxis,CartesianGrid,Tooltip,BarChart,Bar,Cell} from 'recharts';

function Trend({data,unit,color='var(--service-accent)',max,minutes,timestamp}){
  const rows=(data??[]).map(([time,value])=>({time,value}));
  if(!rows.some(r=>Number.isFinite(r.value)))return <div className="empty">暂无有效采样</div>;
  return <ResponsiveContainer width="100%" height="100%"><AreaChart data={rows} margin={{top:16,right:14,bottom:0,left:0}}><CartesianGrid stroke="#303443" vertical={false}/><XAxis dataKey="time" type="number" domain={[timestamp-minutes*60,timestamp]} tickFormatter={t=>clock(t).slice(0,5)} tick={{fill:'#a1aabb',fontSize:12}} tickCount={3}/><YAxis domain={[0,max??'auto']} tick={{fill:'#a1aabb',fontSize:12}} width={45}/><Tooltip labelFormatter={clock} formatter={v=>[fmt(v)+' '+unit,'采样']} contentStyle={{background:'#202631',border:'1px solid #444b61',borderRadius:8}}/><Area type="linear" dataKey="value" stroke={color} fill={color} fillOpacity={0.08} strokeWidth={2} isAnimationActive={false} connectNulls={false}/></AreaChart></ResponsiveContainer>;
}
function TaskList({records,loading=false}){
  if(loading)return <div className="empty">正在读取服务任务…</div>;
  if(!records.length)return <div className="empty">该服务暂无已完成任务</div>;
  const shown=records.slice(0,5),longest=Math.max(1,...shown.map(r=>r.seconds));
  return <div className="records">{shown.map((r,i)=>{const wait=Math.min(r.seconds,r.queue_seconds),work=Math.max(0,r.seconds-wait);
    return <div className="record" key={r.finished_at+'-'+i}><div>{clock(r.finished_at)}<small>等待 {fmt(wait)} 秒 · 处理 {fmt(work)} 秒</small></div><div className={r.outcome==='success'?'live':'bad'}>{r.outcome==='success'?'完成':r.outcome==='disconnected'?'断开':'异常'}<small>{fmt(r.seconds)} 秒</small></div><span className="record-split" aria-hidden="true"><span style={{width:r.seconds/longest*100+'%'}}><i style={{flexGrow:wait}}/><b style={{flexGrow:work,...(r.outcome==='success'?{}:{background:'var(--failed-color)'})}}/></span></span></div>;})}</div>;
}
// Waiting happens first, so it sits at the bottom of each bar and processing on top.
function RequestChart({records}){
  const tasks=records.slice(0,12).reverse().map(r=>({time:clock(r.finished_at),wait:Math.min(r.seconds,r.queue_seconds),work:Math.max(0,r.seconds-r.queue_seconds),failed:r.outcome!=='success'}));
  if(!tasks.length)return <div className="empty">当前时间范围内暂无已完成任务</div>;
  return <ResponsiveContainer width="100%" height="100%"><BarChart data={tasks} maxBarSize={26} margin={{top:8,right:8,bottom:0,left:0}} barCategoryGap="30%"><CartesianGrid stroke="#262b35" vertical={false}/><XAxis dataKey="time" tick={{fill:'#8993a4',fontSize:11}} axisLine={false} tickLine={false} tickMargin={10} interval="preserveStartEnd" minTickGap={24}/><YAxis tick={{fill:'#8993a4',fontSize:11}} axisLine={false} tickLine={false} tickMargin={8} width={40} unit="s"/><Tooltip cursor={{fill:'#ffffff',fillOpacity:0.03}} contentStyle={{background:'#191e28',border:'1px solid #373e4b',borderRadius:10,padding:'10px 14px',boxShadow:'0 10px 32px #0005',fontSize:12}} labelStyle={{color:'#d8dee9',marginBottom:4}} itemStyle={{padding:'2px 0'}} formatter={(n,name)=>[fmt(n)+' 秒',name]} labelFormatter={(label,rows)=>label+(rows?.[0]?.payload?.failed?' · 异常':'')}/><Bar dataKey="wait" name="等待与切换" stackId="task" fill="var(--wait-color)" isAnimationActive={false}/><Bar dataKey="work" name="处理与返回" stackId="task" fill="var(--service-accent)" radius={[4,4,0,0]} isAnimationActive={false}>{tasks.map((t,i)=><Cell key={i} fill={t.failed?'var(--failed-color)':'var(--service-accent)'}/>)}</Bar></BarChart></ResponsiveContainer>;
}
function Runtime({data,service,minutes,windowSeconds,setWindowSeconds}){
  const d=data??{},v=d.values??{},llm=service.panel==='llm',state=serviceState(data,service.id),live=state==='ready'||state==='busy';
  const records=serviceRecords(data,service.id),rangeRecords=serviceRecords(data,service.id,minutes),engine=live?d.llm_engine:null;
  const last=records[0]??(Number.isFinite(v.last)&&Number.isFinite(v.wait)?{seconds:v.last,queue_seconds:v.wait,finished_at:v.last_completed}:null);
  const cards=llm?[
    ['输出吞吐',live?v.output:null,'token/s',`${windowSeconds} 秒均值 · 含全部并发`],
    ['首 token · P95',live?v.ttft:null,'秒','近 5 分钟请求样本'],
    ['运行请求',live?v.running:null,'路','引擎当前实际处理'],
    ['KV 缓存',live?v.kv:null,'%','当前缓存使用率'],
  ]:[
    ['最近完整请求',v.last??last?.seconds,'秒',last?(Number.isFinite(last.finished_at)?clock(last.finished_at)+' 完成 · 历史记录':'历史记录 · 完成时间待采集'):'含等待、切换、生成与传输'],
    ['等待与切换',v.wait??last?.queue_seconds,'秒','最近一次完整请求'],
    ['正在处理',data?d.active:null,'个','该服务的网关活动请求'],
    ['累计完成',v.success,'次','该服务 · 网关累计'],
  ];
  const available=Number.isFinite(d.kv_budget?.capacity_tokens)&&Number.isFinite(v.kv)&&live?Math.max(0,d.kv_budget.capacity_tokens*(1-Math.min(100,Math.max(0,v.kv))/100)):null;
  return <div className={'runtime-workspace '+service.type}>
    <section className="stage-kpis" aria-label="服务核心指标">{cards.map(([label,value,unit,note],i)=><div className="stage-kpi" key={label}><span className="label">{label}</span><div className="stage-value">{fmt(value,i===2?0:1)}<span>{unit}</span></div><p className="note">{!data?'正在读取':llm&&!live?(state==='switching'?'引擎就绪后更新':'未加载 · 无实时指标'):note}</p></div>)}</section>
    {llm?<>
      <div className="stage-grid"><section className="stage-chart"><div className="charthead"><h2>输出吞吐</h2><span className="muted tiny">token/s · 每 5 秒采集</span></div><div className="throughput-toolbar"><div><span>统计窗口</span><div className="window-options" role="group" aria-label="吞吐统计窗口">{[5,15,30,60].map(seconds=><button key={seconds} aria-pressed={windowSeconds===seconds} onClick={()=>setWindowSeconds(seconds)}>{seconds} 秒</button>)}</div></div><small>{live?'运行采样':'历史采样'}</small></div><div className="plot"><Trend data={d.trends?.main} unit="token/s" minutes={minutes} timestamp={d.timestamp}/></div><div className="trend-caption"><p className="note">{windowSeconds===5?'相邻 5 秒区间均速，可能呈现记账尖峰。':'按窗口统计，含思考、全部并发及空闲时间。'}采集缺失保留断点。</p><span>近一分钟 5 秒峰值 <b>{fmt(live?v.peak:null)} token/s</b></span></div></section><section className="stage-activity"><div className="charthead"><h2>最近请求</h2><span className="muted tiny">网关记录 · Qwen</span></div><TaskList records={records} loading={!data}/></section></div>
      <section className="running-policy"><div className="charthead"><h2>当前运行配置</h2><span className="muted tiny">引擎实际值</span></div><div className="running-policy-grid">{[['每路上下文',engine?.context_tokens?fmt(engine.context_tokens/1024,0)+'K':'—'],['并发上限',engine?.concurrency?engine.concurrency+' 路':'—'],['KV 实际分配',engine?.pool_allocated_bytes?fmt(engine.pool_allocated_bytes/2**30,3)+' GiB':'—'],['执行方式',engine?engine.eager?'Eager':'图捕获':'—'],['实时 KV 剩余',available==null?'—':fmt(available/1024)+'K tokens']].map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><p className="note">{live?'实际配置由运行引擎读取；实时 KV 剩余按使用率估算。':'该服务当前未运行；已保存参数可在模型配置中查看。'}</p></section>
      <div className="stage-grid secondary-grid"><section className="stage-chart"><div className="charthead"><h2>近一分钟输入量</h2><span className="muted tiny">tokens · 独立刻度</span></div><div className="plot small"><Trend data={d.trends?.secondary} unit="tokens" color="#79d8ce" minutes={minutes} timestamp={d.timestamp}/></div><p className="note">滚动 60 秒后端输入计数增量估算，不代表 GPU 预填充速度。</p></section></div><details className="vision-detail"><summary><span className="vision-summary-title"><Icon name="activity"/><span>视觉编码<small>CPU 图像特征</small></span></span><span className="vision-summary-state"><i className={v.vision_up===1?'live':'muted'}>{v.vision_up===1?'● 在线':v.vision_up==null?'等待采集':'○ 离线'}</i><span>计算中 <b>{fmt(v.vision_active,0)}</b></span><span>等待 <b>{fmt(v.vision_waiting,0)}</b></span></span><span className="disclosure-action"><span>详情</span><Icon name="chevron"/></span></summary><CpuVisionCard values={v}/></details>
    </>:<>
      <div className="media-workspace"><section className="stage-chart media-history"><div className="charthead"><h2>{TYPE_LABEL[service.type]?.noun??'媒体'}任务耗时</h2><span className="chart-legend"><span><i className="legend-wait"/>等待与切换</span><span><i className="legend-work"/>处理与返回</span>{rangeRecords.some(r=>r.outcome!=='success')&&<span><i className="legend-failed"/>异常</span>}<small>最近 {minutes} 分钟</small></span></div><div className="plot"><RequestChart records={rangeRecords}/></div><p className="note">每根柱子是一次完整请求：底部为排队与引擎切换，顶部为生成与结果传输。</p></section><section className="stage-activity"><div className="charthead"><h2>最近请求</h2><span className="muted tiny">网关记录</span></div><TaskList records={records} loading={!data}/></section></div>
    </>}
  </div>;
}
function DeviceStatus({data,minutes}){
  const [expanded,setExpanded]=useState(false),v=data?.values??{};
  return <details className="device-details" onToggle={e=>setExpanded(e.currentTarget.open)}><summary><span>共享设备 <small>整机指标</small></span><span>GPU <b>{fmt(v.gpu)}%</b></span><span>显存 <b>{fmt(v.vram==null?null:v.vram/2**30)} / {fmt(v.vram_total==null?null:v.vram_total/2**30,0)} GiB</b></span><span>温度 <b>{fmt(v.temperature)}°C</b></span><span className="device-expand ui-action ui-action-secondary"><span>{expanded?'收起详情':'设备详情'}</span><Icon name="chevron"/></span></summary>{expanded&&<div className="device-body"><div className="system"><span className={v.api===1?'live':'muted'}>● 网关 {v.api===1?'在线':v.api==null?'待采集':'离线'}</span><span className={v.comfy===1?'live':'muted'}>● ComfyUI {v.comfy===1?'在线':v.comfy==null?'待采集':'离线'}</span><span>网关排队 {data?.queued??'—'}</span><span>可用内存 {fmt(v.memory==null?null:v.memory/2**30)} GiB</span><span>Radeon AI PRO R9700</span></div><div className="bottom">{[['GPU 利用率','%',data?.trends?.gpu,100],['整卡显存占用','GiB',data?.trends?.vram?.map(([t,n])=>[t,n==null?null:n/2**30]),v.vram_total?v.vram_total/2**30:32]].map(([label,unit,rows,max])=><section className="stage-chart" key={label}><div className="charthead"><h2>{label}</h2><span className="muted tiny">{unit}</span></div><div className="plot"><Trend data={rows} unit={unit} color="#79d8ce" max={max} minutes={minutes} timestamp={data?.timestamp}/></div></section>)}</div></div>}</details>;
}
const NAVIGATION=[['overview','activity','总览','设备与调度'],['library','image','作品库','全部生成结果'],['tasks','tasks','任务中心','执行与队列'],['services','settings','模型服务','监控与配置'],['engines','filter','引擎','接入与路由'],['api','terminal','API','程序接入'],['mcp','follow','MCP','模型工具接入'],['keys','key','访问与公网','密钥、放行与额度']];
const HEADINGS={overview:['INFERENCE WORKBENCH','总览','单卡推理工作台','查看调度状态、模型服务与最近作品。'],library:['ARTIFACTS','作品库','全部引擎','所有持久任务保存的图像、视频、音频和转写，点击查看输入与参数。'],tasks:['JOBS & QUEUES','任务中心',null,'持久媒体任务、网关请求记录与 ComfyUI 原生队列。'],engines:['ENGINE PACKAGES & ROUTING','引擎','接入与路由','启用或停用引擎包，设置每种能力的主推与降级顺序。'],api:['PROGRAMMATIC ACCESS','API','统一推理入口','聊天、媒体同步接口和持久任务接口。'],mcp:['MEDIA MODEL CONNECTION','MCP','local-media','查看媒体模型接入配置、工具能力与调用记录。'],keys:['ACCESS & PUBLIC','访问与公网',null,'管理谁能调用网关（密钥与额度），以及公网能访问哪些接口。']};
function Heading({section}){const [eyebrow,title,sub,text]=HEADINGS[section];return <section className="service-identity"><div><div className="eyebrow">{eyebrow}</div><h1>{title}{sub&&<span>{sub}</span>}</h1><p>{text}</p></div></section>;}
export default function Page(){
  useDisclosureAnimation();
  const [route,navigate]=useRoute();
  const [minutes,setMinutes]=useState(30),[windowSeconds,setWindowSeconds]=useState(30),[data,setData]=useState(null),[error,setError]=useState('');
  const [configMounted,setConfigMounted]=useState(false),[applying,setApplying]=useState(false),[revision,setRevision]=useState(0);
  setServices(data?.services);
  const section=route.section,openJob=id=>navigate({job:id}),closeJob=()=>navigate({job:null});
  // The service shown is the one in the URL. "auto" (or none) follows the running engine, so a
  // switch moves the page; naming a service pins it.
  const FOLLOW='auto',pinned=route.service&&route.service!==FOLLOW?route.service:null,follow=!pinned;
  const model=pinned??followedEngine(data)??data?.model??SERVICES[0]?.id??null,routeService=follow?FOLLOW:model;
  const refresh=useCallback(()=>setRevision(n=>n+1),[]);
  useEffect(()=>{
    const controller=new AbortController();let disposed=false,timer;setError('');
    async function poll(){try{const params=new URLSearchParams({minutes,window:windowSeconds});if(pinned)params.set('model',pinned);const r=await fetch('/data?'+params,{cache:'no-store',signal:controller.signal});if(!r.ok)throw new Error();const d=await r.json();if(!disposed){setData(d);setError('');}}catch{if(!disposed)setError('网关连接中断');}finally{if(!disposed)timer=setTimeout(poll,5000);}}
    poll();return()=>{disposed=true;controller.abort();clearTimeout(timer);};
  },[minutes,windowSeconds,pinned,revision]);
  const service=SERVICES.find(s=>s.id===model)??PENDING,matched=!!data&&(data.model===model||(follow&&!data.model));
  const media=service.panel==='media';
  // Work tabs come from the package (ui.works); an engine that declares none has one 作品 tab.
  const works=media?service.works??[{id:'works',label:'作品',icon:'image'}]:[];
  const views=[['runtime','运行监控','activity'],...works.map(w=>[w.id,w.label,w.icon??'image']),['tasks',media?'任务':'请求记录','tasks'],['config','模型配置','settings']];
  const work=works.find(w=>w.id===route.view);
  const view=views.some(([id])=>id===route.view)?route.view:'runtime';
  useEffect(()=>{if(view==='config')setConfigMounted(true);},[view]);
  const effective=data?{...data,pending_llm_mode:applying?(data.pending_llm_mode??'custom'):data.pending_llm_mode}:null;
  const shown=matched?effective:null,state=serviceState(shown,model),live=state==='ready'||state==='busy';
  const status=error?'连接中断':state==='loading'?'正在读取':state==='switching'?'正在准备引擎':state==='busy'?'正在处理任务':state==='ready'?'就绪 · 等待任务':'未加载 · 按需启动';
  const phase={draining:'等待当前任务结束',loading:'加载目标配置',saving:'保存配置',ready:'引擎已生效',error:'应用失败'}[effective?.mode_switch?.phase];
  const canvas=data?.runtime_topology?.comfyui_port?'http://127.0.0.1:'+data.runtime_topology.comfyui_port:null;
  const runtimeConfig=live&&service.panel==='llm'?shown?.llm_engine:null;
  const sharing=SERVICES.filter(item=>item.runtime===service.runtime).map(item=>item.name);
  const runningService=SERVICES.find(item=>item.id===(effective?.switching_target??data?.current_model));
  const viewIds=views.map(([id])=>id);
  function tabKey(e){const index=viewIds.indexOf(view);let next;if(e.key==='ArrowRight')next=viewIds[(index+1)%viewIds.length];else if(e.key==='ArrowLeft')next=viewIds[(index+viewIds.length-1)%viewIds.length];else if(e.key==='Home')next=viewIds[0];else if(e.key==='End')next=viewIds.at(-1);if(next){e.preventDefault();navigate({section:'services',service:routeService,view:next});document.getElementById('tab-'+next)?.focus();}}
  return <div className="workbench" style={{'--service-accent':section==='services'?service.accent:'#b8a3ff'}}>
    <aside className="service-sidebar"><div className="studio-brand"><span aria-hidden="true">✦</span><strong>Workbench</strong></div><span className="sidebar-caption">INFERENCE CONTROL</span><nav className="service-navigation" aria-label="工作台导航"><span className="service-indicator" aria-hidden="true" style={{transform:`translateY(${NAVIGATION.findIndex(([id])=>id===section)*72}px)`}}/>{NAVIGATION.map(([id,icon,title,description])=><a key={id} href={'#/'+id} aria-current={section===id?'page':undefined} onClick={e=>{e.preventDefault();navigate({section:id});}}><span className="service-symbol" aria-hidden="true"><Icon name={icon}/></span><span>{title}<small>{description}</small></span></a>)}</nav>
      <section className="sidebar-status" aria-label="工作台状态"><div className="sidebar-status-heading"><i className={error?'status-offline':data?'status-online':'status-pending'}/><span>{error?'连接暂时中断':data?'网关监控已连接':'正在连接'}</span></div><span className="sidebar-status-label">{effective?.switching_target?'正在切换':'当前运行后端'}</span>{runningService?<button className="sidebar-running" onClick={()=>navigate({section:'services',service:runningService.id})}>{[runningService.name,runningService.version].filter(Boolean).join(' ')}</button>:<strong>{data?'待机':'读取中'}</strong>}<small className="sidebar-runtime-state">{error?'状态待确认':!data?'等待采集':effective?.switching_target?'正在准备引擎':runningService?'按需运行':'等待任务'}</small><div className="sidebar-device"><span>Radeon R9700</span><small>{data?.values?.vram_total?fmt(data.values.vram_total/2**30,0)+' GiB':'容量读取中'}</small></div>{canvas&&<a href={canvas} target="_blank" rel="noreferrer"><span>ComfyUI 画布</span><Icon name="external"/></a>}</section></aside>
    <main className="studio-main"><div className="studio-top"><span>工作空间 / <b>{NAVIGATION.find(([id])=>id===section)?.[2]}</b>{section==='services'&&model&&<> / <b>{service.name}</b>{follow&&<small className="follow-crumb"> · 跟随运行</small>}</>}</span><span>单卡按需调度 <i/> API / MCP 统一执行</span></div>
      {section==='overview'&&<><Heading section="overview"/><Overview data={data} onService={id=>navigate({section:'services',service:id})} onLibrary={()=>navigate({section:'library'})} onOpen={openJob}/><DeviceStatus data={data} minutes={minutes}/></>}
      {section==='library'&&<><Heading section="library"/><div className="workspace-stage"><Gallery onOpen={openJob} limit={30}/></div></>}
      {section==='tasks'&&<><Heading section="tasks"/><TaskCenter data={data} onOpen={openJob} openId={route.job}/></>}
      {section==='api'&&<><Heading section="api"/><ApiPanel/></>}
      {section==='mcp'&&<><Heading section="mcp"/><div className="workspace-stage"><McpPanel/></div></>}
      {section==='engines'&&<><Heading section="engines"/><div className="workspace-stage"><EnginesPanel/></div></>}
      {section==='keys'&&<><Heading section="keys"/><div className="workspace-stage"><AccessKeyManager/></div></>}
      {section==='services'&&<>
      <div className="model-selector" role="group" aria-label="模型服务"><button className="engine-follow" aria-pressed={follow} onClick={()=>navigate({section:'services',service:FOLLOW,view:route.view})} title="页面随调度器切换到正在运行的引擎"><Icon name="follow"/>跟随运行</button><span className="selector-divider" aria-hidden="true"/>{SERVICES.map(item=><button key={item.id} aria-pressed={pinned===item.id} className={follow&&model===item.id?'is-followed':undefined} onClick={()=>navigate({section:'services',service:item.id,view:route.view})}><span style={{color:item.accent}}>{item.symbol}</span>{item.name}{data?.current_model===item.id&&<small className="live" title="运行中">●</small>}</button>)}</div>
      <section className="service-identity"><div><div className="eyebrow">{TYPE_LABEL[service.type]?.eyebrow??'MEDIA'} ENGINE · {service.kind}</div><h1>{service.name}{service.version&&<span>{service.version}</span>}</h1><p>{service.description}</p></div><div className="service-status"><strong className={error?'bad':state==='switching'?'preparing':live?'live':'muted'}>{live?'●':'○'} {status}</strong><small>{runtimeConfig?`${fmt(runtimeConfig.context_tokens/1024,0)}K 上下文 · ${runtimeConfig.concurrency??'—'} 路并发`:`当前后端 · ${serviceName(data?.current_model)}`}</small>{state==='switching'&&phase&&<small className="preparing">{phase}</small>}</div></section>
      {data?.error&&<div className="error-banner" role="alert">调度异常：{data.error}</div>}
      <div className="workspace-toolbar"><div className="workspace-tabs" role="tablist" aria-label="服务工作区">{views.map(([id,label,icon])=><button key={id} role="tab" id={'tab-'+id} aria-selected={view===id} aria-controls={'panel-'+id} tabIndex={view===id?0:-1} onClick={()=>navigate({section:'services',service:routeService,view:id})} onKeyDown={tabKey}><Icon name={icon}/>{label}</button>)}</div>{view==='runtime'&&<div className="workspace-range"><div className="controls" aria-label="图表时间范围">{[15,30,60].map(m=><button key={m} aria-pressed={minutes===m} onClick={()=>setMinutes(m)}>{m===60?'1 小时':m+' 分钟'}</button>)}</div><small>{matched?clock(data.timestamp)+' 更新':'读取中'}</small></div>}</div>
      <div className="workspace-stage">
        {view==='runtime'&&<section id="panel-runtime" role="tabpanel" aria-labelledby="tab-runtime"><Runtime data={shown} service={service} minutes={minutes} windowSeconds={windowSeconds} setWindowSeconds={setWindowSeconds}/></section>}
        {work&&view===work.id&&<section id={'panel-'+work.id} role="tabpanel" aria-labelledby={'tab-'+work.id}>{work.view==='voices'?<VoiceLibrary key={model} engine={model}/>:<Gallery key={model+':'+work.id} engine={model} capabilities={work.capabilities} kinds={work.kinds} onOpen={openJob} limit={24}/>}</section>}
        {view==='tasks'&&<section id="panel-tasks" role="tabpanel" aria-labelledby="tab-tasks" className="service-tasks">{media&&<><JobTable key={model} engine={model} onOpen={openJob} openId={route.job}/><h3 className="subsection">网关请求记录</h3></>}<GatewayRecords records={data?.recent} service={model}/></section>}
        <section id="panel-config" role="tabpanel" aria-labelledby="tab-config" hidden={view!=='config'}>
          <div className="configuration-workspace"><div className="section-heading"><div><span className="eyebrow">CONFIGURATION</span><h2>{service.name} · 模型配置</h2></div><p>{service.panel==='llm'?'编辑草稿 · 应用后重启生效':'服务能力与接口信息'}</p></div></div>
          <div className="configuration-workspace" hidden={service.panel!=='llm'}>{configMounted&&<><div className="configuration-state"><span>当前运行 <b>{data?.current_model===service.id&&!data.switching&&data.llm_engine?`${fmt(data.llm_engine.context_tokens/1024,0)}K · ${data.llm_engine.concurrency} 路`:'Qwen 未就绪'}</b></span><span>已保存 <b>{data?.llm_policy?`${fmt(data.llm_policy.context_tokens/1024,0)}K · ${data.llm_policy.concurrency} 路`:'正在读取'}</b></span><span className={applying||data?.pending_llm_mode?'preparing':'muted'}>{applying||data?.pending_llm_mode?phase??'提交配置中':'草稿仅在点击应用后提交'}</span></div><ModeSwitch data={data} onData={setData} onApplying={setApplying} onApplied={refresh}/></>}</div>
          {media&&<section className="media-configuration"><dl><div><dt>模型标识</dt><dd>{service.models?.map(m=>m.id).join('、')||'—'}</dd></div>{(data?.capabilities??[]).filter(route=>route.providers.some(id=>service.models?.some(m=>m.id===id))).map(route=><div key={route.capability}><dt>{route.label}</dt><dd><code>{route.tool}</code>{route.sync&&<> · <code>{route.sync}</code></>}<small className="mcp-sub">{service.models.some(m=>m.id===route.primary)?'主推':'降级 / 点名使用'}</small></dd></div>)}<div><dt>任务内容</dt><dd>{service.summary??service.description}</dd></div><div><dt>引擎包</dt><dd><code>{service.package}</code> · 端口 {service.port}</dd></div><div><dt>运行时</dt><dd><code>{service.runtime}</code>{sharing.length>1&&<>（与 {sharing.filter(name=>name!==service.name).join('、')} 共用，互相切换不重启）</>}{service.native_ui&&<> · {canvas?<a href={canvas} target="_blank" rel="noreferrer">打开 ComfyUI 画布 ↗</a>:'画布未启用'}</>}</dd></div><div><dt>加载方式</dt><dd>收到任务后由调度器按需加载</dd></div></dl><p className="note">生成参数随请求提交，浏览页面不会加载模型。主推与降级在「引擎」页设置。</p></section>}
        </section>
      </div>
      <DeviceStatus data={data} minutes={minutes}/>
      {model&&<EngineLogs model={model} data={effective}/>}
      </>}
      <footer className="studio-footer"><span>API / MCP 统一调度 · 当前后端 {serviceName(data?.current_model)}</span><span>监控每 5 秒更新</span></footer>
    </main>
    {error&&<div className="connection-toast" role="status" aria-live="polite"><i/><span>网关连接中断，正在重连</span><small>显示的是上次读取的数据</small></div>}
    <JobDrawer id={route.job} onClose={closeJob}/>
  </div>;
}
