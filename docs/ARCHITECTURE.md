# 监控面板与调度技术

[文档目录](README.md)

更新：2026-10-20。部署拓扑与边界见 [当前模式](RUNTIME_TOPOLOGY.md)。

## Next.js 工作台

前端使用 Next.js App Router、React 19、Recharts 与响应式 CSS，源码在 `platforms/workbench/app/`。浏览器每 5 秒读取同源 `/data`，显示模型、任务、设备和 15/30/60 分钟趋势；浏览服务和指标不会加载模型；推理请求自动调度，LLM 配置页可提交配置并重启引擎。

宿主 Node.js 自定义服务器在一个进程中运行 Next.js 和 GPU 调度：13000 页面、18982 推理 API、18990 租约控制。选用常驻进程以共享互斥状态、保持长时间媒体请求、逐块 SSE 传输与退出时排空；必须单实例部署。systemd 只启动一个 `ai-workbench-gateway.service`，旧 dashboard 单元已删除。

Prometheus 保存真实指标，AMD 采集器只读 sysfs。服务端使用固定 PromQL，不开放任意查询。输出吞吐为最近两次采样 token 增量 / 实际间隔，图表与数值卡相同，包含思考和全部并发请求；输入批次尖峰不代表预填充速度。无数据时显示空值。Grafana 与独立 HTML/Python 图表服务已移除。

## GPU 调度

Node.js 单一引擎合批队列与随机租约 token 控制模型互斥。每个引擎声明容量：LLM 按已保存的并发额度共享租约（上限 8 个），TTS 3 路，图像与视频独占；密钥并发只计已持有的租约。分配由入队、释放、取消等事件触发。租约 120 秒，生成期间每 30 秒续期；过期后也要确认后端空闲才可回收。异步状态转换始终由同一进程管理。

切换：参数校验 → 排队 → 两次确认旧后端空闲 → 通过 lab 停止旧容器和启动新容器 → 就绪检查 → 推理转发 → 释放凭证。状态区分当前模型与目标模型；状态未知时保留租约。停止服务拒绝新请求并等待活动和队列排空。

LLM SSE 逐块透传，客户端断连后继续读取上游直到完成，防止 GPU 提前切换。图像与视频保留项目 JSON 协议，PNG 用 base64 输入，H3 上传参考素材、提交内部 ComfyUI 图并等待结果，视频以本地产物路径返回。

实现位于 `platforms/workbench/lib/` 的 `core.mjs`、`backend.mjs`、`http.mjs`、`media.mjs`、`metrics.mjs` 和 `monitoring.mjs`。原 Python 租约客户端继续兼容 18990。任务统计复用原 JSON 文件，不保存提示词。默认冷切换，CPU 驻留仍关闭，预算检查和回退已迁入 Node.js。

验证：`cd platforms/workbench && npm test && npm run build`。测试覆盖引擎合批与公平让出、共享上限、过期忙任务保护、失败恢复、SSE 首块和断连租约、Origin 限制及停服拒绝请求。

## 工作流工具与生命周期

ComfyUI 在 8188 提供原生画布和 GPU 执行，服务检测覆盖全部原生队列与历史，不再转发到另一 ComfyUI，也不调用其他服务 API。API/MCP 共用媒体执行层与调度器；直接画布任务在原生队列查看。Wan、旧 CPU 前端和跨服务画布桥接已下线。能力与后端映射统一维护于 `platforms/runtime-topology.json` 、内部媒体 API Schema 和独立 MCP manifest。

`./lab comfyui sync` 只更新磁盘上的模板库，不重启服务，也不覆盖已打开画布。自定义模板建议另存到“我的工作流”。重复同步不会新增副本，模板文件被用户修改时先保留修改版本再更新。旧模板保留供恢复。

systemd 用户服务负责常驻、开机启动与异常进程恢复；Docker运行独立推理环境。详细服务名与启停方式见 [服务与架构](SERVICES.md)，工作流清单见 [模板说明](../platforms/comfyui/workflows/README.md)。
