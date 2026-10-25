# H3 原生 ComfyUI

更新：2026-10-20。[当前运行模式](RUNTIME_TOPOLOGY.md) · [工作流清单](COMFYUI_WORKFLOWS.md)

唯一 ComfyUI 是 GPU 容器 `paiton-h3-comfyui-1`，地址 `http://127.0.0.1:8188`。它同时提供 H3 画布与执行；没有 CPU 中转实例，没有独立 8190 服务。Wan 已删除，不接入其他服务的 API 桥接节点。

## 工作流

保留 6 个 H3 官方预设模板、金鱼原版和 3 个 Anima 生图模板（UNETLoader → KSampler → VAEDecode → SaveImage）。扩散模型、LoRA、CLIP、VAE、条件、噪声、采样、解码与保存都在同一原生进程执行。

```text
模型加载 → LoRA / 优化 → 条件与 LATENT → 采样
  → 视频 VAE / 音频 VAE 解码 → 合成 → SaveVideo
```

文生/首尾帧使用 FL2VA；多图、参考视频与混合参考使用 Ref2VA。API 默认 Turbo8、864×480、124 帧；参考质量档默认 20 步。多参考最多 9 图、3 视频，视频总参考时长 ≤15 秒。最大接入数量不等于任意分辨率、时长和素材组合均已验收。性能及保真验证见 [H3 参考接入](H3_REFERENCE_FEASIBILITY.md)。

金鱼工作流依赖的 SelfLift、KJNodes、翻译、VHS、Goohaitools 等原生节点继续保留。

## 长参考的文本编码

Qwen3-VL 文本编码器在 ComfyUI 中固定走 `attention_basic`，会为整段序列铺开 float32 注意力矩阵；6 张 1.5MP 参考图约 9.9k token，单次需要 23.5 GiB，32GB R9700 必 OOM。修复节点 `platforms/comfyui/worker_nodes/h3_packs/h3_attention_patch/` 只把 `comfy.text_encoders.llama` 的小输入注意力改为按空闲显存分块的 `attention_sub_quad`，视觉塔与扩散模型路径不变，compose 增加该目录的只读挂载，重启容器生效。

token 与显存的关系、实测分阶段耗时、flash SDPA 与 bfloat16 的否决记录见 [H3 多参考编码](H3_REFERENCE_ENCODE.md)。

## 文件与挂载

| 宿主项目路径 | 容器用途 |
| --- | --- |
| `workspace/data/video/minimax-h3/` | `/data`，权重、输入、用户目录及编译缓存 |
| `workspace/data/video/minimax-h3/user/default/workflows/` | 页面工作流库 |
| `workspace/outputs/video/minimax-h3/` | `/outputs`，原生作品；宿主路径可为分类存储的符号链接 |
| `platforms/comfyui/worker_nodes/h3_references/` | 参考视频原生辅助节点 |
| `platforms/comfyui/worker_nodes/h3_packs/` | 金鱼工作流等所需原生节点包 |

API 提交的同步视频另存 `workspace/outputs/api/`；持久媒体任务的作品按 [MCP 存储约定](MEDIA_MCP.md) 保存。

## 启停与同步

```bash
./lab comfyui start   # 通过网关租约切到 H3，可能停止当前其他 GPU 后端
./lab comfyui status
./lab comfyui check
./lab comfyui sync    # 只同步现有 H3 模板，不加载模型
```

修改模板后同步，不覆盖已打开的画布。保留模板修改版本和历史备份；自定义工作流建议另存。Wan/API 桥接模板不再发布或进入当前库。

切到 LLM / 图片服务时，调度器等待 `/queue` 空闲再停止 ComfyUI。H3 请求会重新启动它；因此画布不是始终在线的常驻 CPU 页面。

直接画布任务使用 ComfyUI 队列与历史。API/MCP 任务先经统一准入与租约，再向同一个 ComfyUI 提交原生图。两者不能视为同一套持久任务记录；管理页面分别展示。旧整图转发、API 桥接与 CPU 前端测试是历史实现，不是当前执行路径。
