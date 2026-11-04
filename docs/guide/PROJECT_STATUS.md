# 项目现状

文档整理：2026-11-02。当前模式以 [运行与调度](../design/RUNTIME_TOPOLOGY.md) 为准；历史评测记录继续保留。

## 日常使用

通过 API / MCP 提交任务，网关按能力路由与 `model` 自动排队、准备 GPU 后端并转发。ComfyUI 画布按需启动，画布任务进入 ComfyUI 自身队列。单卡按需切换部署，最后使用的模型保持运行。

| 入口 | 地址 | 说明 |
|---|---|---|
| 工作台 | [127.0.0.1:13000](http://127.0.0.1:13000/) | 总览、任务、模型服务、API、MCP 与访问管理 |
| ComfyUI | [127.0.0.1:8188](http://127.0.0.1:8188/) | H3 / Anima 原生画布；先 `./lab comfyui start` |
| 统一 API | `http://127.0.0.1:18982/v1` | 聊天、图像、视频与音频 |

服务仅监听回环地址。公网及持久媒体任务需要有效密钥；本机同步调用保留可信兼容路径，详见 API。聊天采用 OpenAI 风格并支持 SSE，媒体采用项目 JSON 协议。首次加载、跨模型切换和视频生成需要较长超时。

调用格式见 [API 参考](../api/CURRENT_API.md)，首次安装和日常命令见 [安装与运维](OPERATIONS.md)。

## 部署与能力

| API model | 已有能力与验证 | 主要限制 |
|---|---|---|
| `qwen38-27b-w3a4` | 文本、思考、CPU 视觉；已有长上下文与混合并发记录 | 技术上限 256K、并发上限 8；实际额度由面板配置，满载能力依赖 KV 预算 |
| `qwen-image21` | 文生图、透明图、单图/多参考图编辑 | 编辑纹理保真和角色一致性仍待验收 |
| `anima` | ComfyUI 原生文生图（Turbo / Aesthetic）与图生图重绘；2026-10-25 模板实测通过 | 动漫/插画风格；编辑只做单图重绘；非商用模型许可 |
| `minimax-h3` | FL2VA文生/首尾帧；Ref2VA多图、参考视频与混合参考，含音频 | 最多9图+3视频；视频总参考时长≤15秒。单图20步864×480/15.08秒753.71秒、峰值21.17GiB；9图+3视频20步864×480/15.08秒1345.96秒、峰值22.935GiB；人物保真度仍需验收 |

另有三个音频引擎（Drama 3 合成、BS-RoFormer 分离、Qwen3-ASR 识别），见 [引擎目录](../design/ENGINES.md)。MCP 按已启用引擎生成 `generate_image`、`generate_video`、`generate_speech`、`register_voice`、`process_audio` 五个生成类工具，另有 `browse_media`、音色库和任务等公共工具，共 14 个。FLUX.2 klein 已于 2026-11-02 下线。

ComfyUI 是 H3 与 Anima 共用的按需运行时，发布 7 个 H3 模板、金鱼原版和 3 个 Anima 模板，详见 [ComfyUI 运行时](../runtime/COMFYUI.md)。

## 当前运行策略

- LLM 使用固定模型名 `qwen38-27b-w3a4`。上下文、并发、Eager 和 KV 预算由面板配置，应用时等待已有任务结束并重启引擎；模型元数据发布已保存额度。
- CPU 视觉已接入，默认思考强度为 `medium`，关闭思考使用 `reasoning_effort: "none"`。主模型输出头使用 BF16，主干仍为 W3A4。
- 默认 KV 预算：上下文 ≤64K 为 8,859,648,000 字节，长上下文为 8 GiB；可通过面板自定义。每路额度乘并发不保证能同时满载。
- CPU 权重驻留保持关闭（`platforms/scheduler/residency.json` 的 `enabled: false`）。完整模型预热未通过，日常使用停止容器后冷加载。
- 活动 KV 的 RAM/GPU 分层仍属研究，未启用。

配置及容量解释见 [LLM 配置](LLM_MODES.md)，冷切换与驻留实验见 [模型调度](../design/MODEL_SCHEDULING.md)。

## 验证与待完成事项

| 项目 | 已有证据 | 尚未完成 |
|---|---|---|
| LLM 功能 | 基础聊天、算术、代码、历史长上下文及混合并发测试 | 当前配置的满上下文多路负载与长期稳定性 |
| LLM 性能 | vLLM 四档共 32/32 请求通过；CPU 视觉混合负载与 DFlash A/B 有记录 | 单路约 200 token/s 目标未验收；整批吞吐不能当作单路速度 |
| LLM 标准能力 | GSM8K 两样本 API 链路通过 | 全量标准能力成绩 |
| 图像 | 文生图、透明图、编辑与组合流程通过 | 编辑保真、角色一致性；GenEval 检测评分环境 |
| 视频 | H3 生成及两段视频四维 VBench（含已下线的 Wan）；H3 Ref2VA参考图、视频、原生混合参考与9图+3视频实际生成；2026-10-23 修复多参考文本编码 OOM，6图×1.5MP 通过（参考编码约371秒） | 完整VBench排名、真实人物与复杂多参考一致性；视觉塔约40秒/张尚未优化 |
| 运行稳定性 | 升级后的有限测试未观察到新的 GPU 页错误或重置 | 长期稳定性；此前桌面闪屏根因 |

## 证据与后续阅读

- [W3A4 部署记录](../engine-notes/pation-model-qwen38-27b-w3a4.md)：基础推理、模型挂载与客户端配置。
- [H3 多参考编码](../engine-notes/H3_REFERENCE_ENCODE.md)：32GB 显存边界、分块注意力修复、编码分阶段实测与未采用方案。
- [LLM 配置](LLM_MODES.md)：2026-10-14 重启方案与历史容量边界。
- [CPU 视觉实现与实测](../engine-notes/CPU_VISION_DESIGN.md)：特征对照、图片请求及混合并发。
- [评测协议](../evaluation/EVALUATION.md)：媒体与 LLM 工具链状态。
- [模型调度](../design/MODEL_SCHEDULING.md)：驻留失败及恢复报告。
- [服务说明](SERVICES.md) / [实现架构](../design/ARCHITECTURE.md)：常驻服务与单进程调度。

[完整文档目录](../README.md)

