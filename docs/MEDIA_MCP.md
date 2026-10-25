# 本机图像 MCP

`local-media` 0.4.1 提供 FLUX、Qwen-Image 两个独立图像服务，以及视频生成（H3 原版工作流）。完整接口结构见 [接口与控制台结构](INTERFACES.md)。其他 ComfyUI 工作流直接调用原生 API，不自动加入 MCP。

## 接入

```bash
./lab mcp setup
./lab mcp check
```

`setup` 创建专用 API 身份，凭据保存于 `~/.config/llm-backend/media-mcp.json`（权限 0600）。已有配置保留，不自动修改外部客户端配置。

```json
{
  "mcpServers": {
    "local-media": {
      "command": "/mnt/Code/llm-backend/lab",
      "args": ["mcp", "stdio"]
    }
  }
}
```

客户端重新连接 MCP 后读取新工具清单。已运行的 stdio 进程需要重新启动才能更新。

| 配置 | 说明 |
| --- | --- |
| `MEDIA_MCP_CONFIG` | 本机凭据文件路径 |
| `MEDIA_GATEWAY_URL` | 默认 `http://127.0.0.1:18982` |
| `MEDIA_API_KEY` | 覆盖本机 API 身份，不能放入文档或工具结果 |
| `MEDIA_IMPORT_ROOTS` | 冒号分隔的追加导入目录（覆盖凭据文件的 `import_roots`）。资源盘 `/media/aoike/Resource_Trad/Assets`（随 `MEDIA_ASSETS_ROOT`）、`/media/aoike/Resource_Trad/Project` 与工作区（`MEDIA_DOWNLOAD_ROOTS`，默认当前工作目录）始终可导入 |

## 当前工具

| 工具 | 用途 |
| --- | --- |
| `list_media_models` | 查询 FLUX、Qwen-Image 能力；不启动模型 |
| `import_media` | 导入工作区或允许目录内的图像 / 视频 / 音频，返回 asset_id |
| `generate_image` | 提交 FLUX / Qwen 生图持久任务 |
| `edit_image` | Qwen 图片编辑，1–4 张参考图 |
| `generate_video` | H3 视频生成（原版工作流），可选图像/视频/音频参考及原版开关，原生 ComfyUI 执行；旧名 `run_goldfish_workflow` 仍兼容 |
| `generate_audio` | CosyVoice 3 RL 语音合成：参考音频零样本克隆、Instruct 语气、`[shan4]` 拼音标注；持久任务与 WAV 作品 |
| `get_job` | 查询自己的任务；可短等待，最多 20 秒 |
| `list_jobs` | 查询自己的任务历史 |
| `cancel_job` | 只允许派发前取消 |
| `get_artifact` | 获取作品本机路径与资源元数据 |
| `download_artifact` | 把作品下载到工作区（默认 `artifacts/`），返回路径、大小与 sha256 |

共 **11 个工具、2 个图像模型、1 个视频工作流、1 个语音模型**。视频统一走 `generate_video`（底层为 H3 原版工作流），不再保留独立的通用视频工具。MCP 的 [manifest](../platforms/mcp/manifest.mjs) 从内部媒体 API Schema 导出图像子集；不再把内部 API 支持的全部模型自动注册为 MCP 能力。该视频工作流单独列在 `workflows`，不冒充通用模型。

`prompt` 最长 **32000 字符**（Qwen 图片最长 4000 字符，2.1 管线不做截断），超长在创建任务前拒绝，并返回实际长度；金鱼提示词由原生节点完整编码（本地 tokenizer 未设截断），长度主要影响耗时与显存。任务请求体上限 128 KiB，MCP stdio 帧上限 256 KiB，均按 32000 字符的 UTF-8 体积留有余量。


## 调用规范

- 先调用 `list_media_models` 查看当前运行引擎，能满足需求就复用，不要为单个任务切换；
- 同一批任务尽量连续提交给同一引擎。切换会等待队列清空并冷启动后端，视频与 LLM 尤其明显；
- 生成工具返回的是“已接受的任务”，用 `get_job` 轮询；不要重复提交同一 `request_id`；
- 作品先用 `get_artifact` 看元数据，再用 `download_artifact` 落到工作区，避免把大文件塞进对话；
- 参考素材先 `import_media` 并复用 `asset_id`；下载目录由 `MEDIA_DOWNLOAD_ROOTS` 限定，默认当前工作目录。

## 图像任务

1. 用 `generate_image` 提交 `request_id`、`model`、`prompt`。
2. 用 `get_job` 等待 `succeeded`；返回任务不等于完成生成。
3. 用 `get_artifact` 获取本机作品路径。
4. 编辑时先 `import_media` 导入图片，再用 `edit_image` 提交参考素材 ID。

生成在客户端断开后继续。`request_id` 按身份去重；同一 ID 携带不同内容会拒绝。`unknown` 只表示结果真正不确定（响应丢失、超时、轮询中断），必须人工检查，不能自动重复提交。后端已明确报错（ComfyUI 历史为 error、`/prompt` 拒绝、图像/语音后端返回 HTTP 错误）记为 `failed` / `BACKEND_FAILED` 并带出错节点与原因；未真正提交（图构建、素材上传失败）记为 `JOB_FAILED`；后端已返回但作品不可用记为 `ARTIFACT_INVALID`。派发后不支持强制取消。

- FLUX：选择 Paiton / Stock 引擎，尺寸由后端原生决定。
- Qwen：生图 1024 / 2048，编辑输出 1024；最多 4 张参考，合计不超过 4194304 像素。
- 图片导入仅接受合法 PNG/JPEG/WebP，归一化 PNG 并保留透明度；最多 16 MiB、16777216 像素。只读取允许目录中的普通文件，不抓取 URL。
- 所有任务、素材与作品按 API 身份隔离；不会向 MCP 客户端返回密钥或大段作品 base64。
- 图像输出位于 `/home/aoike/图片/llm-backend/MCP/<job_id>/output.png`，任务和协议元数据位于 `/home/aoike/文档/llm-backend/MCP/`。

## 视频生成（H3 原版工作流）

工具：`generate_video`。旧名 `run_goldfish_workflow` 作为兼容别名保留。使用 [原版 API 图](../platforms/comfyui/workflows/api/02-video/yz-h3-ultimate-original.api.json)，不是三视图测试图；`generate_video` 只是这个工作流的对外名称。

```json
{
  "request_id": "video-001",
  "prompt": "Use <Picture 1>, <Picture 2> and <Picture 3> as character and scene references. A continuous cinematic shot.",
  "reference_asset_ids": ["asset_character1", "asset_character2", "asset_scene"],
  "duration_seconds": 10,
  "seed": 905138662823835
}
```

用 `import_media` 导入素材（kind 为 image / video / audio），按原版槽位顺序传入。上例仍沿用三个参考图位置，但不再限制只能用三张。未提供的素材槽位关闭；不传参考素材可文生视频。

| 参数组 | 对应原版开关与参数 | 默认状态 |
| --- | --- | --- |
| `reference_asset_ids` | 图像参考，最多9张 | 未传槽位关闭 |
| `reference_video_asset_ids` | 视频参考，最多3段、各2–15秒、合计≤15秒 | 未传槽位关闭 |
| `reference_audio_asset_ids` | 独立音频参考，最多3段、合计≤15秒；须同时有图像或视频 | 未传槽位关闭 |
| `reference_slots` | `images` / `videos` / `audios` 布尔数组，逐槽位开关；false 关闭该输入；提示词标签按开启素材连续编号 | 已提供素材的槽位开启 |
| `use_image_references` / `use_video_references` / `use_audio_references` | 三类参考组总开关 | true |
| `reference_video_audio` | 使用视频参考自带音轨 | false |
| `loras` | `dmad` / `mystic` / `combat` / `motion_speed` / `motion_repair` / `fight_flow`，各有 `enabled`、`strength` | 仅前两层开启；强度依次0.8、0.35、0.65、3、0.35、0.35 |
| `resolution` | `aspect_ratio`、`megapixels` | 16:9、1.5MP、32对齐 |
| `sampling` | steps、cfg、transition_step、lowres_scale、rho、w_min/w_max、upscaler_model、highres_tiling、upscaler_unload | 10步、cfg1、第6步切换、0.6、0、0.5/1、原版放大模型、false、true |
| `optimizations` | attention_enabled、sparse_enabled、sigma_shift_enabled、feed_forward_enabled、low_vram_enabled、preview_enabled，以及稀疏/分块/sigma参数 | 保持原版全部开启 |
| `output` | include_audio、crf、save_metadata、trim_to_audio、pingpong、loop_count | true、19、true、false、false、0 |

`sampling.upscaler_model="none"` 时必须显式设置 `sampling.rho>0`（省略时为0）；SelfLift-zero 可从 `rho=0.6`、`w_min=w_max=1` 开始。使用默认外部放大模型时可保持 `rho=0`。无效组合在 MCP 和媒体 API 入口拒绝，不创建任务。

总参考文件上限12；只计算开启的槽位。原生节点会对开启素材重新连续编号，例如原输入1、3开启时，提示词用 `<Picture 1>`、`<Picture 2>`；任务返回 `reference_mapping` 明确输入槽位到标签的对应关系。视频自带音轨先占用 Audio 编号，再接独立音频。视频参考在获取 GPU 租约前归一化为24fps，使用原版 VHS 视频加载节点的 H3 格式约束。独立音频归一化为32kHz双声道 WAV。`include_audio:false` 仅关闭音频解码和合成，不改变模型内部联合音视频采样。GUI 的组开关被映射为实际节点启用/旁路，不把前端开关节点提交给 ComfyUI。

例如开启战斗 LoRA、关闭第二张参考图、关闭稀疏注意力：

```json
{
  "request_id": "goldfish-combat-001",
  "prompt": "A continuous cinematic fight using <Picture 1> and <Picture 2>.",
  "reference_asset_ids": ["asset_character1", "asset_character2", "asset_scene"],
  "reference_slots": {"images": [true, false, true]},
  "loras": {"combat": {"enabled": true, "strength": 0.65}},
  "optimizations": {"sparse_enabled": false},
  "output": {"include_audio": true, "crf": 19}
}
```

未传控制参数时保留原版模型、LoRA、注意力优化、1.5MP分辨率、10步 SelfLift 和音视频链。默认10秒、24fps，按原版表达式对齐到243帧；时长接受4–15秒，默认种子905138662823835。SelfLift 保持 Euler/simple；没有把它伪装成可以直接旁路的开关。

返回持久 `job_id`，通过 `get_job`、`get_artifact` 取回MP4。任务经过现有身份准入和 GPU 服务切换，动态编译上述原版分支后向原生 `/prompt` 提交；原生 `prompt_id` 保存以便恢复，避免重复提交。输出位于 `/home/aoike/视频/llm-backend/MCP/<job_id>/output.mp4`。通用视频工具保持移除，不接受任意工作流 JSON、节点或模型路径。

导入目录默认是资源盘的 `Assets` 与 `Project` 加当前工作区，由代码给出，不再写入凭据文件；凭据文件的 `import_roots` 或 `MEDIA_IMPORT_ROOTS` 只用于追加目录。升级后重新连接 MCP 客户端以刷新 Schema。

## ComfyUI 原生调用

除专门授权的金鱼原版工作流外，ComfyUI 不经过此 MCP。调用其本机 `http://127.0.0.1:8188`：

| 接口 | 用途 |
| --- | --- |
| `GET /system_stats` | 服务健康和系统信息 |
| `POST /prompt` | 提交原生 API 格式工作流 |
| `GET /queue` | 所有原生执行与等待任务 |
| `GET /history/{prompt_id}` | 指定原生任务结果 |
| `GET /view` | 获取输出文件 |

Workbench 的 ComfyUI 服务页和任务中心读取全部原生队列及最近 100 条历史，不按模型或节点筛选。服务未启动时检测不会启动它。GPU 调度切换仍等待完整原生队列空闲。直接原生提交不自动获得网关租约或持久 `job_id`，跨服务统一准入的边界见 [运行模式](RUNTIME_TOPOLOGY.md)。

## 管理与测试

Workbench 的 MCP 页展示图像工具、金鱼专用工作流、接入配置和调用记录。旧视频任务与作品作为历史保留，不代表当前可调用能力。调用日志不保存提示词、参数或凭据；实例心跳不等于协议仍保持连接。

```bash
npm test --prefix platforms/mcp
```
