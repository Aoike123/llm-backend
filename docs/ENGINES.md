# 多引擎目录

[文档目录](README.md)

`/mnt/Code/llm-backend` 是所有引擎的项目根目录，文本、图像、视频都放在这里。

## 部署说明

| 类别 | 部署 | 验收状态 |
|---|---|---|
| 文本 | [Qwen38 W3A4](../engines/llm/pation-model-qwen38-27b-w3a4/README.md) | 已有实际推理记录，当前统一 API 的文本后端 |
| 图像 | [Qwen-Image 2.1](../engines/image/pation-model-qwen-image-21/README.md) | 文生图、透明图与编辑通过，保真仍待验收 |
| 图像 | [FLUX.2 klein](../engines/image/pation-model-flux2-klein/README.md) | Paiton / Stock 文生图通过 |
| 视频 | [MiniMax H3](../engines/video/pation-model-minimax-h3/README.md) | 文生视频、首帧/首尾帧通过，含音频 |
| 语音 | [CosyVoice 3 RL](../engines/audio/pation-model-cosyvoice3/engine.json) | 零样本克隆、Instruct、拼音标注通过；RL checkpoint 为默认 |
| 文本 | [Qwen38 MXFP4](../engines/llm/pation-model-qwen38-27b-mxfp4/README.md) | 入口已登记，未完成验收 |
| 文本 | [原生 vLLM](../engines/llm/vllm/README.md) / [llama.cpp](../engines/llm/llama-cpp/README.md) / [Strata](../engines/llm/strata/README.md) | 资源或配置已登记，运行环境待接入 |

## 目录与命名

```text
llm-backend/
├── lab                           # 用户统一入口
├── README.md                     # 首页
├── engines/
│   ├── llm/                      # Qwen3.8 专用部署及通用引擎
│   ├── image/                    # FLUX / Qwen-Image
│   ├── video/                    # MiniMax H3
│   ├── audio/                    # CosyVoice 3
│   └── shared/paiton/            # 共用后端源码及控制器
├── docs/                         # 使用与评测说明
├── workspace/
│   ├── data/                     # 模型与运行缓存
│   ├── outputs/                  # 生成作品
│   └── reports/                  # 推理、性能、能力评测记录
└── .workbench/
    ├── config/                   # 部署注册表
    ├── scripts/                  # 内部维护和评测脚本
    ├── tests/                    # 项目检查
    ├── vendor/                   # 标准评测工具源码
    ├── docker/                   # 可选评测镜像构建文件
    ├── envs/                     # 工具 Python 环境
    ├── cache/                    # 内部 Python 缓存
    └── sources.lock.json         # 上游版本锁
```

每个引擎目录保存 `engine.json`、`config/models.json` 和说明。图像／视频目录按可操作的生成方案登记；其中多个方案使用同一 Paiton 优化后端和 Diffusers／ComfyUI。公共源码保留一份，以避免重复拉取、版本漂移和混用依赖。

日常请求走统一 API；下面的启动命令用于空闲时的手动维护。

```bash
./lab engines
./lab models
./lab pation-model-qwen38-27b-w3a4 start w3a4  # 已验证文本部署
./lab pation-model-flux2-klein start
./lab pation-model-qwen-image-21 start
./lab pation-model-minimax-h3 start
./lab pation-model-flux2-klein stop
./lab stop                       # 停止当前接入的 Paiton 系列服务
```

W3A4 文本部署已通过长上下文、视觉、思考与8路混合请求检查。Qwen-Image 2.1、FLUX.2 klein、MiniMax H3 已通过媒体生成及中央 ComfyUI 路径验证，权重在项目 NVMe。MXFP4 独立文本入口以及原生 vLLM、llama.cpp、Strata 尚未完成部署验收（原 FastWan 预设已随 Wan 下线）；这些不属于本轮已通过的四个主部署。


现有 `./lab start llm`、`./lab fetch`、`./lab bench image` 等命令继续可用。新方案优先使用显式引擎名称。文本权重路径保存在 `engines/llm/pation-model-qwen38-27b-w3a4/config/local-models.json`；运行权重已复制到项目 NVMe，并只读挂载，资源盘原件保留。

目录名优先标识模型部署或通用引擎。`pation-model-qwen38-27b-w3a4` 的后端记录为 Paiton / vLLM，`pation-model-qwen38-27b-mxfp4` 为独立的 MXFP4 部署入口，二者共享模型资源；公共后端源码仍放在 `engines/shared/paiton/`。旧 `paiton` 命令仅作为迁移兼容入口，注册表不再将其列作通用引擎。

目录按 `pation-model-<模型型号>-<量化版本>` 命名，设备型号记录在配置中。已清理废弃的评测环境与旧 Python 缓存；当前运行缓存、模型、标准评测源码与图像／视频部署配置保留。

2026-10-20：Wan/FastWan 下线；历史结果仅供追溯。当前五服务、API/MCP 与 H3 原生执行见 [运行模式](RUNTIME_TOPOLOGY.md)。
