# Next.js AI Workbench

当前接口、参数与调用示例见 [API 清单](../../docs/CURRENT_API.md)。

当前面板已按总览、任务中心、模型服务、API、MCP、访问管理组织。运行结构见 [当前模式](../../docs/RUNTIME_TOPOLOGY.md)，接入见 [媒体 MCP](../../docs/MEDIA_MCP.md)。

Next.js App Router、React 19 和 Recharts 构成前端；Node.js 常驻进程同时提供页面、引擎合批 GPU 调度、租约与统一推理 API。调度状态在同一个进程内共享，必须单实例运行，不适合 serverless、多 worker 或多副本部署。

需要 Node.js 22.19 或更新版本；H3 参考视频 API 还需要宿主机 `ffmpeg` 和 `ffprobe`。

```bash
cd platforms/workbench
npm ci
npm run build
npm test
npm start
```

从项目根目录执行 `./lab check` 可同时检查工作台与 Python 组件；仅检查工作台用 `./lab check --suite node`。目录与归档约定见 [开发与整理](../../docs/DEVELOPMENT.md)。

生产服务由 `ai-workbench-gateway.service` 启动 `launch.sh`，该脚本选择 Node.js 22.19+；可用 `WORKBENCH_NODE` 指定解释器。日常入口 `./lab scheduler start|stop|restart|status|logs` 与 `./lab scheduler switch MODEL` 保留。

- `127.0.0.1:13000`：页面、`/data?minutes=15|30|60&model=llm|flux|qwen-image|h3`（`model` 可省略，默认跟随引擎）。
- `127.0.0.1:18982`：原有 `/v1`、`/status`、`/metrics` 和视频产物。
- `127.0.0.1:18990`：原有 `/acquire`、`/renew`、`/release` 和 `/status`。

开发：`npm run dev`。测试环境可通过 `WORKBENCH_PORT`、`INFERENCE_PORT`、`CONTROL_PORT` 与 `WORKBENCH_DATA` 分配端口与状态目录；`WORKBENCH_READ_ONLY=1` 禁止提交和切换请求。

调度器保留单卡互斥、同模型 LLM 最多 8 个共享租约、120 秒有效期、30 秒续期、统一引擎合批与等待老化、两次空闲检查、就绪检查、流式逐块传输与断连后继续持有租约。停止时拒绝新工作并等待租约和队列结束。仍调用各模型现有 `lab` 控制器管理推理容器；Python 仅保留引擎运行、采集器、ComfyUI 节点和外部租约客户端。

任务统计兼容 `workspace/data/scheduler/metrics.json`，最多保留 30 条，不存提示词。Prometheus 提供真实时序；无有效采样显示空值。Grafana 服务与独立 HTML/Python 页面服务已移除，历史数据目录保留。

聊天客户端通过 `/v1/models` 发现固定名称 `qwen38-27b-w3a4`；刷新模型列表即可获取最新应用的上下文长度、并发和推理强度信息。图像和视频目录使用自定义 `/v1/media/models`，生成仍分别调用 `/v1/images/generations`、`/v1/images/edits`、`/v1/videos/generations`。媒体引擎不应添加到 DSH 的聊天模型提供方；DSH 需要通过工具或 MCP 包装调用媒体 API，当前 local-media MCP 已提供九个工具。同步视频接口等待结果；持久任务使用 `/v1/media/jobs`，返回的 `/artifacts/*.mp4` 相对地址需按网关地址解析。

LLM 使用统一引擎（256K 技术上限、最多八路），面板编辑上下文、并发、Eager 和 KV 预算；应用时等待当前任务结束，再按所选配置重载引擎。新请求按实际输入加最大输出量预留 KV。满载预算从启动日志和引擎布局计算；未测得容量显示警告，超预算可以保存。详情见 [统一引擎策略](../../docs/LLM_MODES.md)。

面板采用服务导航与独立的运行监控、模型配置、任务记录标签。默认跟随运行引擎；点击服务只改变浏览范围，不加载或切换引擎。任务与趋势按服务筛选，整卡指标单独标记为共享设备。LLM 的实时值读取实际引擎配置；草稿、已保存配置与实际运行值分别显示。Qwen 配置页与工作台采用统一的石墨灰与淡紫色风格，按任务方案、推理参数、容量预览和应用摘要组织；显存布局明细可展开查看。Qwen 未运行时仍可使用引擎保存的完整布局进行草稿估算，明确标记为历史布局，不作为实时分配或满载验证结果。切换标签或服务不会丢弃当前浏览器中的草稿。

引擎输出通过 `/api/engine-logs?model=llm|flux|qwen-image|h3` 选择服务容器日志（省略 `model` 时跟随引擎）；LLM 额外显示实际配置、目标配置和调度配置事件。日志每 3 秒更新；按容器实例增量读取并缓存，成功健康探测默认隐藏，失败探测、生成与引擎诊断保留。每个容器保留最近 500 行有效输出与 1000 行原始输出，各缓冲区最多约 100 万字符；首次从最近 10000 行初始化，成功探测不会挤掉缓存中的运行日志。可点击“显示健康探测”，或使用 `include_probes=1` 查看原始尾部；`suppressed_probe_lines` 表示该实例缓存观察到的隐藏条数，不是容器总请求数。容器重建后重置输出，读取失败保留已有日志并显示重试提示。日志读取不触发模型启停。离开视口或手动收起后显示悬浮球与新日志摘要；点击展开居中大弹窗。易读视图突出吞吐、执行数、等待数与 KV 采样，警告和错误分别标色，长文本完整换行；指标记录可展开原文，也可整体切换原始文本。支持暂停跟随、级别筛选和复制原始日志。未加载服务的日志标记为历史输出。图像与视频引擎的标准采样进度（步数、步速、预计剩余）和 ComfyUI 执行完成耗时使用独立摘要；未识别的输出保留完整文本，不生成推测指标。媒体配置页按服务说明生成、编辑和帧条件能力；任务记录在窄屏改为带字段标签的卡片。FLUX 支持 Paiton 与 Diffusers 来源。任务方案以卡片内标签页展示，支持直接新增、删除、重命名与修改额度；方案自动保存在当前浏览器，点击应用后提交配置。

独立检查实例可设置 `WORKBENCH_NEXT_DIST` 使用其他 Next.js 构建目录，并配合独立端口、`WORKBENCH_DATA` 与 `WORKBENCH_READ_ONLY=1`，避免影响正式实例的缓存和状态。

吞吐曲线支持 5 / 15 / 30 / 60 秒统计窗口，默认 30 秒；近一分钟的 5 秒采样峰值卡片独立于曲线窗口。输入展示一分钟计数量，采集缺失保留断点。CPU 图像计算使用独立卡片，数据来自视觉服务原生指标，显示编码耗时、缓存、排队、CPU 和容器内存。

生产构建目录由 `~/.config/systemd/user/ai-workbench-gateway.service.d/runtime.conf` 的 `WORKBENCH_NEXT_DIST` 指定。发布时先在独立目录构建，再更新该单一覆盖项并重启空闲网关；不要叠加多个版本覆盖文件。
