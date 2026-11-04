# 接口与控制台结构（MCP / API / 控制台）

更新：2026-11-04。[媒体 MCP](MEDIA_MCP.md) · [API 参考](CURRENT_API.md) · [运行模式](../design/RUNTIME_TOPOLOGY.md)

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
| 18982 | 推理网关（先鉴权） | 聊天、生图、编辑、视频、音频、素材、持久任务、作品；公网请求另受「公网放行」开关约束，见 [公网 API](PUBLIC_API.md) |
| 18990 | 控制面 | 仅本机 JSON 客户端；拒绝浏览器 Origin；只接受 POST 的租约接口 |
| 8188 | 独立容器 | ComfyUI 原生队列与执行（不在 Node 进程内） |
| 18984 | 独立容器 | CPU 视觉编码（LLM 图片输入） |
| 19090 / 19100 / 19101 | 监控容器 | Prometheus / node-exporter / GPU 采集器 |

## 二、API 层

### 生成类

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/images/generations` | 生图（Qwen-Image / Anima），同步返回 |
| POST | `/v1/images/edits` | 编辑（Qwen，1–4 张参考）或单图重绘（Anima），同步返回 |
| POST | `/v1/videos/generations` | 视频生成（H3），同步返回 |
| POST | `/v1/audio/speech`、`/v1/audio/voices`、`/v1/audio/separations`、`/v1/audio/transcriptions` | 音频同步路径：由网关包装持久任务，等完成后返回作品；必须带有效密钥，默认不对公网放行 |
| POST | `/v1/media/jobs` | 持久任务（图像 / 视频 / 音频），返回 202，MCP 走这条 |

同步路径不是写死的：每个已启用的能力在所属引擎包的 `platform.surface` 里声明自己的 `sync` 路径，停用引擎后路径随之消失（见 [引擎目录](../design/ENGINES.md)）。

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
| POST | `/v1/media/jobs/{job_id}/cancel` | 排队中立即取消；ComfyUI 视频任务运行中按 prompt_id 中断，ComfyUI 停止后变为 `cancelled`；图像请求开始后不可中断。以 `cancellable` 为准 |
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
- 工具面 **10 个**，其中生成类 **3 个**（图/编辑/视频）。

| 工具 | 类型 | 对应 HTTP |
| --- | --- | --- |
| `generate_image` | 生成 | `POST /v1/media/jobs`（tool=generate_image） |
| `edit_image` | 生成 | `POST /v1/media/jobs`（tool=edit_image） |
| `generate_video` | 生成 | `POST /v1/media/jobs`（tool=generate_video，H3 原版工作流） |
| `list_media_models` | 目录 | 本地返回图像模型与视频工作流清单，不加载模型 |
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

状态在内置 NVMe 的 `workspace/data/media/`：`jobs/` 任务 JSON，`materials/` 参考素材（`import_media`），`telemetry/` 调用记录。作品在作品盘 `/media/aoike/Resource_Trad/Assets/`：`images|videos|audio/<YYYY-MM>/<job_id>/`、同步 API 的 `api/`、ComfyUI 的 `canvas/`、手动输出 `manual/<owner>/`。完整说明见 [存储](../runtime/STORAGE.md)。

### 调用规范

- 先 `list_media_models` 查看当前运行引擎，能满足需求就复用；
- 同一批任务尽量连续提交给同一引擎；切换会排空队列并冷启动后端；
- 生成后轮询 `get_job`，不要重复提交；
- 作品先 `get_artifact` 看元数据，再 `download_artifact` 落盘；
- 参考素材先 `import_media` 并复用 asset_id。

## 四、控制台

所在位置写在地址栏的 hash 里（`app/use-route.mjs`）：刷新、前进后退和复制链接都会回到同一页；页面只会因为点击而切换，引擎切换不会把页面带走。

```text
#/overview                      总览
#/library                       作品库
#/tasks                         任务中心
#/services/<引擎>/<视图>        模型服务；视图为 runtime / works / tasks / config
#/engines  #/api  #/mcp  #/keys
任意页面 + ?job=<job_id>        在当前页上打开任务详情抽屉
```

| 区块 | 内容 | 数据源 |
| --- | --- | --- |
| 总览 | 调度指标、模型服务卡（含各引擎持久任务数）、最近作品、设备状态 | `/data`、`/api/mcp/overview`、`/api/mcp/jobs`、`/api/mcp/artifacts` |
| 作品库 | 全部持久任务的作品，按类型和引擎筛选、分页；已移除引擎的作品标为“（已移除）” | `/api/mcp/artifacts` |
| 任务中心 | 持久媒体任务（按状态、引擎、类型筛选）、网关请求记录、ComfyUI 原生队列 | `/api/mcp/jobs`、`/data`、`/api/mcp/runtime` |
| 模型服务 | 运行监控 / 作品 / 任务 / 模型配置（语言模型没有作品页，任务页显示网关请求记录） | `/data`、`/api/mcp/*`、`/api/engine-logs` |
| 引擎 | 引擎包启停与能力路由 | `/api/platform` |
| API / MCP / 访问管理 | 接口表、工具与调用记录、密钥与额度 | 静态表、`/api/mcp/*`、`/api/access-keys` |

任务详情是右侧抽屉，打开和关闭都不改变下面列表的滚动位置。抽屉显示作品、完整输入（提示词或合成文本、参考音频原文、语气、反向提示词等请求里的全部字段）、执行信息和生效参数。

控制台专用接口（只接受本机同源请求）：

| 路径 | 用途 |
| --- | --- |
| `GET /api/mcp/jobs?state=&engine=&kind=&offset=&limit=` | 任务列表；`state` 取 `active`/`succeeded`/`failed`/`cancelled`；`facets` 给出每个维度在其他筛选条件下的计数 |
| `GET /api/mcp/jobs/{job_id}` | 任务详情，含完整请求 `input` |
| `GET /api/mcp/artifacts?kind=&engine=&offset=&limit=` | 作品列表（成功任务的全部作品，新的在前） |
| `GET /api/mcp/artifacts/{artifact_id}` | 作品原文件，支持 `Range` |
| `GET /api/mcp/artifacts/{artifact_id}?thumb=320\|640` | 图像或视频（0.5 秒处一帧）的 WebP 预览，缓存在 `workspace/data/media/thumbs/` |

部署：`./lab services deploy` 构建到 `platform.json` 的 `next_dist` 并重启网关，同时删除其他 `.next*` 构建目录。直接 `npm run build` 不会被正在运行的网关加载。

## 五、兼容与约定

- **旧工具名**：`run_goldfish_workflow` 仍被 HTTP 与 MCP 接受，内部归一化为 `generate_video`，不出现在工具清单；历史任务的 `tool` 字段在控制台展示时映射为新名；
- **端口归属**：13000 是页面与代理，18982 是推理 API，18990 是控制面，三者同进程不同职责；
- **控制台位置在 URL hash 中**；任务与作品以 job_id / artifact_id 为准；
- **MCP 进程不热更新**：修改工具清单后需要客户端重连。

## 六、变更记录

2026-11-02：

- 控制台改为 hash 路由，新增作品库、任务筛选与详情抽屉；服务页拆成运行监控 / 作品 / 任务 / 配置；
- 作品预览改用服务端 WebP 缩略图（图像与视频），原文件支持 Range；
- 删除网关 unit 里指向旧构建目录的覆盖设置：此前控制台一直在用旧构建，新改动没有上线。

2026-10-23：

- 视频工具由 `run_goldfish_workflow` 统一为 `generate_video`（旧名兼容）；
- 新增 `download_artifact` 与下载根限制；
- MCP 工具从 9 个增加到 10 个，生成类固定为 3 个；2026-10 新增 `generate_audio`，共 11 个、生成类 4 个；2026-11 随 CosyVoice 下线移除，回到 10 个、生成类 3 个；之后生成工具按能力从已启用的引擎生成，数量随启用状态变化；
- 控制台 MCP 页加入调用规范与工具分组，API 页重排为生成 / 素材 / 任务 / 作品；
- 文档同步更新 [媒体 MCP](MEDIA_MCP.md)、[API 参考](CURRENT_API.md)、[运行模式](../design/RUNTIME_TOPOLOGY.md)、[项目现状](../guide/PROJECT_STATUS.md)。

## 七、相关文件

```text
platforms/workbench/server.mjs           # 三端口与路由分发
platforms/workbench/lib/http.mjs         # API 与控制面路由
platforms/workbench/lib/mcp-routes.mjs   # /api/mcp/* 与 /v1/media/*
platforms/workbench/lib/media-tools.mjs  # 能力定义与公共工具（不含引擎知识）
platforms/workbench/lib/capabilities.mjs # 按已启用引擎生成工具、模型目录与候选顺序
platforms/workbench/lib/registry.mjs     # 引擎包注册表：清单、启用状态、路由
platforms/workbench/lib/platform-routes.mjs # 控制台「引擎」页接口 /api/platform
engines/shared/comfyui/client.mjs        # ComfyUI 提交、轮询、中断、恢复（H3 / Anima 共用）
platforms/mcp/server.mjs                 # stdio 服务与工具分发
platforms/mcp/client.mjs                 # HTTP 客户端、导入与下载
platforms/mcp/manifest.mjs               # MCP 只保留公共工具；生成工具取自网关 /v1/media/catalog
```
