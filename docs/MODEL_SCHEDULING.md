# GPU 模型调度

[文档目录](README.md)

更新：2026-10-25（单一队列重写）。当前结构见 [运行模式](RUNTIME_TOPOLOGY.md)：API/MCP 共用调度，五个模型服务；ComfyUI 只承载 H3 原生工作流。

## 请求生命周期

1. API 客户端或 MCP 持久任务服务调用共享执行层；统一 API 地址为 `127.0.0.1:18982`。
2. 网关校验参数、检查请求频率，然后进入唯一的 GPU 队列。凭证按引擎容量发放：LLM 按所选并发共享，TTS 最多 3 路，图像与视频独占。
3. 调度器等待当前请求结束，连续两次确认后端空闲，停止旧 GPU 工作容器。
4. 调用部署入口启动目标容器，等待健康检查和模型就绪。
5. 转发请求；LLM SSE 逐块转发，生成期间凭证持续续期。
6. 请求结束后释放凭证，保留最后一个模型；下一种任务触发下一次切换。

控制端口 `18990` 只负责凭证与状态；推理入口 `18982` 负责请求。W3A4 工作端口已移至 `18983`。当前覆盖 llm、qwen-image、h3、flux、tts。控制端口的 `/acquire` 默认独占整个引擎（维护与测速用），传 `shared: true` 才按容量共享。

```bash
./lab scheduler status
./lab scheduler switch llm
./lab scheduler switch h3
```

常驻服务与完整架构见 [服务说明](SERVICES.md)。手动模型启停入口仍保留用于维护；不要在有活动、排队或切换任务时执行 `./lab stop`。绕过统一 API、直接访问后端、手动启停或外部 GPU 进程不受完整互斥保证。后端状态未知时拒绝强停；过期凭证也需验证空闲才能回收。

## 统一引擎调度策略

配置：`platforms/scheduler/scheduling.json`，修改后重启网关生效。覆盖 `llm`、`qwen-image`、`flux`、`h3`、`tts`；API、MCP 的 GPU 租约经过同一个 Coordinator；直接画布任务只在 ComfyUI 原生队列中管理。GPU 直接访问仍无法参与排队。

| 参数 | 当前值 | 作用 |
| --- | --- | --- |
| `minBatchRequests` | 2 | 有同引擎积压时，优先完成一个小批次，避免多个已老化队列每执行一次就来回切换；时间预算到达时可提前结束 |
| `maxBatchRequests` | 4 | 存在其他等待引擎时，当前批次达到该请求数便让出后续租约 |
| `maxBatchSeconds` | 120 | 引擎就绪后起算；存在其他引擎时，到达时长预算便停止向本引擎发新租约 |
| `maxWaitSeconds` | 300 | 其他引擎等待达到该阈值，在小批次完成后优先切换 |

同一引擎保留入队顺序；跨引擎优先复用已加载引擎。达到批次、时间或老化阈值后，选择最早等待的其他引擎，并按同样规则处理一批。当前引擎没有积压时立即选择最早等待引擎，不为凑批次空等。没有其他引擎等待时可以继续服务当前引擎。

这些阈值决定下一次发放租约，**不是完成时间保证**：正在生成的任务不抢占，先等待活动租约与后端任务结束，再切换。一次长视频可以超过时间预算。LLM 要让出 GPU 时停止补充同引擎租约，等待已有并发请求排空。冷启动时间不消耗新引擎的时间预算，等待老化时间则包含入口等待。

共享密钥并发为 1 时也会合批：例如正在执行 LLM，后续按 FLUX、LLM、Qwen-Image、FLUX、LLM、Qwen-Image 到达，会处理为 LLM × 3 → FLUX × 2 → Qwen-Image × 2；该示例假定未达到时间与老化阈值。

### 单一队列与容量

2026-10-25 起，密钥入口队列并入 Coordinator，每个生成请求只排一次队、只有一个超时（持有密钥的同步请求为 `queueWaitSeconds`，持久媒体任务 1800 秒，本机可信调用 900 秒）。

| 层 | 含义 | 来源 |
| --- | --- | --- |
| 引擎容量 | 一个已加载实例能同时处理的请求数 | LLM：面板并发（上限 8）；其他：`runtime-topology.json` 的 `concurrency`（TTS 3，未设为 1） |
| 密钥并发 | 该密钥同时持有的租约数，排队不占用 | 密钥 `maxConcurrent`；全局 `maxConcurrent` 限制所有密钥合计 |
| 密钥等待 | 执行中 + 等待中 ≤ 并发 + 等待名额，超出立即 429 | 密钥与全局 `maxQueued` |

分配时先按合批规则选引擎，只在密钥与全局都有空余名额的请求中选择；同一引擎内持有租约最少的密钥先得到空位，再按到达顺序。入队、释放、取消、加载完成、密钥变更都会立即触发分配；每秒一次的定时检查只用于回收过期租约。不能借合批突破并发、RPM、KV、单卡互斥限制。LLM 请求拿到租约后再分词并等待 KV 容量，这段时间仍占用该密钥的并发名额。

为识别引擎，鉴权后先读取并校验生成请求 JSON，再入队。每份正文仍最多 32 MiB；所有持有密钥的生成请求正文按原始大小合计预留最多 64 MiB（活动任务也计入，未知长度按 32 MiB 预留，JSON 解码实际内存会高于原始字节）。超出返回独立的 `ADMISSION_BODY_BUDGET_EXCEEDED`，读取中请求数量也受执行加等待名额约束。正文资源在任务退出后释放。

`/status` 的 `engine_scheduling` 给出策略、当前批次请求数/持续时间、队列各引擎数量、下一候选引擎及选择原因；`lease_capacity` 为当前引擎的容量。`batch_request_limit`、`batch_time_limit`、`waiting_engine_aged` 分别说明本次让出的原因。

验证：`tests/engine-scheduling.test.mjs` 覆盖五引擎合批、同引擎顺序、三个让出条件、老化防抖与忙任务保护；`tests/admission-queue.test.mjs` 覆盖排队不占密钥并发、引擎容量与密钥间公平分配、溢出错误码、超时/取消/吊销、本机调用不受密钥限额，以及共享密钥并发 1 的真实 HTTP 处理链路、正文预算和断连清理。测试后端为桩，不代表实测冷启动提速。2026-10-16 回归 101/101 通过；生产网关已重载，临时并发 1 密钥的两个短 LLM 请求均返回 200，等待异步空闲检查后租约、入口队列与正文预留全部归零，临时密钥已删除。验收记录：`workspace/reports/engine-scheduling-validation.json`。

## 内存驻留与重载

当前策略是停止容器后重新加载，尚未启用 CPU 权重驻留。Linux 文件页缓存可减少磁盘读取，但框架初始化、权重准备、GPU 传输和预热仍需重做。

本机约 94 GiB 系统内存，2026-10-12 检查可用约 76 GiB。容量适合评估一个热点模型的内存驻留，不能据此保证全部模型常驻。

vLLM 的 [Sleep Mode](https://docs.vllm.ai/en/latest/features/sleep_mode/) level 1 可把权重转存 CPU 内存、丢弃 KV 缓存，唤醒时恢复。官方支持 HIP/ROCm 路径，但本机 vLLM 0.29.0 带 Paiton W3A4 插件，现启动配置未启用休眠；还需验证插件权重、分配器、图捕获与实际显存释放。H3、Qwen-Image、FLUX 的生命周期接口各异，不能用 Docker pause 代替卸载；暂停不会释放显存。

已开发 LLM sleep/wake 调度适配、驻留状态、内存预算、失败冷启动回退与独立测试脚本。配置位于 `platforms/scheduler/residency.json`，当前 `enabled: false`；尚未通过完整模型验收，不启用到日常推理。图像、视频后端仍采用冷切换。

2026-10-12 实测：16 MiB 权重池数据休眠 / 唤醒校验通过，约 0.19 / 0.12 秒。完整 W3A4 模型在 ROCm 虚拟显存读取标量时发生段错误；暂存兼容补丁已让权重加载继续完成，但后续预热仍有同类错误。私有显存池另与原启动器的 `per_process_memory_fraction` 限额冲突。以上是分配器兼容性问题，不能用小块数据成功推断完整模型可用，也不能据此宣称模型切换加速。

诊断记录：`workspace/reports/llm-residency-allocator-check.json`、`llm-residency-scalar-staging.log`、`llm-residency-private-pool-budget.log`、`llm-residency-final-load.log`。开发补丁只注入显式实验启动的容器，正常启动继续使用原运行时。重测入口：`.workbench/scripts/test-llm-residency.py`，测试会短暂替换 LLM 容器；仅在维护时运行。

实验失败后已恢复原稳定启动配置，统一 API 实际输出 `4`，ComfyUI 与监控健康，调度无活动凭证、无排队。恢复验收：`workspace/reports/llm-residency-recovery-check.json`。测试脚本现会在失败或中断时、释放独占凭证之前恢复正常 LLM 并检查推理；恢复失败会明确写入报告。19 项调度测试与 22 项工作台测试通过。

## 验证与能力边界

- H3 → LLM 自动切换及 8 路流式请求：`workspace/reports/api-llm-concurrency.json`。
- 两图编辑：`workspace/reports/api-multiple-references.json`。
- 两参考图 → 生成首帧 → H3 视频：`workspace/reports/api-reference-to-video-workflow.json`。
- 调度测试：`cd platforms/workbench && npm test`；驻留辅助工具：`python3 -m unittest discover -s platforms/scheduler/tests -v`。

IMAGE 批次、列表和独立参考图可接 Qwen 多图编辑节点；视频后端接受首帧，H3 另支持首尾帧。任意角色一致性、图像编辑保真度与所有第三方节点组合仍需单独验收。

直接 H3 画布任务不经过网关准入；它们使用 ComfyUI 原生队列，后端切换前会检查队列空闲。它们不自动拥有持久媒体 job_id。统一追踪应通过 API/MCP 提交，不能把原生画布工作都计入网关全局队列。
