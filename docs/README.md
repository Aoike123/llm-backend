# 项目文档

[返回项目首页](../README.md)

## 阅读顺序

0. 当前结构：[运行与调度模式](RUNTIME_TOPOLOGY.md)（API/MCP、H3 与面板的统一依据）。
1. 初次了解：[项目现状](PROJECT_STATUS.md) → [安装与运维](OPERATIONS.md)。
2. 调用模型：[API 参考](CURRENT_API.md)；使用图形工作流见 [ComfyUI](../platforms/comfyui/README.md) 与 [模板目录](../platforms/comfyui/workflows/README.md)。
3. 调整 LLM：[上下文与并发配置](LLM_MODES.md)。
4. 排查或开发：[服务说明](SERVICES.md) → [实现架构](ARCHITECTURE.md) → 对应组件 README。

## 使用与运维

| 文档 | 内容 |
|---|---|
| [项目现状](PROJECT_STATUS.md) | 可用部署、能力边界、待验收事项和证据入口 |
| [安装与运维](OPERATIONS.md) | 首次安装、服务管理、手动维护、检查与复现 |
| [容器存储与空间维护](CONTAINER_STORAGE.md) | Docker/containerd 数据分区、迁移记录、构建层优化与清理边界 |
| [ComfyUI 工作流清单](COMFYUI_WORKFLOWS.md) | 8 个 H3 原生工作流的分类、执行方式与运行条件 |
| [H3 多参考编码](H3_REFERENCE_ENCODE.md) | 6 图 × 1.5MP 的 OOM 边界、分块注意力修复、视觉塔与节点缓存、分阶段实测与未采用方案 |
| [接口与控制台结构](INTERFACES.md) | MCP 工具面、API 路由分组、控制台区块与跳转、调用规范 |
| [API 参考](CURRENT_API.md) | 对外模型名、路由、参数、示例和错误码 |
| [公网 API](PUBLIC_API.md) | 公网服务器、反向 SSH 隧道、HTTPS 与密钥鉴权 |
| [LLM 配置](LLM_MODES.md) | 上下文、并发、Eager、KV 预算、应用流程及历史容量 |
| [服务说明](SERVICES.md) | systemd 单元、端口、容器、目录及启动原理 |
| [引擎目录](ENGINES.md) | 部署注册、命名和兼容命令 |
| [模型资源](MODELS.md) | 文本权重来源、NVMe 副本、校验和备选模型 |
| [W3A4 部署](pation-model-qwen38-27b-w3a4.md) | 部署入口、运行时、客户端设置及历史基础验证 |

## 实现与组件

| 文档 | 内容 |
|---|---|
| [媒体 MCP](MEDIA_MCP.md) | stdio 接入、媒体工具和任务管理 |
| [实现架构](ARCHITECTURE.md) | 工作台进程、指标、GPU 调度与工作流生命周期 |
| [开发与整理](DEVELOPMENT.md) | 目录职责、统一测试入口、构建产物与归档恢复 |
| [模型调度](MODEL_SCHEDULING.md) | 请求生命周期、互斥边界和未启用的内存驻留实验 |
| [工作台](../platforms/workbench/README.md) | 开发、构建、部署、配置页面与日志 |
| [调度辅助工具](../platforms/scheduler/README.md) | 租约客户端与驻留实验配置 |
| [原生工作流与模型挂载](COMFYUI_NATIVE.md) | H3/Wan 完整原生图、图像 API 边界、执行与挂载路径 |
| [公共 ComfyUI](../platforms/comfyui/README.md) | API 节点、多参考图及工作流使用 |
| [工作流模板](../platforms/comfyui/workflows/README.md) | 模板清单、同步及自定义工作流 |
| [监控](../platforms/monitoring/README.md) | 指标采集、吞吐统计与 CPU 视觉指标 |

各引擎的启动和配置说明位于对应 `engines/` 子目录的 README，入口见 [引擎目录](ENGINES.md)。

## 评测与验证

| 文档 | 范围 |
|---|---|
| [评测协议](EVALUATION.md) | vLLM、lm-evaluation-harness、GenEval、VBench 的运行方法与验收状态 |
| [媒体验证结果](MEDIA_RESULTS.md) | 2026-10-12 图像、视频请求耗时及画质限制 |
| [单路吞吐诊断](LLM_PERFORMANCE_DIAGNOSIS.md) | 2026-10-12 测速与 DFlash 策略 A/B，属于历史配置 |
| [CPU 视觉实现](CPU_VISION_DESIGN.md) | 已接入路径、设计依据、混合负载实测及后续验证 |

原始输出、日志和报告保存在 `workspace/reports/`；生成作品保存在 `workspace/outputs/`。不同日期、配置或计时范围的数字不能直接合并为当前性能结论。

## 研究与历史

| 文档 | 状态 |
|---|---|
| [上下文分层存储](CONTEXT_TIERING_DESIGN.md) | 研究方案，未实施活动 KV 卸载 |
| [本机媒体 MCP](MEDIA_MCP.md) | stdio 接入、11 个媒体与任务工具（含语音）、家目录存储、Workbench 信息页 |
| [媒体 MCP 设计](MEDIA_MCP_PLAN.md) | 架构方案与后续远程阶段 |
| [H3 混合参考可行性](H3_REFERENCE_FEASIBILITY.md) | Ref2VA调研与2026-10-19接入：公共API、原生模板、9图+3视频及动态卸载验证 |
| [本机初始选型](DEVICE_PLAN.md) | 2026-10-11 的选型快照，部署状态已由项目现状更新 |
| [虚拟主播与数字人](DIGITAL_HUMAN.md) | 2026-10-19 调研：AI 主播、写实数字人、全身跳舞三条路线的技术栈、AMD 可行性、推流链路与落地顺序；未接入本机服务 |
| [ROCm 10.1 升级记录](rocm101-upgrade.md) | 宿主与容器迁移过程及当轮验证结果 |
| [TTS 选型调研](TTS_OPTIONS.md) | ROCm 下的 TTS 选型记录；已接入 CosyVoice 3 RL |

## 维护约定

- 首页提供项目简介、快速入口和导航；详细内容维护在对应专题文档。
- API 路由与参数维护在 `CURRENT_API.md`；LLM 策略维护在 `LLM_MODES.md`；服务名和端口维护在 `SERVICES.md`。其他文档链接到它们，避免复制动态配置。
- 区分技术上限、已保存配置、实际运行配置与实测结果。运行状态通过 `/status` 查询，已保存的聊天额度通过 `/v1/models` 查询。
- 测试记录注明日期、配置、计时范围、证据位置和未覆盖的边界；研究方案注明实施状态。
- 项目内使用相对链接；保留现有文件名及原始报告路径，便于已有引用继续使用。
