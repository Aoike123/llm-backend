# 接口与控制台结构（MCP / API / 控制台）

更新：2026-10-23。[媒体 MCP](MEDIA_MCP.md) · [API 参考](CURRENT_API.md) · [运行模式](RUNTIME_TOPOLOGY.md)

本页描述三件事的当前结构：对外 API、MCP 工具面、控制台导航。三者共用同一个 Node 进程和同一套 GPU 准入。

## 一、进程与端口

```text
浏览器 ──13000─┐
               ├─ Next.js 页面 + /api/mcp/* /status /v1/* /artifacts/* 代理
程序/公网 ─18982─┼─ 统一推理网关（鉴权、媒体任务、模型目录）
调度器 ───18990─┘─ GPU 控制面（acquire / renew / release、引擎日志）

MCP 客户端 ──stdio──> platforms/mcp/server.mjs ──HTTP 18982 + Bearer──> 网关
```

| 端口 | 监听者 | 职责 |
| --- | --- | --- |
| 13000 | Next.js 页面 + 代理 | 控制台；把 `/api/mcp/*`、`/status`、`/metrics`、`/health`、`/data`、`/api/llm-mode`、`/api/engine-logs`、`/v1/*`、`/artifacts/*` 转发给同进程 handler |
| 18982 | 推理网关（先鉴权） | 聊天、生图、编辑、视频、素材、持久任务、作品 |
| 18990 | 控制面 | 仅本机 JSON 客户端；拒绝浏览器 Origin；只接受 POST 的租约接口 |
| 8188 | 独立容器 | ComfyUI 原生队列与执行（不在 Node 进程内） |
| 18984 | 独立容器 | CPU 视觉编码（LLM 图片输入） |
| 18986 | 独立容器（按需） | CosyVoice 3 语音合成，仅网关媒体任务调用 |
| 19090 / 19100 / 19101 | 监控容器 | Prometheus / node-exporter / GPU 采集器 |

## 二、API 层

### 生成类（四个）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/images/generations` | 生图（FLUX / Qwen），同步返回 |
| POST | `/v1/images/edits` | Qwen 编辑，同步返回，1–4 张参考 |
| POST | `/v1/videos/generations` | 视频生成（H3），同步返回 |
| POST | `/v1/media/jobs` | 持久任务（图像 / 视频），返回 202，MCP 走这条 |

### 目录与素材

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/models` | 聊天模型与已保存额度 |
| GET | `/v1/media/models` | 媒体能力目录 + `runtime_topology` + 参考上限；不加载模型 |
| POST | `/v1/media/assets?kind=image\|video\|audio` | `application/octet-stream` 上传，返回 201 与 asset_id |

### 任务与作品

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/media/jobs` | 当前身份的持久任务，分页上限 100 |
| GET | `/v1/media/jobs/{job_id}?wait_seconds=` | 查询，短等待 0–20 秒 |
| POST | `/v1/media/jobs/{job_id}/cancel` | 仅派发前可取消，以 `cancellable` 为准 |
| GET | `/v1/media/artifacts/{artifact_id}` | 作品元数据与本机路径 |
| GET | `/v1/media/artifacts/{artifact_id}/content` | 二进制下载 |

### 运维与内部

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status`、`/health`、`/metrics`、`/data` | 网关状态、健康、Prometheus 指标、控制台数据 |
| POST | `/internal/mcp/events` | MCP 遥测，凭 `x-media-telemetry-token` |
| GET/POST | 18990 `/status`、`/acquire`、`/renew`、`/release`、`/workflow-event` | GPU 租约与工作流事件 |

鉴权：Bearer 密钥；本机同步接口保留可信兼容路径；媒体素材、任务、作品必须使用专用有效密钥，按身份隔离。执行侧统一经 GPU Coordinator 取租约，ComfyUI 队列为空才允许切换后端。

## 三、MCP 层

- 传输：stdio。客户端按 `~/.config/llm-backend/media-mcp.json` 启动 `lab mcp stdio`；
- 配置项：`base`（默认 `http://127.0.0.1:18982`）、`api_key`、`telemetry_token`、`import_roots`、`download_roots`；可用 `MEDIA_GATEWAY_URL`、`MEDIA_API_KEY`、`MEDIA_MCP_CONFIG`、`MEDIA_IMPORT_ROOTS`、`MEDIA_DOWNLOAD_ROOTS` 覆盖；
- 工具面 **11 个**，其中生成类 **4 个**（图/编辑/视频/语音）。

| 工具 | 类型 | 对应 HTTP |
| --- | --- | --- |
| `generate_image` | 生成 | `POST /v1/media/jobs`（tool=generate_image） |
| `edit_image` | 生成 | `POST /v1/media/jobs`（tool=edit_image） |
| `generate_video` | 生成 | `POST /v1/media/jobs`（tool=generate_video，H3 原版工作流） |
| `generate_audio` | 生成 | `POST /v1/media/jobs`（tool=generate_audio，CosyVoice 3 RL，支持 `[shan4]` 拼音） |
| `list_media_models` | 目录 | 本地返回图像/语音模型与视频工作流清单，不加载模型 |
| `import_media` | 素材 | `POST /v1/media/assets`；可读资源盘 `Assets`、`Project`、工作区与追加的 `import_roots` |
| `get_job` | 任务 | `GET /v1/media/jobs/{id}?wait_seconds=` |
| `list_jobs` | 任务 | `GET /v1/media/jobs` |
| `cancel_job` | 任务 | `POST /v1/media/jobs/{id}/cancel` |
| `get_artifact` | 作品 | `GET /v1/media/artifacts/{id}` |
| `download_artifact` | 作品 | `GET /v1/media/artifacts/{id}` + `/content`，写入下载根（默认 Resource_Trad/Assets） |

### 任务模型

- 提交返回 `202` 与 `job_id`，只代表“已接受”；完成状态用 `get_job` 轮询；
- 状态：`queued → waiting_for_admission → preparing → waiting_for_engine → dispatching → running → saving → succeeded`，另有 `failed / cancelled / unknown`；
- `unknown` 表示后端结果不确定，必须先检查，禁止自动重复提交；后端明确报错、未真正提交或作品不可用都直接记为 `failed`（`BACKEND_FAILED` / `JOB_FAILED` / `ARTIFACT_INVALID`）；
- 每个 `request_id` 在同一身份内幂等，内容不同会拒绝。

### 下载约定

`download_artifact(artifact_id, path?)`：

- 默认落到 MCP 进程工作区的 `downloads/<artifact_id>.<ext>`（沙箱取件，不写资产库）；
- 显式路径相对第一个根解析，必须落在允许根内（默认根为工作目录），拒绝 `..`、绝对越界与符号链接逃逸；
- 返回 `local_path`、`bytes`、`sha256` 和短期签名的 `content_url`（10 分钟、绑定 owner，可直接 GET，无需 Header）；
- `content` 也接受正常 Bearer 调用；签名失效返回 403。

### 资产存储

统一到 HDD：`/media/aoike/Resource_Trad/Assets`

| 子目录 | 内容 |
| --- | --- |
| `images/` `videos/` `audio/` | 各类型作品（任务产物与引擎直出） |
| `materials/` | 参考素材（`import_media`） |
| `records/jobs/` `records/telemetry/` | 任务 JSON 与调用记录 |
| `engine/` | 预留的引擎直出目录 |

### 调用规范

- 先 `list_media_models` 查看当前运行引擎，能满足需求就复用；
- 同一批任务尽量连续提交给同一引擎；切换会排空队列并冷启动后端；
- 生成后轮询 `get_job`，不要重复提交；
- 作品先 `get_artifact` 看元数据，再 `download_artifact` 落盘；
- 参考素材先 `import_media` 并复用 asset_id。

## 四、控制台

单页应用，**没有 URL 路由**：`app/page.jsx` 用 React state 切换区块。刷新会回到总览。

| 区块 | 内容 | 数据源 |
| --- | --- | --- |
| 总览 | 指标卡、模型服务目录、设备状态 | `/status`、`/data` |
| 任务中心 | 媒体任务与作品 | `/api/mcp/jobs`、`/data` |
| 模型服务 | 每个服务的运行监控 / 模型配置 / 任务记录三个 tab | `/status`、`/data`、ComfyUI 队列 |
| API | 生成类 4 个端点 + 素材/任务/作品表 | 静态表 + `/v1/media/models` |
| MCP | 工具分组、调用规范、调用记录 | `/api/mcp/*` |
| 访问管理 | 密钥与额度 | `/api/access-keys` |

跳转关系：

```text
总览 ─ 模型卡 ───────────→ 模型服务（并选中该模型）
总览 ─ 查看任务中心 ─────→ 任务中心
侧边栏 ──────────────────→ 六个区块互切
模型服务 ─ 顶部 tab ─────→ 运行监控 / 模型配置 / 任务记录
模型服务(H3) / 侧边栏 ───→ http://127.0.0.1:8188（新窗口）
MCP 页 ─ 任务行 ─────────→ 同页任务详情
MCP 页 ─ 作品 ───────────→ /api/mcp/artifacts/{id}（预览 / 下载）
```

服务选中逻辑：`selected ?? followedEngine(data) ?? data.model ?? 'llm'`，手动点选优先，否则跟随当前运行后端。

## 五、兼容与约定

- **旧工具名**：`run_goldfish_workflow` 仍被 HTTP 与 MCP 接受，内部归一化为 `generate_video`，不出现在工具清单；历史任务的 `tool` 字段在控制台展示时映射为新名；
- **端口归属**：13000 是页面与代理，18982 是推理 API，18990 是控制面，三者同进程不同职责；
- **状态不落盘的部分**：控制台区块切换、服务选中不进入 URL；任务与作品以 job_id / artifact_id 为准；
- **MCP 进程不热更新**：修改工具清单后需要客户端重连。

## 六、变更记录

2026-10-23：

- 视频工具由 `run_goldfish_workflow` 统一为 `generate_video`（旧名兼容）；
- 新增 `download_artifact` 与下载根限制；
- MCP 工具从 9 个增加到 10 个，生成类固定为 3 个；2026-10 新增 `generate_audio`，共 11 个、生成类 4 个；
- 控制台 MCP 页加入调用规范与工具分组，API 页按“生成 4 / 素材 / 任务 / 作品”重排；
- 文档同步更新 [媒体 MCP](MEDIA_MCP.md)、[API 参考](CURRENT_API.md)、[运行模式](RUNTIME_TOPOLOGY.md)、[项目现状](PROJECT_STATUS.md)。

## 七、相关文件

```text
platforms/workbench/server.mjs           # 三端口与路由分发
platforms/workbench/lib/http.mjs         # API 与控制面路由
platforms/workbench/lib/mcp-routes.mjs   # /api/mcp/* 与 /v1/media/*
platforms/workbench/lib/media-manifest.mjs  # 工具 Schema 唯一来源
platforms/comfyui/...                    # ComfyUI 原生执行
platforms/mcp/server.mjs                 # stdio 服务与工具分发
platforms/mcp/client.mjs                 # HTTP 客户端、导入与下载
platforms/mcp/manifest.mjs               # MCP 工具清单
```
