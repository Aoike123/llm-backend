# 存储

[文档目录](README.md) · [运行时镜像](RUNTIME_IMAGES.md) · [引擎目录](ENGINES.md) · [本机媒体 MCP](MEDIA_MCP.md)

更新：2026-11-02。

## 一处定义

所有路径只在 `platforms/platform.json` 的 `storage` 段定义一次。Python 通过 `.workbench/storage.py` 读取，网关和 MCP 通过 `platforms/workbench/lib/storage.mjs` 读取；代码里不应再出现写死的输出路径（有测试检查）。

```json
"storage": {
  "state": "workspace/data/media",
  "artifacts": "/media/aoike/Resource_Trad/Assets",
  "marker": ".llm-backend-artifacts",
  "import_roots": ["/media/aoike/Resource_Trad/Assets", "/media/aoike/Resource_Trad/Project"],
  "quota_gib": 500,
  "min_free_gib": 50
}
```

## 三类数据

| 类别 | 位置 | 内容 | 谁声明 |
| --- | --- | --- | --- |
| 状态 | `state`：内置 NVMe 上的 `workspace/data/media/` | `jobs/` 任务记录，`materials/` 导入的素材，`telemetry/` MCP 遥测与密钥 | 平台 |
| 作品 | `artifacts`：作品盘 | 见下表 | 平台 |
| 引擎数据 | `workspace/data/<…>` | 模型权重、编译与运行缓存 | 各引擎包 `engine.json` 的 `storage.data` |

状态数据小而重要，所以放在 ext4 的 NVMe 上，保证原子写和权限生效。作品体积大、给人浏览，放在作品盘上。

### 作品盘布局

```text
Assets/
├── .llm-backend-artifacts         标记文件
├── images/<YYYY-MM>/<job_id>/     API / MCP 持久任务的作品，按月分目录
├── videos/<YYYY-MM>/<job_id>/
├── audio/<YYYY-MM>/<job_id>/
├── api/                           同步 API 的产物（/artifacts/<id>.mp4）
├── canvas/                        ComfyUI 画布（容器的 /outputs）
└── manual/<owner>/                手动命令、验收和测速的输出，按引擎包或工具名分目录
```

项目里的 `workspace/outputs` 是指向作品盘根目录的唯一一条链接。报告仍在 `workspace/reports`（链接到 `~/文档/llm-backend/报告/`）。

### 引擎数据

```json
"storage": {"data": ["workspace/data/comfy"]}
```

一个目录可以由多个包同时声明，例如 H3 和 Anima 都声明 `workspace/data/comfy`，三个音频引擎都声明 `workspace/data/audio/audiocpp`，表示共用。`./lab engine status` 显示每个包占用的数据和镜像；`./lab engine remove` 只删除没有被其他包声明的目录（见 [引擎目录](ENGINES.md#接入升级与卸载)）。

## 行为

- **作品盘离线**：没有标记文件，就当作作品盘未挂载。网关仍能启动，聊天、查询照常；创建媒体任务或保存同步视频时返回 `503 ARTIFACT_STORAGE_OFFLINE`，不会写进根分区。盘挂回来后不用重启。Python 控制器（ComfyUI 画布、手动输出）同样会拒绝写入。
- **一个作品只存一份**：H3 的 API/MCP 任务完成后，网关把视频从 `canvas/api/` 移动到任务目录（同盘 `rename`），并删掉这次提交附带写出的其他文件（无音轨版 mp4 和预览图）。只有画布目录不在本机时，才退回 HTTP 下载。Anima 的结果走 ComfyUI 的临时目录，不进画布。
- **配额**：`quota_gib` 统计任务作品和素材的总量；`min_free_gib` 同时约束作品盘和状态盘的剩余空间。超出时返回 507。
- **容器读取**：audio.cpp 等按绝对路径读素材和作品的容器，通过 `storage.mounts()` 以只读方式挂载状态根和作品根。

## 2026-11-02 迁移记录

改造前有三代约定并存：家目录 `~/图片`、`~/视频`（已不存在，但文档和链接还在用），外置盘 `Assets/`（任务记录和素材也在上面），以及一条悬空链接 `workspace/outputs/api`。

- 任务记录、素材和遥测从作品盘移到 `workspace/data/media/`，逐文件 SHA256 校验后删除原件，记录里的路径同步改写。
- 644 个任务目录移到 `<kind>/<YYYY-MM>/`；ComfyUI 输出目录成为 `canvas/`；画布里 30 组与任务作品重复的金鱼输出（90 个文件）删除后，画布从 414 MB 降到 59 MB。
- 手动输出和旧的 `~/文档/llm-backend/生成物/` 并入 `manual/`；同步 API 的历史产物并入 `api/`。
- 168 条任务记录的作品在这次迁移之前就已经丢失（10-24 迁盘时没有跟过来，或指向已不存在的 `~/文档/llm-backend/MCP/`），已移到 `~/文档/llm-backend/归档/orphan-job-records/`，不再出现在网关里。
- ComfyUI 运行时的数据目录从 `workspace/data/video/minimax-h3` 改名为 `workspace/data/comfy`；旧 CPU 版 ComfyUI 的数据归档到 `~/文档/llm-backend/归档/comfyui-cpu-legacy/`。
- 完整的移动与去重清单：`~/文档/llm-backend/迁移记录/storage-20261102.json`。迁移脚本是一次性的，执行后已从仓库删除。
