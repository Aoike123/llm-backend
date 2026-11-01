// Runtime topology is derived from the enabled engine packages on every read, so enabling or
// disabling an engine in the console takes effect without a restart.
import {PLATFORM,registry} from './registry.mjs';
export const TOPOLOGY={...PLATFORM,get runtimes(){return registry.runtimes();}};
export const runtimeFor=engine=>Object.entries(TOPOLOGY.runtimes).find(([,runtime])=>runtime.engines.includes(engine))?.[0]??null;
export const sameRuntime=(a,b)=>a===b||(runtimeFor(a)!==null&&runtimeFor(a)===runtimeFor(b));
// Media engines whose single resident model serves several leases at once (LLM sharing follows its own policy).
export const sharedEngines=()=>Object.fromEntries(Object.values(TOPOLOGY.runtimes).filter(runtime=>runtime.concurrency>1).flatMap(runtime=>runtime.engines.map(engine=>[engine,runtime.concurrency])));
export const modelBackends=()=>Object.fromEntries(Object.values(TOPOLOGY.runtimes).flatMap(runtime=>runtime.engines.map(engine=>[engine,[[...runtime.launch],runtime.port,runtime.container]])));
// The runtime that hosts the native ComfyUI canvas, when one is enabled.
export const nativeRuntime=()=>Object.entries(TOPOLOGY.runtimes).find(([,runtime])=>runtime.native_ui)??null;
export const comfyBase=()=>{const native=nativeRuntime();return native?'http://127.0.0.1:'+native[1].port:null;};
export function runtimeTopology(status={}) {
  const current=runtimeFor(status.current),runtimes=TOPOLOGY.runtimes,native=nativeRuntime();
  return {mode:TOPOLOGY.mode,label:'单卡按需切换 · API / MCP 统一调度'+(native?' · ComfyUI 原生工作流':''),
    current_runtime:current,current_runtime_name:runtimes[current]?.name??null,
    current_engine:status.current??null,gateway_port:TOPOLOGY.gateway_port,comfyui_port:native?.[1].port??null,
    comfyui_engines:native?.[1].engines??[],
    gateway_queue:'API 与 MCP 共用准入、GPU 租约和引擎合批',
    native_queue:'原生工作流进入 ComfyUI 自身队列；不等同于网关任务记录',
    switching_note:'切换到其他引擎时会等待队列空闲并停止当前运行时；目标引擎按需启动',
    capabilities_only:!Object.hasOwn(status,'current'),
    ...(status.engine_scheduling?{engine_scheduling:status.engine_scheduling}:{}),
    ...(Object.hasOwn(status,'leased')?{leased:status.leased,queued:status.queued,switching:status.switching}: {})};
}
