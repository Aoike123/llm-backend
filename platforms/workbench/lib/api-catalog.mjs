// The gateway's HTTP surface, declared once. The console's API page and the public-path check of
// the access keys both read this, so a route added here appears in the docs and is admitted
// the same way. The synchronous media routes are not listed by hand: each enabled capability
// that declares a `sync` path in media-tools.mjs registers its own.
import {CAPABILITIES} from './media-tools.mjs';

// public: reachable from the internet with a Bearer key (and locally); key: local, needs a
// dedicated key; local: local only.
export const ACCESS={public:'公网 + 本机',key:'本机 · 专用密钥',local:'本机'};
export const GROUPS=[
  {id:'chat',label:'聊天',note:'聊天模型目录与聊天补全，与媒体目录分开。'},
  {id:'sync',label:'媒体 · 同步',note:'提交后等待结果；每个已启用的能力自动登记自己的路径，停用后消失。'},
  {id:'jobs',label:'媒体 · 持久任务',note:'返回 202 与 job_id，断开连接不取消；全部媒体能力和 MCP 都走这里。'},
  {id:'library',label:'素材、作品与音色',note:'上传素材，取回作品，管理音色库。'},
  {id:'ops',label:'运维',note:'健康检查、状态与 Prometheus 指标。'},
];
// Routes that exist whatever engines are enabled. {…} marks a path parameter.
export const FIXED=[
  {group:'chat',method:'POST',path:'/v1/chat/completions',purpose:'聊天补全，支持 SSE 流式',access:'public'},
  {group:'chat',method:'GET',path:'/v1/models',purpose:'聊天模型与已保存额度',access:'public'},
  {group:'sync',method:'GET',path:'/v1/media/models',purpose:'媒体模型目录与各模型参数，不加载模型',access:'public'},
  {group:'sync',method:'GET',path:'/v1/capabilities',purpose:'能力、主推与降级顺序',access:'local'},
  {group:'sync',method:'GET',path:'/artifacts/{artifact}.mp4',purpose:'同步视频生成的结果文件',access:'public'},
  {group:'jobs',method:'POST',path:'/v1/media/jobs',purpose:'提交持久任务，body 为 {tool, arguments}',access:'key'},
  {group:'jobs',method:'GET',path:'/v1/media/jobs',purpose:'列出自己的任务，新的在前（offset / limit）',access:'key'},
  {group:'jobs',method:'GET',path:'/v1/media/jobs/{job_id}',purpose:'查询任务，wait_seconds 最多等 20 秒',access:'key'},
  {group:'jobs',method:'POST',path:'/v1/media/jobs/{job_id}/cancel',purpose:'取消任务：排队中立即取消，可中断的后端运行中也能中断',access:'key'},
  {group:'jobs',method:'GET',path:'/v1/media/catalog',purpose:'MCP 工具目录，随已启用引擎变化',access:'key'},
  {group:'library',method:'POST',path:'/v1/media/assets',purpose:'上传素材（二进制），?kind=image|video|audio，返回 asset_id',access:'key'},
  {group:'library',method:'GET',path:'/v1/media/artifacts/{artifact_id}',purpose:'作品元数据与本机路径',access:'key'},
  {group:'library',method:'GET',path:'/v1/media/artifacts/{artifact_id}/content',purpose:'下载作品（二进制，支持 Range）',access:'key'},
  {group:'library',method:'GET',path:'/v1/media/voices',purpose:'模糊搜索音色库（query、group、offset、limit）',access:'key'},
  {group:'library',method:'PATCH',path:'/v1/media/voices/{artifact_id}',purpose:'音色改名或换分组',access:'key'},
  {group:'ops',method:'GET',path:'/health',purpose:'健康检查；排空中返回 503',access:'local'},
  {group:'ops',method:'GET',path:'/status',purpose:'GPU 协调器与引擎状态',access:'local'},
  {group:'ops',method:'GET',path:'/metrics',purpose:'Prometheus 指标',access:'local'},
];
// Every path the gateway may serve to the internet: the public fixed routes plus the sync path of
// each capability an installed package declares.
export const publicPaths=()=>new Set([...FIXED.filter(r=>r.access==='public'&&!r.path.includes('{')).map(r=>r.path),...Object.values(CAPABILITIES).map(c=>c.sync).filter(Boolean)]);

// The page's content: the fixed routes, the sync routes of enabled capabilities, and the job
// tools POST /v1/media/jobs accepts. `routes` are the capability routes of the registry.
export function apiCatalog(routes,categories=[]){
  const enabled=new Map(routes.map(r=>[r.capability,r]));
  const sync=Object.entries(CAPABILITIES).filter(([capability,c])=>c.sync&&enabled.has(capability)).map(([capability,c])=>{
    const r=enabled.get(capability);return {group:'sync',method:'POST',path:c.sync,purpose:c.sync_via==='job'?c.label+'，同步等待任务完成并返回作品（需要密钥）':c.label+'，同步返回',access:'public',default:c.sync_public!==false,models:{primary:r.primary,providers:r.providers}};
  });
  const all=[...FIXED,...sync];
  const owner=new Map(categories.flatMap(c=>c.tools.map(name=>[name,c])));
  return {
    groups:GROUPS.map(g=>({...g,routes:all.filter(r=>r.group===g.id)})).filter(g=>g.routes.length),
    access:ACCESS,
    job_tools:routes.map(r=>({tool:r.tool,task:r.task??null,capability:r.capability,label:r.label,category:owner.get(r.tool)?.label??null,primary:r.primary,providers:r.providers})),
  };
}
