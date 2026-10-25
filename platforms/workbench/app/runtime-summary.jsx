export default function RuntimeSummary({topology:t}){
  if(!t)return null;
  return <details className="runtime-summary mcp-card">
    <summary><strong>{t.label}</strong><span className="muted">{t.switching?'正在切换':t.current_runtime_name??'待机'} · 网关排队 {t.queued??'—'}</span></summary>
    <dl className="mcp-details">
      <div><dt>当前后端</dt><dd>{t.current_runtime_name??'暂无运行后端'}{t.current_engine?' · 调度键 '+t.current_engine:''}。运行后端不代表全部权重已加载。</dd></div>
      <div><dt>API / MCP</dt><dd>{t.gateway_queue}。MCP 使用持久化媒体任务；同步 API 等待结果。</dd></div>
      <div><dt>原生画布</dt><dd>{t.native_queue}。执行状态和作品以 ComfyUI 队列、历史为准。</dd></div>
      <div><dt>后端生命周期</dt><dd>{t.switching_note}。原生工作流共用 ComfyUI 队列，检测不区分模型或节点类型。</dd></div>
    </dl>
  </details>;
}
