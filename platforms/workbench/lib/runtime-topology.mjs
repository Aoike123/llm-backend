import {readFileSync} from 'node:fs';
export const TOPOLOGY=JSON.parse(readFileSync(new URL('../../runtime-topology.json',import.meta.url),'utf8'));
export const runtimeFor=engine=>Object.entries(TOPOLOGY.runtimes).find(([,runtime])=>runtime.engines.includes(engine))?.[0]??null;
export const sameRuntime=(a,b)=>a===b||(runtimeFor(a)!==null&&runtimeFor(a)===runtimeFor(b));
export const modelBackends=()=>Object.fromEntries(Object.values(TOPOLOGY.runtimes).flatMap(runtime=>runtime.engines.map(engine=>[engine,[[...runtime.launch],runtime.port,runtime.container]])));
export function runtimeTopology(status={}) {
  const current=runtimeFor(status.current);
  return {mode:TOPOLOGY.mode,label:'单卡按需切换 · API / MCP 统一调度 · ComfyUI 原生工作流',
    current_runtime:current,current_runtime_name:TOPOLOGY.runtimes[current]?.name??null,
    current_engine:status.current??null,gateway_port:TOPOLOGY.gateway_port,comfyui_port:TOPOLOGY.runtimes.comfy.port,
    comfyui_engines:TOPOLOGY.runtimes.comfy.engines,
    gateway_queue:'API 与 MCP 共用准入、GPU 租约和引擎合批',
    native_queue:'原生工作流进入 ComfyUI 自身队列；不等同于网关任务记录',
    switching_note:'切到独立 LLM 或生图后端时会等待队列空闲并停止 ComfyUI；ComfyUI 任务再按需启动',
    capabilities_only:!Object.hasOwn(status,'current'),
    ...(status.engine_scheduling?{engine_scheduling:status.engine_scheduling}:{}),
    ...(Object.hasOwn(status,'leased')?{leased:status.leased,queued:status.queued,switching:status.switching}: {})};
}
