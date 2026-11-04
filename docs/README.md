# 项目文档

[返回项目首页](../README.md)

按用途分目录。先看最左一列的目录名，再进对应文档。

| 目录 | 谁来读 | 内容 |
|---|---|---|
| [guide/](guide/) | 使用和运维本机的人 | 现状、安装与运维、服务与端口、LLM 配置、开发与测试 |
| [api/](api/) | 调用接口的人和 agent | HTTP API、公网接入与密钥、MCP、接口分组 |
| [design/](design/) | 改平台代码的人 | 运行拓扑、实现架构、调度、引擎包规范 |
| [runtime/](runtime/) | 管容器、存储和模型文件的人 | 存储布局、容器空间、运行时镜像、ComfyUI、模型资源 |
| [engine-notes/](engine-notes/) | 调某个引擎的人 | 单个引擎或组件的部署记录与专项实现说明 |
| [evaluation/](evaluation/) | 做评测的人 | 评测协议与验收状态 |
| [archive/](archive/) | 查历史的人 | 调研、研究方案、升级记录；不代表当前实现 |

## 常用入口

- 第一次了解：[项目现状](guide/PROJECT_STATUS.md) → [安装与运维](guide/OPERATIONS.md)
- 调用模型：[API 参考](api/CURRENT_API.md)；对外开放见 [公网 API](api/PUBLIC_API.md)；MCP 见 [媒体 MCP](api/MEDIA_MCP.md)
- 调整聊天模型：[LLM 配置](guide/LLM_MODES.md)
- 排查：[服务说明](guide/SERVICES.md) → [实现架构](design/ARCHITECTURE.md)
- 接入新引擎：[引擎目录](design/ENGINES.md)

## guide/ 使用与运维

| 文档 | 内容 |
|---|---|
| [项目现状](guide/PROJECT_STATUS.md) | 可用部署、能力边界、待验收事项和证据入口 |
| [安装与运维](guide/OPERATIONS.md) | 首次安装、服务管理、手动维护、检查与复现 |
| [服务说明](guide/SERVICES.md) | systemd 单元、端口、容器、目录及启动原理 |
| [LLM 配置](guide/LLM_MODES.md) | 上下文、并发、Eager、KV 预算、应用流程及历史容量 |
| [开发与整理](guide/DEVELOPMENT.md) | 目录职责、统一测试入口、构建产物与归档恢复 |

## api/ 接口

| 文档 | 内容 |
|---|---|
| [API 参考](api/CURRENT_API.md) | 对外模型名、路由、参数、示例和错误码 |
| [公网 API](api/PUBLIC_API.md) | 公网服务器、反向 SSH 隧道、密钥与限额、公网放行开关 |
| [媒体 MCP](api/MEDIA_MCP.md) | stdio 接入、媒体工具和任务管理 |
| [接口与控制台结构](api/INTERFACES.md) | MCP 工具面、API 路由分组、控制台区块与跳转、调用规范 |

## design/ 设计与实现

| 文档 | 内容 |
|---|---|
| [运行与调度模式](design/RUNTIME_TOPOLOGY.md) | API/MCP、H3 与面板共同依据的当前结构 |
| [实现架构](design/ARCHITECTURE.md) | 工作台进程、指标、GPU 调度与工作流生命周期 |
| [模型调度](design/MODEL_SCHEDULING.md) | 请求生命周期、互斥边界和未启用的内存驻留实验 |
| [引擎目录](design/ENGINES.md) | 引擎包注册、命名、`platform.surface`、接入新引擎 |

组件说明：[工作台](../platforms/workbench/README.md) · [MCP](../platforms/mcp/README.md) · [调度辅助](../platforms/scheduler/README.md) · [监控](../platforms/monitoring/README.md)。各引擎的启动和配置说明在对应 `engines/` 子目录的 README，入口见 [引擎目录](design/ENGINES.md)。

## runtime/ 存储与运行时

| 文档 | 内容 |
|---|---|
| [存储](runtime/STORAGE.md) | 作品、任务状态与引擎数据的位置，作品盘离线行为，迁移记录 |
| [容器存储与空间维护](runtime/CONTAINER_STORAGE.md) | Docker/containerd 数据分区、迁移记录、构建层优化与清理边界 |
| [运行时镜像](runtime/RUNTIME_IMAGES.md) | 镜像配方注册、单层构建、共享 ROCm SDK、升级与回滚 |
| [ComfyUI 运行时](runtime/COMFYUI.md) | H3 与 Anima 共用的按需 ComfyUI：启停、目录、挂载、模板 |
| [模型资源](runtime/MODELS.md) | 文本权重来源、NVMe 副本、校验和备选模型 |

## engine-notes/ 引擎与组件专项

| 文档 | 内容 |
|---|---|
| [W3A4 部署](engine-notes/pation-model-qwen38-27b-w3a4.md) | 部署入口、运行时、客户端设置及历史基础验证 |
| [H3 多参考编码](engine-notes/H3_REFERENCE_ENCODE.md) | 多图高分辨率的 OOM 边界、分块注意力修复、缓存与分阶段实测 |
| [CPU 视觉实现](engine-notes/CPU_VISION_DESIGN.md) | 已接入路径、设计依据、混合负载实测及后续验证 |

## evaluation/ 评测

| 文档 | 范围 |
|---|---|
| [评测协议](evaluation/EVALUATION.md) | vLLM、lm-evaluation-harness、GenEval、VBench 的运行方法与验收状态 |

原始输出、日志和报告保存在 `workspace/reports/`。不同日期、配置或计时范围的数字不能直接合并为当前性能结论。

## archive/ 研究与历史

| 文档 | 状态 |
|---|---|
| [上下文分层存储](archive/CONTEXT_TIERING_DESIGN.md) | 研究方案，未实施活动 KV 卸载 |
| [虚拟主播与数字人](archive/DIGITAL_HUMAN.md) | 2026-10-19 调研，未接入本机服务 |
| [ROCm 10.1 升级记录](archive/rocm101-upgrade.md) | 宿主与容器迁移过程及当轮验证结果 |
| [引擎平台化](archive/ENGINE_PLATFORM.md) | 能力 / 引擎包 / 主推与降级的设计与实施记录；现行规范以 [引擎目录](design/ENGINES.md) 为准 |

## 维护约定

- 每类信息只在一处维护，其他文档链接过去，不复制动态配置：API 路由与参数 → `api/CURRENT_API.md`；公网放行与密钥 → `api/PUBLIC_API.md`；LLM 策略 → `guide/LLM_MODES.md`；服务名和端口 → `guide/SERVICES.md`；引擎包规范 → `design/ENGINES.md`。
- 区分技术上限、已保存配置、实际运行配置与实测结果。运行状态通过 `/status` 查询，已保存的聊天额度通过 `/v1/models` 查询。
- 测试记录注明日期、配置、计时范围、证据位置和未覆盖的边界；研究方案注明实施状态。
- 新文档放进上表对应目录并在这里登记；过时的设计或记录移入 `archive/`，不要留在原目录。
- 项目内使用相对链接，移动文件后检查链接是否仍然有效。
