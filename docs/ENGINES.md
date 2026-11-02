# 多引擎目录

[文档目录](README.md)

每个引擎是 `engines/` 下的一个包；网关、MCP、控制台、镜像构建和存储都从包里的清单读取，接入、升级和卸载不需要改平台代码。

## 部署说明

| 类别 | 部署 | 验收状态 |
|---|---|---|
| 文本 | [Qwen38 W3A4](../engines/llm/pation-model-qwen38-27b-w3a4/README.md) | 已有实际推理记录，当前统一 API 的文本后端 |
| 图像 | [Qwen-Image 2.1](../engines/image/pation-model-qwen-image-21/README.md) | 文生图、透明图与编辑通过，保真仍待验收 |
| 图像 | [Anima v1.1](../engines/image/anima/README.md) | ComfyUI 原生文生图与图生图，与 H3 共用运行时 |
| 视频 | [MiniMax H3](../engines/video/pation-model-minimax-h3/README.md) | 文生视频、首帧/首尾帧通过，含音频 |
| 语音 | [Fish Audio Drama 3](../engines/audio/fish-drama3/engine.json) | audio.cpp Q4_K_S，全部驻留显存；中文克隆与情绪标签已实测，质量对比待做 |
| 语音 | [BS-RoFormer](../engines/audio/bs-roformer/engine.json) | 人声 / 伴奏分离，3 分钟音频约 2 分钟 |
| 语音 | [Qwen3-ASR 1.7B](../engines/audio/qwen3-asr/engine.json) | 中文与方言识别；为语音克隆自动补全参考文本 |
| 文本 | [Qwen38 MXFP4](../engines/llm/pation-model-qwen38-27b-mxfp4/README.md) | 入口已登记，未完成验收 |

## 目录与命名

```text
llm-backend/
├── lab                           # 用户统一入口
├── README.md                     # 首页
├── engines/
│   ├── llm/       ## 目录与命名

```text
llm-backend/
├── lab                               # 统一入口
├── engines/
│   ├── <category>/<package>/         # 引擎包：engine.json、adapter.mjs、可选 image.json / tests/ / controller.py
│   └── shared/<runtime>/             # 多个引擎共用的运行时：comfyui、audiocpp、paiton（供应商启动器）
├── platforms/                        # 网关与控制台、MCP、调度、监控、systemd 单元；platform.json 定义端口与存储
├── .workbench/
│   ├── registry.py / storage.py      # Python 侧读取引擎清单与存储布局
│   ├── runtime/images.py             # 运行时镜像：发现配方、构建、激活、清理
│   ├── runtime/rocm101/              # 共享 ROCm SDK：sdk.py、版本锁、构建步骤
│   ├── evaluation/vbench/            # VBench 评测镜像配方
│   └── scripts/ tests/ vendor/ envs/
├── workspace/                        # 不进 Git：data/（模型、缓存、状态）、config/（本机状态）、outputs → 作品盘
└── docs/
```

目录名标识模型部署，如 `pation-model-<模型>-<量化>`；设备型号记录在配置里。共用一个服务进程的引擎把运行时放在 `engines/shared/<runtime>/`，引擎包里只保留自己的图、参数和校验。

日常请求走统一 API，运行时由网关按需启动。下面的命令用于维护：

```bash
./lab engine status                 # 每个包占用的镜像与数据
./lab runtime status                # 每个运行时的镜像与 SDK 版本
./lab pation-model-qwen38-27b-w3a4 start w3a4
./lab comfyui start                 # H3 / Anima 共用的 ComfyUI
./lab stop                          # 停止当前 GPU 容器
```

文本权重路径保存在 `engines/llm/pation-model-qwen38-27b-w3a4/config/local-models.json`，运行权重已复制到项目 NVMe 并只读挂载。`pation-model-qwen38-27b-mxfp4` 是同一模型的 MXFP4 部署入口，只能命令行启动，未接入网关。

下线记录：2026-10-20 Wan/FastWan；2026-11 CosyVoice；2026-11-02 FLUX.2 klein（使用频率低，由 Anima 接替图像降级），以及只有占位登记、从未接入的 vLLM、llama.cpp、Strata 三个包。当前运行时与调度见 [运行模式](RUNTIME_TOPOLOGY.md)。

ama3/
├── engine.json     # 清单：lab 字段、platform 段、storage.data（占用的数据目录）
├── adapter.mjs     # 生命周期与能力实现，只引用 engine-sdk.mjs 和 engines/shared/<运行时>/client.mjs
├── image.json      # 可选：运行时镜像配方（独占运行时的引擎；共用运行时的配方在 engines/shared/<runtime>/）
├── tests/          # 可选：*.test.mjs，./lab check 自动发现
├── controller.py   # lab 的启停入口（engine.json 的 entrypoint）
└── README.md
```

共用运行时的引擎（ComfyUI 上的 H3 与 Anima、audio.cpp 上的三个音频引擎）声明相同的 `runtime`，用 `engines/shared/<运行时>/client.mjs` 里的 `idle`、`ready`、提交与恢复函数；引擎包只写自己的图和参数。

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
| `runtime.native_ui` | 否 | 原生画布地址；有此字段的运行时提供 ComfyUI 画布，原生队列显示在任务中心 |
| `ui.name` / `version` / `description` / `symbol` / `accent` | 是 | 控制台卡片 |
| `ui.panel` | 是 | `media`（通用媒体面板）或 `llm`（对话引擎配置）。运行时不单独成卡；共用 ComfyUI 的引擎在配置页显示运行时与画布入口 |
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

### 接入、升级与卸载

| 操作 | 步骤 |
| --- | --- |
| 接入 | 放入包目录 → 如果需要新运行时，写 `image.json` 并执行 `./lab runtime build <runtime>`，GPU 验收后 `./lab runtime activate` → `./lab check` → `./lab engine enable <package>` |
| 升级引擎 | 改 `image.json`（换底座 digest 或步骤）→ `build` → 验收 → `activate` → `./lab runtime prune --apply`；回滚：`activate` 上一版 |
| 升级 ROCm SDK | 见 [运行时镜像 · 升级流程](RUNTIME_IMAGES.md#升级流程)；镜像不用重建 |
| 卸载 | `./lab engine remove <package>` 先预览；加 `--apply` 后停用引擎，删除包目录、只被它占用的数据目录和运行时镜像，再用 Git 提交目录删除。共用的数据和运行时保留，作品从不删除 |

```bash
./lab engine list                    # 所有引擎包及启用状态
./lab engine status [package]        # 镜像、数据目录与体积，标出共用资源
./lab engine enable <package>        # 网关运行时立即生效；否则下次启动生效
./lab engine disable <package>       # 正在使用或排队的引擎不能停用；运行中的容器会先停止
./lab engine remove <package> [--apply]
./lab services deploy                # 改了控制台代码后构建并重启网关
```

也可以在控制台「引擎」页启用、停用引擎，并在同一页设置每种能力的主推和降级顺序。启用状态和路由保存在 `workspace/config/platform-state.json`，运行时镜像的选择保存在 `workspace/config/runtime-images.json`，都不进 Git。

`engine.json` 的 `storage.data` 列出包占用的目录（模型、缓存）。多个包声明同一个目录就表示共用；卸载时只删没有其他包声明的目录。布局与作品位置见 [存储](STORAGE.md)。
