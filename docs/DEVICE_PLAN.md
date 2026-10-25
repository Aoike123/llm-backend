# 本机初始选型（历史）

[文档目录](README.md)

> 状态：2026-10-11 部署前的选型快照。下文的“待验证”、8K 默认和推荐顺序描述当时状态；当前能力见 [项目现状](PROJECT_STATUS.md)，实际 LLM 配置见 [配置说明](LLM_MODES.md)。

整理日期：2026-10-11。推荐顺序基于博客、已锁定的官方源码及本机模型清单；没有本机 GPU 实测成绩。

## 设备与筛选依据

- Ubuntu 24.04；双路 Xeon E5-2696 v4，44 物理核心、88 线程；约 94 GiB 系统内存。
- 单张 AMD 显卡，PCI ID `1002:7551`，约 32 GB 显存，与 Radeon AI PRO R9700 配置相符。官方包需要 `gfx1201`；仍需容器内 HIP 验证型号、架构和可用显存。
- 项目所在 NVMe 分区检查时约有 662 GiB 可用；资源盘是 `fuseblk`。
- Qwen3.8 NVFP4 主模型、DFlash2 FP8 草稿、W3Rot INT3 overlay 已接入；91 个归档文件通过 SHA-256 检查。
- Docker / 用户权限及模型容器运行仍待宿主机验证。先前配置检查和 dry-run 不能代替实际推理。

官方社区包针对单张 R9700 测试，与你的硬件配置高度相符；双卡和 Instinct 数据中心方案另外筛选。见 [官方项目要求](https://github.com/Eliovp-BV/paiton-vllm-plugin#requirements)。

## 推荐组合

| 顺序 | 类别与方案 | 本机用途 | 限制与现状 | 项目入口 |
| --- | --- | --- | --- | --- |
| 1 | 文本：Qwen3.8 27B MXFP4 + DFlash2 | 主力聊天、代码、能力基准 | 权重已齐；先使用保留桌面显存的配置 | `./lab pation-model-qwen38-27b-mxfp4 start` |
| 1 | 文本：同模型 W3A4 / INT3 | 用于对照速度、日常代码任务 | overlay 已齐；部分知识评测准确度低于 MXFP4，需要本机对照 | `./lab pation-model-qwen38-27b-w3a4 start w3a4` |
| 2 | 图像：FLUX.2 klein 4B | 快速提示词迭代、概念图、1024 方图 | 已有启动配置；需要准备图像权重 | `./lab pation-model-flux2-klein start` |
| 3 | 视频：FastWan FullAttn 5B | 快速无声文生视频预览 | 先测 480 级别、2 秒，再提高到 720 级别和 5 秒；图像输入未获该 preset 资格验证 | 已下线（2026-10-20） |
| 4 | 图像：Qwen-Image 2.1 原版 MXFP4 | 2048 图像、RGBA、图像编辑 | 加载前至少需要 30 GiB 空闲显存；桌面占用可能阻止加载 | `./lab pation-model-qwen-image-21 start` |
| 5 | 视频：Wan2.2 TI2V-5B | 图生视频、无声文生视频 | 480 级别；base 图生视频默认 stock，不能套用 FastWan 的性能结论 | 已下线（2026-10-20） |
| 6 | 视频：MiniMax H3 Turbo8 | 带原生声音的短片，首／尾帧条件 | 先验证约 5 秒短片，再测约 15 秒；长片接近显存上限 | `./lab pation-model-minimax-h3 start` |

文本选择依据：[Qwen3.8 单卡 W3A4 博客](https://eliovp.com/blog/paiton-qwen38-w3a4-radeon-ai-pro-r9700)。当前锁定的 [单卡启动指南](../engines/shared/paiton/upstream/models/Qwen3.8-MXFP4-DFlash2/README.md) 比 9 月博客提供了更多长上下文模式；不同日期的缓存格式和速度测量不能混用。

图像依据：[FLUX 博客](https://eliovp.com/blog/paiton-flux2-klein-radeon-ai-pro-r9700)、[Qwen-Image 博客](https://eliovp.com/blog/paiton-qwen-image-21-radeon-ai-pro-r9700)。视频依据：[单卡 Wan / FastWan 指南](../engines/shared/paiton/upstream/models/Wan2.2/README.md)、[MiniMax H3 博客](https://eliovp.com/blog/paiton-minimax-h3-radeon-ai-pro-r9700)。推荐顺序是针对本机已有模型、显存余量和验证成本的判断。

## 发布者性能记录：用于选型，不是本机速度承诺

| 方案 | 测试设置 | 发布者结果 | 计时／证据范围 |
| --- | --- | --- | --- |
| FLUX | 1024×1024、4 步、batch 1 | 暖态约 1.054 秒；最大采样驱动显存约 14.6 GiB | 提示词到 PIL 图像；不含 PNG 编码、文件保存及浏览器展示 |
| Qwen-Image | 2048×2048、40 步、guidance 1 | v1.0.2 暖态 HTTP 请求到 PNG 返回约 103.29 秒 | 下载、冷启动另算；当前项目 v1.0.3 不能视为本机已复现该数字 |
| FastWan | 832×480、49 帧，约 2 秒视频 | 暖态完整片段约 8.843 秒 | 锁定仓库的局部候选记录，少量固定提示词；不是公开博客中的 A14B 测试 |
| FastWan | 1280×704、121 帧，约 5 秒视频 | 暖态约 50.109 秒 | 含片段输出；“720 级别”不是严格的 1280×720 |
| MiniMax H3 | 864×480、362 帧、Turbo8，约 15 秒视频 | 完整 MP4 暖态平均约 332.85 秒 | 包含声音、编码和保存；一个提示词、两次正式测量 |

FLUX 和 Qwen-Image 的范围见对应博客；FastWan 原始表见 [已锁定的评测记录](../engines/shared/paiton/upstream/models/Wan2.2/BENCHMARKS.md)；H3 范围见对应博客。不同阶段的耗时不能直接横向比较。你的 Xeon 平台、驱动、桌面显存占用和磁盘吞吐与发布者设备不同，冷启动、编译和编码速度可能不同。

## 长上下文与备选文本模型

先建立 MXFP4 与 INT3 的短上下文质量／速度基准。之后可以测试上游 `long-kv4` 模式。本机 `w3a4` 入口目前固定为桌面 8K／单并发配置；测试长上下文需要另建运行配置，同时重新分配 KV 缓存，不能只追加 `--mode long-kv4`。

上游此模式提供 262,144 token 单请求上下文及前缀缓存；可选视觉输入会降低缓存容量。94 GiB 系统内存有利于尝试上游 RAM 缓存扩展，但需要先测常规模式，确认资源余量，再启用 `--extend-cache`。RAM 缓存不能替代显存内计算，也不能把单卡当成双卡。524K 属于实验模式，暂不作为默认配置。

补充方案均有单卡官方指南，但本项目没有接入对应启动入口／下载权重：

- [MiniCPM5-2B](../engines/shared/paiton/upstream/models/MiniCPM5-2B/README.md)：适合用作小模型启动链路验证和轻量工具调用。
- [GPT-OSS-20B](../engines/shared/paiton/upstream/models/GPT-OSS-20B/README.md)：推理、工具调用和结构化输出的备选。
- [Qwen3-Coder 30B A3B](../engines/shared/paiton/upstream/models/Qwen3-Coder-30B/README.md)：代码任务对照；官方此 preset 为 4K 上下文。
- [Ornith 1.5 35B A3B](../engines/shared/paiton/upstream/models/Ornith-1.5/README.md)：聊天／推理的备选，适合后续质量对照。

你已有的 AutoRound INT4 可用于原生 vLLM 对照，但其量化后端及 W4A16 草稿要单独验证。Flash Next GGUF / Strata 文件可作为 CPU+GPU 混合运行的研究候选；现有文件不等于已验证本机运行条件。

## 本机不优先采用的博客方案

- [Flash Next 的 216 tok/s 方案](https://eliovp.com/blog/paiton-qwen38-flash-next-radeon-ai-pro-r9700)：使用两张 R9700，当前单卡不能复现该 tensor-parallel 配置。
- MI355X 上 Wan2.2-T2V-A14B 对比 B200：是数据中心 GPU 测试。当前选用单卡 TI2V-5B / FastWan，而不将该成绩作为本机目标。见 [Paiton 产品页中的测试平台](https://eliovp.com/products/paiton)。
- MI300X、MI325X、MI355X、大型多卡 Llama / MoE、数据中心部署文章：可作技术背景，当前不列入本机安装清单。
- 已被上游替代的旧 Qronos 单卡 Qwen 方案：作为历史对照；主力采用你已经拥有的 NVFP4 + DFlash2 + 可选 INT3 组合。

## 实施与验证顺序

1. 在宿主机验证 Docker 用户权限、GPU 容器访问及 `gfx1201`。复用现有文本权重，运行一次聊天和一次代码请求。
2. 用 MXFP4 和 INT3 分别测 vLLM TTFT、输出吞吐及 EleutherAI 数学／知识任务。并发 1/2/4/8 分开报告；完整任务成绩与 10 样本冒烟检查分开。
3. 准备 FLUX，先测冷启动和暖态生成，再进行 stock / Paiton 对照。标准 GenEval 评分环境仍需兼容性验证。
4. 准备 FastWan / Wan，先生成 480 级别短片，再测 5 秒及图生视频。VBench 评分环境仍需兼容性验证。
5. 在显存足够空闲时测试 Qwen-Image；最后测试 H3 短片及长片声音／编码链路。

单卡顺序切换，切换前执行 `./lab stop`。各方案继续放在本项目的 `engines/llm`、`engines/image`、`engines/video` 下；缓存、输出和报告按类别保存。当前整理不额外下载模型、不更改默认启动配置。
