# 当前 API 清单

整理日期：2026-10-20（Asia/Shanghai）。以当前工作台路由、模型工作进程代码及本机只读查询为依据。下列生成示例仅供调用，整理过程中未执行推理或模型切换。

[文档目录](README.md) · [LLM 配置与容量](LLM_MODES.md) · [服务说明](SERVICES.md)

## 1. 地址与调用约定

| 用途 | 地址 | 说明 |
|---|---|---|
| 统一推理入口 | `http://127.0.0.1:18982` | 客户端使用的网关，自动排队、加载目标引擎、续租及释放 |
| 面板 | `http://127.0.0.1:13000` | 页面及同一组查询、配置、推理 API |
| 本机调度控制 | `http://127.0.0.1:18990` | 租约操作和状态查询 |
| ComfyUI | `http://127.0.0.1:8188` | 工作流界面；不是统一聊天 API |

聊天客户端 Base URL：`http://127.0.0.1:18982/v1`；模型：`qwen38-27b-w3a4`。
公网入口必须使用有效 Bearer 密钥。本机同步 API 保留可信集成兼容：不带 Authorization 或使用 `Bearer local` 可调用；显式有效密钥执行身份额度管理。持久媒体 API / MCP 始终需要有效密钥，不接受 `local`，且目前不向公网代理开放。详见 [公网接入](PUBLIC_API.md)。
所有 POST 使用 `Content-Type: application/json`。推理/配置请求体上限 32 MiB，控制端口请求体上限 4096 字节。
服务监听回环地址。浏览器 Origin 仅允许 `http(s)://localhost[:端口]` 或 `http(s)://127.0.0.1[:端口]`；控制端口拒绝带 Origin 的 POST。

查询模型、日志、指标不会加载 GPU 引擎。推理请求会按需切换；提交 Qwen 配置会等待任务结束并重启引擎。

## 2. 模型标识

| 对外 model | 能力 | 查询/调度内部 model |
|---|---|---|
| `qwen38-27b-w3a4` | 文本与图像输入的聊天、推理、SSE | `llm` |
| `qwen-image21` | 文生图、透明图、图像编辑 | `qwen-image` |
| `flux2-klein` | 文生图 | `flux` |
| `minimax-h3` | 文生视频、首尾帧、多图/视频/混合参考 | `h3` |

当前四个模型服务的关系见 [运行模式](RUNTIME_TOPOLOGY.md)。Wan 已下线。
`GET /v1/models` 返回当前保存的 Qwen 上下文与并发上限，并不代表 Qwen 已加载；实际状态查看 `/status`。
历史上下文模型别名仍可被聊天请求识别，但全部使用当前统一引擎配置；以目录中的固定名称为准。

## 3. 统一网关路由（18982，也可通过 13000）

| 方法 | 路径 | 用途/参数 |
|---|---|---|
| GET | `/health` | 网关健康与 GPU 调度状态；ready=200，draining=503，不代表所有模型已加载 |
| GET | `/status` | 当前/目标引擎、租约、队列、错误、Qwen 策略、切换事件、驻留与任务统计 |
| GET | `/v1/models` | 当前 Qwen 模型目录、上下文、并发、视觉与推理能力 |
| GET | `/v1/media/models` | 图像/视频/语音模型目录；自定义媒体发现接口 |
| POST | `/v1/chat/completions` | 聊天，支持 SSE |
| POST | `/v1/images/generations` | Qwen-Image 或 FLUX 文生图 |
| POST | `/v1/images/edits` | Qwen-Image 图像编辑；JSON + PNG base64 |
| POST | `/v1/videos/generations` | H3 视频；同步等待结果 |
| GET | `/artifacts/{32位小写十六进制ID}.mp4` | 下载视频产物，Content-Type 为 video/mp4 |
| GET | `/data` | 面板指标、趋势、任务、KV 布局与预览 |
| GET | `/api/engine-logs` | 指定服务或当前目标引擎日志及切换进度 |
| GET | `/api/llm-mode/logs` | 同上，兼容路径；同样支持 model 参数 |
| POST | `/api/llm-mode` | 应用 Qwen 配置并重启 |
| GET | `/metrics` | Prometheus 文本指标 |
| OPTIONS | 任意路径 | 本地浏览器 CORS 预检 |

`POST /api/switch` 已移除。网关没有公开 `/tokenize`、`/v1/responses`、`/v1/embeddings` ；持久媒体任务使用本机 `/v1/media/jobs` 接口。

## 4. 聊天 API

必填：`model`、非空 `messages` 数组。
可选：`stream`、`max_tokens` 或 `max_completion_tokens`、`reasoning_effort`，以及工作进程支持的聊天采样参数。

- `reasoning_effort` 请求值：`none`、`low`、`medium`、`high`、`xhigh`；省略（或空串）时使用默认 `medium`。当前 `high` 在转发时映射为 `xhigh`。
- 只有「未携带」才落到默认：显式给出本机不支持的值仍返回 400，错误信息列出可用值。大小写与首尾空格不算差异；`off` 按 `none` 处理，`minimal`、`max` 分别取最近的 `low`、`xhigh`。
- `/v1/models` 的 `reasoningEfforts.off` 映射到请求值 `none`；写 `off` 也视为 `none`。
- 响应头 `X-Reasoning-Effort` 回显实际生效的强度（`high` 显示为转发值 `xhigh`）。
- 输入、思考、回答共用每路上下文上限；网关通过工作进程 tokenize 后检查输入加输出额度。
- 省略输出上限时使用 `min(4096, 剩余上下文)`；同时填写两个字段时 `max_completion_tokens` 优先。
- `stream:true` 返回 `text/event-stream`，默认请求 usage；普通请求返回 JSON。
- 网关统一设置 thinking 开关，关闭思考使用 `reasoning_effort:"none"`。

```bash
curl http://127.0.0.1:18982/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen38-27b-w3a4","messages":[{"role":"user","content":"你好"}],"max_tokens":512,"reasoning_effort":"none"}'
```

流式示例：

```bash
curl -N http://127.0.0.1:18982/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen38-27b-w3a4","messages":[{"role":"user","content":"解释 KV 缓存"}],"stream":true,"max_tokens":1024,"reasoning_effort":"medium"}'
```

视觉消息使用聊天 content 数组：

```json
{"model":"qwen38-27b-w3a4","messages":[{"role":"user","content":[{"type":"text","text":"描述这张图片"},{"type":"image_url","image_url":{"url":"data:image/png;base64,<PNG_BASE64>"}}]}],"max_tokens":512}
```

## 5. 图像 API

### Qwen-Image

网关省略图像 model 时默认 `qwen-image21`，其他参数交给图像工作进程校验。

| 参数 | 说明 |
|---|---|
| `prompt` | 必填，1–512 个字符 |
| `size` | `1024x1024` 或 `2048x2048`；工作进程默认 2048x2048；编辑仅 1024x1024 |
| `mode` | 生成：`text-to-image` 或 `rgba`；编辑：`edit` |
| `seed` | 默认 42；整数 0 ≤ seed < 2⁶³ |
| `n` | 仅 1 |
| `steps` / `guidance` | 必须为 40 / 1.0 |
| `response_format` | 仅 `b64_json` |
| `image_b64` | 单张编辑参考图，原始 PNG base64，无 data URL 前缀 |
| `images_b64` | 1–4 张 PNG base64；与 image_b64 二选一 |

```bash
curl http://127.0.0.1:18982/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen-image21","prompt":"山间木屋，清晨薄雾","size":"1024x1024","mode":"text-to-image","seed":42,"n":1,"steps":40,"guidance":1.0,"response_format":"b64_json"}'
```

编辑请求示例（将占位内容替换为 PNG base64）：

```json
{"model":"qwen-image21","prompt":"将背景改成雪山","mode":"edit","size":"1024x1024","images_b64":["<PNG_BASE64>"],"seed":42,"n":1,"steps":40,"guidance":1.0,"response_format":"b64_json"}
```

编辑参考图合计像素不超过 4,194,304；每张参考图也受相同上限限制。上述编辑 JSON POST 到 `/v1/images/edits`。响应图像在 `data[0].b64_json`，指标在 `metrics`。

### FLUX

仅支持 `/v1/images/generations`；网关实际转发 `prompt` 和 `seed`，默认 seed 为 42。
`engine` 精确取值：`Paiton`（默认）或 `Stock (Diffusers)`。不要套用 Qwen-Image 的尺寸和编辑参数。

```json
{"model":"flux2-klein","engine":"Paiton","prompt":"一只坐在窗边的猫","seed":42}
```

返回 `data[0].b64_json` 与 `metrics`。

## 6. 视频 API

POST `/v1/videos/generations`，省略 model 时默认 `minimax-h3`。prompt 必填；不接受 images_b64。
当前为同步接口，长任务须给客户端足够的超时时间。成功后将相对产物 URL 按网关地址解析。

### MiniMax H3

| 参数 | 默认/范围 |
|---|---|
| `preset` | 无多模态参考时默认 `turbo8`，可选 `turbo4`；有参考时默认 `reference`（20步质量档），可选 `reference-turbo4`（专用4步预览） |
| `width` / `height` | 默认 864×480；各320–1344、32的倍数，总面积≤1344×768，支持竖屏 |
| `frames` | 默认124；参考模式96–362，按17k+5向上对齐，360对应362帧约15.08秒；旧首尾帧模式仍接受124–364且为4的倍数 |
| `seed` | 默认771，非负安全整数 |
| `first_frame_b64` / `last_frame_b64` | PNG base64首尾帧条件，不能与Ref2VA参考混用 |
| `reference_images_b64` | PNG base64数组，最多9张；按顺序对应 `<Picture 1>` 至 `<Picture 9>` |
| `reference_videos_b64` | 视频文件base64数组，最多3段；各2–15秒，总时长≤15秒，对应 `<Video 1>` 至 `<Video 3>` |
| `reference_video_audio` | 默认false；true时把视频原音轨接入对应参考音频，音频标签按有音轨的视频顺序编号 |
| `reference_image_size` | `match` 默认：参考图按输出面积缩小；`max`：保留至2048短边，身份细节更多、耗时和内存增加 |
| `steps` | `reference` 默认20，可设1–50；建议20–25；`reference-turbo4` 固定4 |
| `engine` | 参考模式默认 `paiton`；可选 `stock` 基础路径对照；旧首尾帧预设保持原实现 |

Ref2VA使用专用扩散权重，支持9张图与3段视频同时输入（合计12文件）。图片可指定身份、物体、服装、场景或风格；视频用于动作、运镜、剪辑或视频编辑，不局限于首帧。提示词应说明每份素材的职责。

API在GPU切换前校验并将视频转为24fps，保持宽高比；已符合尺寸的24fps常用编码视频直接复用视频流，其他视频以CRF18转码。可选音轨转为32kHz立体声。参考视频不能长于目标输出，否则返回400要求增加 `frames`，避免底层按输出长度静默截断。底层仍会按17k+5向下对齐参考帧，实际帧数见 `metrics.references.effective_video_frames`。

JSON正文仍受32MiB单请求及64MiB全局预留预算约束；大素材优先使用公共ComfyUI原生模板上传文件。不要把可接入数量上限当作最高分辨率、最长视频、大量参考同时运行的性能保证。动态VRAM、异步权重卸载与 `--disable-smart-memory` 阶段卸载共同启用，不会自动降低输出时长或采样步数。

```json
{"model":"minimax-h3","prompt":"镜头缓慢掠过海边，波浪拍打沙滩","preset":"turbo8","width":864,"height":480,"frames":124,"seed":771}
```

#### 多图与视频混合参考示例

```python
import base64, requests
from pathlib import Path
b64 = lambda path: base64.b64encode(Path(path).read_bytes()).decode()
result = requests.post("http://127.0.0.1:18982/v1/videos/generations", json={
    "model": "minimax-h3", "preset": "reference", "steps": 20,
    "prompt": "Use <Picture 1> for identity, <Picture 2> for clothing, and <Video 1> for movement and camera. Natural cinematic lighting. Audio: ambient sound.",
    "reference_images_b64": [b64("person.png"), b64("clothing.png")],
    "reference_videos_b64": [b64("movement.mp4")],
    "width": 864, "height": 480, "frames": 360, "seed": 771
}, timeout=3600)
result.raise_for_status()
print(result.json())
```

仅参考图时省略 `reference_videos_b64`；仅参考视频时省略 `reference_images_b64`。以上为调用参数示例，最高配置的本机验证边界见 [H3参考接入](H3_REFERENCE_FEASIBILITY.md)。

视频响应的 `model` 为内部名称 `h3`。`generation_seconds` 为后端流程耗时，`gateway_total_seconds` 包含排队与切换。同步调用等待结果；持久任务接口见下一节。

## 持久媒体任务 API（与 MCP 共用）

媒体接口的完整结构与 MCP 工具对应关系见 [接口与控制台结构](INTERFACES.md)。

这些接口仅供本机非浏览器客户端，必须携带有效 `Authorization: Bearer <key>`；拒绝 Origin，不在公网允许列表内。素材和任务按密钥身份隔离，其他身份无法读取。返回的 job_id 可在同一身份的 API / MCP 中继续查询。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/v1/media/assets?kind=image` 或 `kind=video` | `application/octet-stream` 二进制上传，返回 asset_id（201） |
| POST | `/v1/media/jobs` | `{tool,arguments}`，tool 为 generate_image / edit_image / generate_video（`run_goldfish_workflow` 为兼容别名）；接受任务返回 202 |
| GET | `/v1/media/jobs?offset=0&limit=20` | 当前身份的持久任务，分页上限 100 |
| GET | `/v1/media/jobs/{job_id}?wait_seconds=10` | 查询任务；短等待 0–20 秒 |
| POST | `/v1/media/jobs/{job_id}/cancel` | 仅在派发前可取消；以 cancellable 字段为准 |
| GET | `/v1/media/artifacts/{artifact_id}` | 作品元数据与本机文件路径 |
| GET | `/v1/media/artifacts/{artifact_id}/content` | 下载作品（MCP 用 `download_artifact` 落盘） |

示例请求体（需要实际推理，不是连通性检查）：

```json
{"tool":"generate_video","arguments":{"request_id":"h3-001","prompt":"镜头缓慢掠过海面","duration_seconds":10,"resolution":{"aspect_ratio":"16:9 (Widescreen)","megapixels":1.5}}}
```

生成工具返回成功仅表示已接受；查询到 `succeeded` 后再取作品。断开连接不取消任务；结果 `unknown` 时先检查，不能自动重新提交。每个 request_id 在同一身份内幂等，内容不同则拒绝。

媒体能力 `/v1/media/models` 与 MCP 共用 manifest；新增 `capabilities` 和 `runtime_topology` 供程序了解执行后端。能力发现不加载 GPU，`capabilities_only: true` 不表示模型正在运行。Wan 请求已拒绝，视频只支持 minimax-h3。

## 7. 面板查询与配置

### `/data`

- `model`：`llm` / `qwen-image` / `flux` / `h3`；省略时跟随切换目标或运行引擎。
- `minutes`：15、30、60；默认 30。
- `window`：5、15、30、60 秒；默认 30，用于吞吐统计窗口。
- 返回 runtime_topology、values、trends、recent、sampling、current_model、switching_target、engine_switch、llm_policy、llm_engine、kv_forecast、kv_preview_plan、kv_budget 等。
- 没有有效采样的指标为 null。历史 KV 布局不代表当前实际分配或满载校准。

```bash
curl 'http://127.0.0.1:13000/data?model=llm&minutes=30&window=30'
```

### `/api/engine-logs`

model 使用内部名称；省略时优先 Qwen 配置切换目标，再使用调度目标/租约模型/运行模型。
返回 output、startup_output、available、containers、container_id、switching、engine_switch 等；部分字段因服务不同为空。
engine_switch 包含目标服务、阶段、启动器/调度器事件；容器日志按当前切换起点过滤。Qwen 的旧容器启动日志在配置切换时被抑制。

```bash
curl 'http://127.0.0.1:13000/api/engine-logs?model=h3'
```

### `/api/llm-mode`

mode：`custom`、`throughput`、`long`、`long-single`。
预设分别为 throughput=64K×8、long=192K×2、long-single=256K×1；custom 必须提供上下文和并发。

| 参数 | 范围 |
|---|---|
| `context_tokens` | 整数 1024–262144 |
| `concurrency` | 整数 1–8 |
| `eager` | 布尔值，默认 false |
| `kv_budget_bytes` | 整数字节，1–32 GiB；省略时上下文 ≤64K 使用 8,859,648,000，否则 8 GiB |

```bash
curl http://127.0.0.1:13000/api/llm-mode \
  -H 'Content-Type: application/json' \
  -d '{"mode":"custom","context_tokens":65536,"concurrency":6,"eager":false,"kv_budget_bytes":8859648000}'
```

此调用有实际重启行为。成功响应包含 mode、policy、budget；未改变配置时可返回 unchanged。配置切换期间新推理请求暂停，冲突通常为 409。合法但超预算的草稿不会在提交前保证可加载成功。

## 8. 本机调度控制（18990）

| 方法 | 路径 | 请求 |
|---|---|---|
| GET | `/status` | 无请求体 |
| POST | `/acquire` | `{ "model":"llm", "timeout":900, "shared":true }` |
| POST | `/renew` | `{ "token":"<租约token>" }` |
| POST | `/release` | `{ "token":"<租约token>" }` |

acquire 的 model 使用内部名称，timeout 为秒，限制在 1–900；shared 仅对 llm 生效。返回 token、model、lease_seconds。
租约当前有效期 120 秒；长任务应定期续租，工作台自身每 30 秒续租。后端仍忙时 release 不会立即释放 GPU 所有权。
使用统一推理 API 时网关会管理租约，无须客户端另行 acquire。

## 9. 错误与范围

- 400：参数、模型、Origin 以外的请求校验错误；控制 API 操作异常通常返回 409。
- 401：缺失密钥、密钥无效/停用/删除。
- 403：非本地浏览器 Origin、控制端口带 Origin、只读预览实例提交。
- 404：不存在的路由、无效/缺失视频产物。
- 405：网关不支持的方法；控制端口无匹配路由使用 404。
- 409：配置切换冲突/新请求暂停等。
- 429：密钥或全局并发/频率限制，或等待 KV 容量超时；通过下表的 `error.code` 区分。
- 503：排空、加载失败或获得租约后的工作进程错误；上游聊天错误码可直接透传。
- SSE 开始后的错误可能表现为连接中断，不再返回新的 JSON 错误体。

生成接口为按需加载，不要把 /health 的 ready 当作任一模型已热启动。

### 入口限流与调度错误代码

HTTP 状态表示错误类别，`error.code` 表示具体原因；同为 429 的错误不再共用原因代码或说明。定义统一位于 `platforms/workbench/lib/api-errors.mjs`。

| `error.code` | HTTP | 原因 |
| --- | --- | --- |
| `API_KEY_REQUIRED` | 401 | 未携带必需的 API 密钥 |
| `API_KEY_INVALID` | 401 | 密钥无效、已停用或已删除 |
| `API_KEY_CONCURRENCY_LIMIT_EXCEEDED` | 429 | 当前密钥的并发名额已满，且已关闭排队 |
| `GLOBAL_CONCURRENCY_LIMIT_EXCEEDED` | 429 | 所有密钥的总并发名额已满，且已关闭排队 |
| `API_KEY_REQUEST_RATE_LIMIT_EXCEEDED` | 429 | 当前密钥的每分钟请求数已满 |
| `GLOBAL_REQUEST_RATE_LIMIT_EXCEEDED` | 429 | 所有密钥的每分钟总请求数已满 |
| `API_KEY_QUEUE_FULL` | 429 | 当前密钥的等待名额已满 |
| `GLOBAL_QUEUE_FULL` | 429 | 服务的总等待名额已满 |
| `ADMISSION_BODY_BUDGET_EXCEEDED` | 429 | 活动/排队生成请求的原始正文预留超过 64 MiB |
| `ADMISSION_QUEUE_WAIT_TIMEOUT` | 503 | 等待入口执行名额超时，尚未提交引擎 |
| `KV_CAPACITY_WAIT_TIMEOUT` | 429 | 已进入调度，但等待 KV token 容量超时 |
| `GPU_LEASE_QUEUE_TIMEOUT` | 503 | 等待 GPU 调度租约超时 |

限额响应示例：

```json
{"error":{"code":"API_KEY_CONCURRENCY_LIMIT_EXCEEDED","type":"rate_limit_error","message":"当前密钥的并发请求数已达到上限，请等待该密钥的已有请求完成","details":{"current":1,"limit":1}}}
```

入口限额与队列已满返回 `details.current`、`details.limit`；并发/队列限制的 `Retry-After` 为建议等待的 5 秒，频率限制则为当前计数窗口剩余秒数（向上取整）。拒绝请求不消耗额度、不进入模型调度。检查顺序为密钥并发、总并发、密钥频率、总频率；同时触发多项时返回最先命中的原因，解除后仍可能命中其他限额。默认并发满时先进入有界等待，只有设置 `maxQueued: 0` 才直接返回并发限制错误。

密钥可配置 `maxQueued`（默认 8，范围 0–128）；全局可配置 `maxQueued`（默认 32，范围 0–256）、`queueWaitSeconds`（默认 900，范围 1–900 秒）。管理接口返回全局和各密钥的 `active`、`queued`。入口等待不计执行并发；放行时重新检查密钥状态、并发与频率，再计入 RPM/请求数。提高并发立即尝试放行，停用/删除密钥立即清理该密钥的等待请求。减少队列上限不驱逐已有等待者，只限制新入队请求。

密钥入口与 GPU 队列使用同一引擎合批策略，同引擎按到达顺序，跨引擎优先复用当前引擎并受批次、时间和老化限制；配置与状态字段见 [统一引擎调度](MODEL_SCHEDULING.md#统一引擎调度策略)。正文预算错误返回 `details.current_bytes`、`details.limit_bytes`、`details.requested_bytes`。

显式密钥或公网访问 `GET /v1/models` 和 `GET /v1/media/models` 时仍鉴权、计 RPM，但不占执行名额；生成与作品下载使用同一有界等待策略。所有引擎继续受单卡调度保护，见 [多人共用](PUBLIC_API.md#多人共用与所有引擎的有界排队)。

拒绝日志为结构化事件 `api_request_rejected`，含原因代码、路径、状态以及限额信息（入口日志含密钥 ID，不记录密钥内容）。入队事件为 `api_request_queued`。连接提前关闭使用独立日志事件 `api_client_disconnected` / `CLIENT_CONNECTION_CLOSED`，记录实际观察到的阶段与已耗时：`reading_request`、`waiting_for_admission`、`waiting_for_engine`、`tokenizing_request`、`waiting_for_kv_capacity`、`generating_response`。入口等待期间断开记录 `CLIENT_REQUEST_CANCELLED` / `waiting_for_admission` 并移除请求；已放行但尚未生成的请求也会退出 GPU/KV 等待，模型加载已开始时先完成加载再释放租约。该事件不证明是客户端超时或隧道故障；连接关闭后也无法再发送 HTTP 错误。生成已开始时，后端任务继续期间保留原并发占用。

## 10. 实现依据

- `platforms/workbench/server.mjs`：监听地址与 UI 分发。
- `platforms/workbench/lib/http.mjs`：统一 API 路由、校验、转发。
- `platforms/workbench/lib/llm.mjs`：模型、推理强度和配置范围。
- `platforms/workbench/lib/media.mjs`：视频参数及产物。
- `engines/image/pation-model-qwen-image-21/runtime/server.py`：Qwen-Image 请求格式。
