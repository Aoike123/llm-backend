# ComfyUI 运行时

[文档目录](README.md) · [运行与调度](RUNTIME_TOPOLOGY.md) · [引擎平台化](ENGINE_PLATFORM.md)

更新：2026-11-02。

ComfyUI 是两个引擎包共用的运行时，本身不是常驻服务：

| 引擎包 | 能力 | ComfyUI 中的图 |
| --- | --- | --- |
| [MiniMax H3](../engines/video/pation-model-minimax-h3/README.md)（`h3`） | `video.generate` | 金鱼原版工作流（持久任务）、四个 H3 图预设（同步 API） |
| [Anima](../engines/image/anima/README.md)（`anima`） | `image.generate`、`image.edit` | Anima Turbo / Aesthetic 文生图、图生图 |

两者共用 GPU 容器 `paiton-h3-comfyui-1`（`http://127.0.0.1:8188`）。调度器把它们视为同一运行时，H3 与 Anima 之间切换不重启容器。

## 按需启动

ComfyUI 不随开机启动，也没有 systemd 单元。下面三种情况会把它拉起：

- API 或 MCP 请求路由到 `h3` 或 `anima`；
- 执行 `./lab comfyui start`，即通过网关租约打开画布；
- 执行 `./lab scheduler switch h3`（或 `anima`）。

切换到 LLM、Qwen-Image 或音频引擎时，调度器会先等 ComfyUI 的 `/queue` 为空，再停止容器。画布上正在跑的原生任务同样会阻止切换。

```bash
./lab comfyui start    # 申请租约并打开画布
./lab comfyui status   # 容器状态
./lab comfyui check    # 节点注册与设备（需已运行）
./lab comfyui sync     # 把模板同步到画布工作流库，不加载模型
./lab comfyui stop     # 手动停止；活动任务期间不要用
```

`launch` 子命令是调度器的启动步骤，不要手工调用。

## 目录

```text
engines/shared/comfyui/
├── client.mjs        # 上传、/prompt 提交、历史轮询、中断、产物下载、重启恢复
├── controller.py     # ./lab comfyui
├── nodes/            # 挂进容器 custom_nodes/ 的节点
│   ├── h3_references/        # 参考视频辅助节点
│   └── packs/                # manifest.json 锁定的第三方节点包 + h3_attention_patch
├── schema/h3.json    # 原生节点 schema 快照（模板测试用）
├── workflows/        # 画布模板：catalog.json、ui/、api/
└── tests/            # 模板与同步测试
```

引擎专用的图和逻辑放在各自的引擎包里：H3 的预设图在 `graphs/`，金鱼与参考素材处理在 `lib/`；Anima 的 adapter 直接从 `catalog.json` 读取同名模板的 API 图，所以画布模板和 API 用的是同一份图。

第三方节点包（SelfLift、KJNodes、VideoHelperSuite、Text Translation、Goohaitools，多为 GPL-3.0）不进 Git，执行 `.workbench/scripts/fetch-h3-packs.sh` 按 `nodes/packs/manifest.json` 恢复。

## 挂载

| 宿主路径 | 容器路径 |
| --- | --- |
| `workspace/data/video/minimax-h3/` | `/data`：权重（H3 与 Anima 共用 `models/`）、输入、画布用户目录、编译缓存 |
| `workspace/outputs/video/minimax-h3/` | `/outputs`：画布作品 |
| `engines/shared/comfyui/nodes/h3_references/` | `custom_nodes/workbench_h3_references`（只读） |
| `engines/shared/comfyui/nodes/packs/<包>/` | `custom_nodes/<包>`（`h3_attention_patch` 只读） |

挂载在 `engines/shared/paiton/upstream/models/MiniMax-H3/compose.yaml`，路径由 `engines/shared/paiton/controller.py` 传入。

API 与 MCP 任务的产物写在任务目录（见 [MCP 存储约定](MEDIA_MCP.md)）。Anima 的结果走 `PreviewImage`，只在 ComfyUI 临时目录留一份，`/outputs` 里不再多存一份。

## 工作流模板

| 分类 | 模板 | API 图 |
| --- | --- | --- |
| 图像生成 | Anima · 文生图（Turbo） | `anima-turbo-text` |
| 图像生成 | Anima · 文生图（Aesthetic 质量档） | `anima-aesthetic-text` |
| 图像生成 | Anima · 图生图（Turbo） | `anima-turbo-image` |
| 视频生成 | H3 · 文生视频 / 首帧 / 首尾帧 | `minimax-h3-text` 等 |
| 视频生成 | H3 · 多参考图 / 参考视频 / 图像与视频混合参考 | `minimax-h3-multireference-*` |
| 第三方工作流 | 金鱼 · H3 终极篇（原版） | `yz-h3-ultimate-original` |

`./lab comfyui sync` 按“分类/模板”写入 `workspace/data/video/minimax-h3/user/default/workflows/`。用户自己的文件不动；如果托管模板被手工改过，更新前先备份到 `workspace/data/comfyui/workflow-backups/`。

画布任务进入 ComfyUI 自己的队列和历史，不算网关任务。控制台不为 ComfyUI 单独设卡片：H3 与 Anima 的卡片只显示各自的工作流任务，配置页给出共用运行时和画布入口；全部原生队列与历史在「任务中心 → ComfyUI 原生队列」。

## H3

- 文生视频与首尾帧使用 FL2VA；多图、参考视频和混合参考使用 Ref2VA。
- 同步 API 默认 Turbo8、864×480、124 帧；参考质量档默认 20 步。
- 多参考上限：9 张图、3 段视频，视频总时长 ≤15 秒。这是接入上限，不代表任意分辨率、时长和素材组合都已验收。
- 长参考的文本编码依赖 `h3_attention_patch`，原因与实测见 [H3 多参考编码](H3_REFERENCE_ENCODE.md)。

## Anima

Anima 是 CircleStone Labs 与 Comfy Org 发布的 2B 动漫与插画模型，使用 ComfyUI 原生的 UNETLoader、CLIPLoader、VAELoader、KSampler。

| 档位 | 设置 | 2026-10-25 实测（R9700，1024²，含首次加载） |
| --- | --- | --- |
| Turbo | CFG 1、10 步 euler | 文生图 14.4 秒；图生图 6.0 秒 |
| Aesthetic | CFG 4、30 步 er_sde，不加 `score_*` 标签 | 文生图 15.9 秒 |

- 依赖 `h3_attention_patch` 的全容器 math SDPA 修复；没有这个修复，KSampler 会报 `hipErrorInvalidValue`。
- 权重约 9.8 GB，按 [锁文件](../engines/image/anima/config/models.lock.json) 校验下载：

  ```bash
  python3 .workbench/scripts/fetch-locked-checkpoint.py --lock engines/image/anima/config/models.lock.json --destination workspace/data/video/minimax-h3/models
  ```

- 模板复测：`python3 .workbench/scripts/check-anima.py`，会取得 `anima` 租约，报告写到 `workspace/reports/image/anima/`。
- 许可：CircleStone Labs 非商用许可。模型不得用于付费托管服务，生成的图像可以商用。经公网 API 对外提供 Anima 之前，先确认用途符合许可。
