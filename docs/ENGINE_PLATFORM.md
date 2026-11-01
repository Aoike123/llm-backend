# 引擎平台化：能力、引擎包与主推/降级

[文档目录](README.md)

更新：2026-11-02。状态：**P0–P3 已上线**；S2-Pro 语音降级与 Drama 3 高精度版本对比待做。接入规范见 [引擎目录 · 接入新引擎](ENGINES.md#接入新引擎)。

## 为什么要改

接入或下线一个引擎，现在要改的地方散落在十几个文件里，而且没有任何机制保证改全：

| 层 | 现在写死引擎信息的位置 |
| --- | --- |
| 注册与拓扑 | `engines/*/engine.json`、`.workbench/config/engines.json`、`platforms/runtime-topology.json` |
| 网关生命周期 | `backend.mjs` 的 `idle` / `ready` / `engineLogs` 按 id 写 `if` 分支 |
| 网关 API | `http.mjs` 的 `MODELS` 映射、`/v1/images/*`、`/v1/videos/*` 等固定路由 |
| 媒体执行 | `media-executor.mjs` 按引擎写端口和路径；`media-jobs.mjs` 按工具写校验、载荷、保存与有效参数 |
| MCP | `media-manifest.mjs` 的模型和工具清单、`mcp/manifest.mjs` 的过滤、`mcp-routes.mjs` 与 `mcp/server.mjs` 的工具名白名单 |
| 控制台 | `panel.mjs` 的服务卡片、`monitoring.mjs` 的名称；`page.jsx` 按 id/type 写眉题、耗时标题、模型标识与接口 |
| 测试与文档 | 测试里固定的模型列表和工具数量；七八份文档 |

后果：

- CosyVoice 下线改了 24 个文件；
- 新增一个引擎，在控制台、API、MCP 里不会自动出现；
- 控制台把语音引擎标成 "IMAGE ENGINE"，因为页面只认识 h3、language 和"其他"。

另外，同一种能力只能有一个后端，没有主推，也没有降级。

## 目标

1. **一个引擎 = 一个目录**。新增就是放进目录，再在控制台启用；卸载就是停用或删除，不改网关、MCP 或前端代码。
2. **API、MCP、控制台从同一份注册表生成**，不再各自维护清单。
3. **每种能力有主推引擎和有序的降级链**，在控制台配置，API 和 MCP 默认走主推。
4. 现有对外接口保持兼容：OpenAI 兼容路由、MCP 工具名、`request_id` 去重、`unknown` 不自动重试。

## 三个核心概念

### 能力（capability）：对外契约，很少变

能力定义"做什么"，包括输入 Schema、产物类型和 MCP 工具。由平台代码维护，与具体引擎无关。

| 能力 | 产物 | API | MCP 工具 |
| --- | --- | --- | --- |
| `chat` | 文本流 | `/v1/chat/completions` | — |
| `image.generate` | PNG | `/v1/images/generations`、`/v1/media/jobs` | `generate_image` |
| `image.edit` | PNG | `/v1/images/edits`、`/v1/media/jobs` | `edit_image` |
| `video.generate` | MP4 | `/v1/videos/generations`、`/v1/media/jobs` | `generate_video` |
| `speech.synthesize` | WAV | `/v1/media/jobs` | `generate_speech` |
| `audio.separate` | 多轨 WAV | `/v1/media/jobs` | `separate_audio` |
| `audio.transcribe` | 文本与时间戳 | `/v1/media/jobs` | `transcribe_audio` |

工具按能力而不是按引擎定义，所以换引擎时工具名不变。引擎特有的参数由 adapter 按模型声明（`params`）：工具的参数表取所有已启用模型的并集，请求只会派给接受它所带参数的模型。原方案的 `options` 子对象没有采用，因为现有调用方的顶层参数（如 `size`、`engine`）可以原样保留。

### 引擎包（engine package）：一个目录，自描述

```text
engines/audio/fish-drama3/
├── engine.json        # 唯一清单：身份、运行时、能力、界面元数据
├── adapter.mjs        # 把能力请求翻译成后端调用，把结果翻译成产物
├── controller.py      # 可选：特殊启动逻辑；简单容器不需要
└── tests/             # 可选：引擎自己的用例
```

`engine.json` 示例：

```json
{
  "id": "fish-drama3",
  "name": "Fish Audio Drama 3",
  "version": "Q4_K_S · audio.cpp 0.9.3",
  "category": "audio",
  "status": "experimental",
  "ui": {"symbol": "D", "accent": "#d9a7a0", "description": "多角色语音 · 声音克隆 · 情绪标签"},
  "runtime": {
    "container": "paiton-audiocpp",
    "port": 18986,
    "launch": {"kind": "docker", "image": "…", "args": ["…"]},
    "probe": {"ready": "/health", "idle": "/health#busy=false"},
    "concurrency": 1,
    "vram_gib": 24,
    "shares_runtime_with": ["audiocpp-asr", "audiocpp-separate"]
  },
  "capabilities": {
    "speech.synthesize": {}
  },
  "artifacts": {"outputs": "workspace/outputs/audio/fish-drama3"}
}
```

`adapter.mjs` 的接口：

```js
export default {
  async ready(ctx) {},          // 就绪检查
  async idle(ctx) {},           // 空闲检查（GPU 切换前确认）
  capabilities: {
    'speech.synthesize': {
      validate(input, ctx) {},  // 引擎自己的限制（如参考音频时长）
      async run(input, ctx) {   // ctx: base URL、素材解析、输出目录、取消信号、onSubmitted
        return {artifacts: [{kind: 'audio', file, mime: 'audio/wav'}], media: {}, metrics: {}};
      }
    }
  }
};
```

ComfyUI、vLLM、audiocpp_server 这类第三方服务器只需要一个很薄的 adapter，不要求它们改成统一的 HTTP 协议。

### 路由策略（routing）：主推 + 降级，在控制台配置

```json
{
  "speech.synthesize": {"primary": "fish-drama3", "fallbacks": ["fish-s2pro"]},
  "image.generate": {"primary": "qwen-image21", "fallbacks": ["anima"]}
}
```

- 与启用状态一起保存在 `workspace/config/platform-state.json`，由控制台或 `./lab engine` 写入，不进代码；
- 请求不带 `model`（或 `model: "auto"`）时走主推；
- 请求点名某个引擎时只用它，不降级；
- 降级只在**确定没有生成**时发生：引擎停用、未安装、启动失败、就绪超时、派发前被拒绝。
- `unknown`（结果不确定）永远不降级、不重试，沿用现有规则。
- 后端已明确报错（`BACKEND_FAILED`）时是否降级，作为每个能力的可选开关，默认关闭，避免同一个坏输入把每个引擎都试一遍。
- 任务记录写明 `served_by` 和 `fallback_from`，控制台和 `get_job` 都能看到实际是谁生成的。
- 单卡环境下，降级意味着切换引擎。是否允许"主推是冷的、降级引擎已经在显存里就直接用降级"，作为可选开关，默认关闭，质量优先。

## 注册表如何驱动三端

网关启动时扫描 `engines/*/engine.json`，结合 `workspace/config/platform-state.json`（启用状态与路由），生成一份注册表。下面这些都从它推导：

- **拓扑与调度**：运行时、端口、容器、并发、共享运行时，替代 `runtime-topology.json` 的手写内容和 `backend.mjs` 的 `if` 分支；
- **API**：`/v1/models`、`/v1/media/models`、新增的 `/v1/capabilities`，以及各能力的路由；
- **MCP**：按已启用的能力生成工具；`list_media_models` 返回各能力的主推、降级和各模型的参数；MCP 进程从网关 `/v1/media/catalog` 读取，不再自带工具清单；
- **控制台**：服务标签页、眉题（按 category）、耗时卡片、接口列表、日志，全部来自清单，不再写死 id。

控制台新增两页：

1. **引擎**：已安装的引擎包，显示状态（实验/稳定）、启用开关、健康、显存估计、日志，以及安装（指定目录）和卸载；
2. **能力**：每种能力的主推和降级顺序（拖动排序），加一个"试运行"按钮。

## 生命周期与校验

```bash
./lab engine add engines/audio/fish-drama3   # 校验清单、跑能力一致性测试、注册（默认停用）
./lab engine enable fish-drama3              # 控制台开关的命令行等价物
./lab engine disable fish-drama3             # 从 API/MCP 消失，文件保留
./lab engine remove fish-drama3              # 停用并删除注册；模型数据另行确认
```

- **清单校验**：JSON Schema 检查必填字段、端口冲突、能力名合法；
- **能力一致性测试**：平台为每个能力提供通用用例（参数校验、产物格式、取消、失败语义），任何声明该能力的 adapter 都自动跑一遍。新引擎不需要再改现有测试里固定的模型列表和工具数量。

## 迁移步骤

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 ✅ | 清单 Schema 与注册表加载器；从现有清单生成拓扑、模型表、服务卡片 | 生成结果与当前硬编码完全一致（对拍测试），行为不变 |
| P1 ✅ | flux、qwen-image、h3（ComfyUI）、llm 迁到 adapter；删除 `backend`/`media-executor`/`media-jobs`/`panel`/`page.jsx` 里按 id 的分支 | 现有 148 + 6 个测试全过；控制台各页显示不变（语音标签修正除外） |
| P2 ✅ | 能力驱动的 API/MCP、`platform-state.json`、主推与降级、控制台「引擎」页，以及每个引擎的「作品与历史」面板 | 在控制台把 `image.generate` 主推切到 FLUX，不改代码，API/MCP 立即生效 |
| P3 ✅ | audio.cpp 引擎包：Drama 3（语音合成）、人声分离、ASR；S2-Pro 作为语音降级 | **验收即目标**：新增 = 一个目录 + 控制台启用；卸载 = 停用，零代码改动 |

LLM 的模式切换、KV 预算等是它特有的功能，作为 adapter 的扩展面板保留，不强行套进通用表单。

## 已确认的决定

1. 语音合成工具命名为 `generate_speech`；`generate_audio` 已随 CosyVoice 移除，不保留别名。
2. 后端明确报错时默认不降级，按能力可开启。
3. CosyVoice 下线单独提交，之后在 `gateway-scheduler-redesign` 分支按 P0→P3 推进。
4. 人声分离用 BS-RoFormer，语音识别用 Qwen3-ASR 1.7B，均运行在 audio.cpp。

## 实施记录

- 2026-11-02：P3 验收通过。三个音频引擎包（`engines/audio/fish-drama3`、`bs-roformer`、`qwen3-asr`）共用 `engines/shared/audiocpp/` 运行时，没有改动网关、MCP 或控制台代码，只用 `./lab engine enable` 启用。端到端链路：导入 3 分 10 秒视频 → 人声分离（132 秒）→ 从人声作品截 15 秒并自动识别参考文本 → Drama 3 克隆（15.7 秒音频，总计 30 秒）。
- 运行中的网关在「引擎」页和 `./lab engine` 每次操作前重新扫描引擎目录，新增包不需要重启网关；清单有误时报错并保留原注册表。
- MCP 工具按类别合并为 8 个：`generate_image`（含编辑）、`generate_video`、`generate_audio`（`task` 区分），公共工具合并 `list_jobs` 到 `get_job`、`download_artifact` 到 `get_artifact`。旧名继续可调用。
- 2026-11-02：ComfyUI 改为共享运行时 `engines/shared/comfyui/`（客户端、节点、模板），H3 的图与金鱼逻辑移进 H3 包，删掉 `platforms/comfyui/` 及其中未挂载的桥接节点、CPU 镜像和中继。新增 Anima 引擎包（`image.generate` / `image.edit`），与 H3 共用 `comfy` 运行时。ComfyUI 不再有 systemd 单元，改为按需启动。FLUX.2 klein 下线：删除引擎包、Paiton `image` profile 和 ROCm 运行时配方，这一步改了 Paiton 启动器与运行时清单，因为它们是 FLUX 专用的部署代码。引擎包的 Node 测试放在各自的 `tests/`，`./lab check` 自动发现。
