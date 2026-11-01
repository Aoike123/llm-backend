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
| 语音 | [Fish Audio Drama 3](../engines/audio/fish-drama3/engine.json) | audio.cpp Q4_K_S，全部驻留显存；中文克隆与情绪标签已实测，质量对比待做 |
| 语音 | [BS-RoFormer](../engines/audio/bs-roformer/engine.json) | 人声 / 伴奏分离，3 分钟音频约 2 分钟 |
| 语音 | [Qwen3-ASR 1.7B](../engines/audio/qwen3-asr/engine.json) | 中文与方言识别；为语音克隆自动补全参考文本 |
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
│   ├── audio/                    # Drama 3 / BS-RoFormer / Qwen3-ASR（共用 audio.cpp 运行时）
│   ├── shared/paiton/            # 共用后端源码及控制器
│   └── shared/audiocpp/          # audio.cpp 运行时控制器与客户端
├── docs/                         # 使用与评测说明
├── workspace/
│   ├── data/                     # 模型与运行缓存
│   ├── outputs/                  # 生成作品
│   └── reports/                  # 推理、性能、能力评测记录
└── .workbench/
    ├── registry.py               # Python 侧读取引擎清单（lab、ComfyUI 控制器共用）
    ├── scripts/                  # 内部维护和评测脚本
    ├── tests/                    # 项目检查
    ├── vendor/                   # 标准评测工具源码
    ├── docker/                   # 可选评测镜像构建文件
    ├── envs/                     # 工具 Python 环境
    ├── cache/                    # 内部 Python 缓存
    └── sources.lock.json         # 上游版本锁
```

每个引擎目录保存 `engine.json`、`config/models.json` 和说明；接入网关的引擎另有 `adapter.mjs`，规范见下文「接入新引擎」。图像／视频目录按可操作的生成方案登记；其中多个方案使用同一 Paiton 优化后端和 Diffusers／ComfyUI。公共源码保留一份，以避免重复拉取、版本漂移和混用依赖。

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

## 接入新引擎

一个引擎就是 `engines/<category>/<id>/` 下的一个目录。网关、MCP 和控制台都从这里读取，不需要改它们的代码。设计与取舍见 [引擎平台化](ENGINE_PLATFORM.md)。

```text
engines/audio/fish-drama3/
├── engine.json     # 清单：lab 字段 + platform 段
├── adapter.mjs     # 生命周期与能力实现，只引用 platforms/workbench/lib/engine-sdk.mjs
├── controller.py   # lab 的启停入口（engine.json 的 entrypoint）
└── README.md
```

### engine.json 的 platform 段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `engine` | 是 | 调度键，全局唯一，小写字母、数字或 `-` |
| `default_enabled` | 否 | 没有保存过开关时是否启用；新引擎建议 `false`，在控制台验证后再启用 |
| `adapter` | 是 | adapter 文件名，通常是 `adapter.mjs` |
| `interruptible` | 否 | 运行中的任务能否按 `prompt_id` 中断（ComfyUI 为 `true`） |
| `runtime.id` | 是 | 运行时 id；多个引擎同 id 表示共用一个进程，切换时不重启 |
| `runtime.name` / `port` / `container` | 是 | 显示名、HTTP 端口、Docker 容器名 |
| `runtime.launch` | 是 | `./lab` 的启动参数；停止时自动把第二项换成 `stop` |
| `runtime.concurrency` | 否 | 一个已加载实例能同时服务的请求数，默认 1 |
| `runtime.extra_containers` | 否 | 也算作该引擎在运行的其他容器 |
| `runtime.native_ui` | 否 | 原生界面地址；有此字段的运行时提供 ComfyUI 画布 |
| `ui.name` / `version` / `description` / `symbol` / `accent` | 是 | 控制台卡片 |
| `ui.panel` | 是 | `media`（通用媒体面板）、`comfy`（原生队列）或 `llm`（对话引擎配置） |
| `ui.full_name` / `log_name` / `summary` | 否 | 监控标题、日志标题、配置页的任务说明 |
| `models[].id` | 是 | 对外模型 id，API/MCP 的 `model` 参数 |
| `models[].capabilities` | 是 | 提供的能力，如 `image.generate`、`speech.synthesize` |
| `models[].priority` | 否 | 没有保存路由时的默认顺序，小的优先 |
| `models[].info` | 否 | 原样出现在 `list_media_models` / `/v1/media/models` 的说明字段 |

能力清单见 [platforms/workbench/lib/media-tools.mjs](../platforms/workbench/lib/media-tools.mjs)：`image.generate`、`image.edit`、`video.generate`、`speech.synthesize`、`audio.separate`、`audio.transcribe`。新增一种能力才需要改这个文件。

### adapter.mjs 钩子

全部可选，除 `idle`、`ready` 和媒体引擎的 `execute`。`ctx` 含 `backend`、`engine`、`runtime` 和 `base`（`http://127.0.0.1:<port>`）。

| 钩子 | 用途 |
| --- | --- |
| `idle(ctx)` / `ready(ctx)` | 切换前确认空闲；启动后的就绪检查 |
| `params[capability](model)` | 该模型在基础参数之外接受的参数（JSON Schema 属性）；工具参数取所有模型的并集，请求只会派给接受其参数的模型 |
| `notes[capability](model)` | 写进工具说明的一句话限制 |
| `validate(capability, input)` | 引擎自己的限制（如提示词长度）；抛错即排除该候选 |
| `assets(capability, input, {asset})` | 读取并检查引用的素材，返回素材列表用于内存预算 |
| `onCreate(job, input, {asset})` | 创建任务时补充记录（如参考标签映射） |
| `payload(capability, input, {bytes, asset})` | 构造发给后端的请求 |
| `prepare(capability, payload)` | 派发前的预处理（如参考视频转码） |
| `execute(capability, payload, ctx)` | 调用后端；返回旧版 `{data:[...]}`，或把文件写进 `ctx.outputDirectory` 后返回 `{artifacts:[{kind, file, mime, name?, media?}]}` |
| `effective(capability, input, media, job)` | 写进 `effective_parameters` 的实际参数 |
| `interrupt(backend)` / `recover(job, helpers)` | 中断运行中的任务；网关重启后按后端记录恢复 |
| `syncValidate` | 同步 API（`/v1/images/*`、`/v1/videos/*`）的请求体校验 |
| `logContainers` / `startupLogs` | 日志面板显示的容器和启动日志 |
| `parked` / `park` / `resume` / `launchArgs` / `launchEnv` / `startupCheck` / `verify` / `retryCold` / `onStop` | 调度扩展：CPU 驻留、按策略生成启动参数、启动后核对配置（LLM 使用） |

错误语义沿用网关规则：`answered()` 包住后端调用，HTTP 错误记为 `BACKEND_FAILED`；`beforeSubmission()` 包住提交前的准备，失败记为 `NOT_SUBMITTED`；其他异常在派发后记为结果不确定，不会重试。

### 接入与卸载

```bash
./lab engine list                    # 所有引擎包及启用状态
./lab engine enable <package>        # 网关运行时立即生效；否则下次启动生效
./lab engine disable <package>       # 正在使用或排队的引擎不能停用；运行中的容器会先停止
./lab services deploy                # 改了控制台代码后构建并重启网关
```

也可以在控制台「引擎」页操作，并在同一页设置每种能力的主推和降级顺序。启用状态和路由保存在 `workspace/config/platform-state.json`，不进 git。

