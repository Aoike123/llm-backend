# H3 多参考编码：32GB 显存边界与修复

更新：2026-10-25。[原生 ComfyUI](COMFYUI_NATIVE.md) · [媒体 MCP](MEDIA_MCP.md) · [H3 参考可行性](H3_REFERENCE_FEASIBILITY.md)

## 现象

带 6 张 1.5MP 参考图和结构化提示词的金鱼任务在节点 `MiniMaxH3ReferenceToVideo`（265）失败：

```text
CUDA out of memory. Tried to allocate 23.53 GiB.
GPU 0 has a total capacity of 31.86 GiB ... 26.29 GiB is allocated by PyTorch
```

2026-10-22 的 `gzr-s02a-v3`、`v4`、`v5`、`v6` 与 10-23 的 `v7` 连续五次同一位置失败；1–2 张参考图的任务全部正常。

## 根因

ComfyUI 的 `optimized_attention_for_device(..., small_input=True)` **对所有文本编码器返回 `attention_basic`**，会把整段序列铺成 `[batch*heads, tokens, tokens]` 的 float32 矩阵。Qwen3-VL-32B 的文本编码器有 64 个注意力头。

token 数量（`ref_image_size=match`，每张 2048² 参考图缩到 1216²）：

| 项目 | 数值 |
| --- | --- |
| 单张参考图网格 | 78 × 78 patch，合并后 1521 token |
| 6 张图 + 提示词 | 9933 token（实测） |
| 注意力矩阵 | 64 × 9933² × 4 B ≈ **23.5 GiB** |
| 固定占用（32B nvfp4 权重 + 激活） | ≈ 26.3 GiB |

所以 OOM 的不是模型权重，而是**一次性铺开的注意力矩阵**。门槛随 token 数平方增长，而不随图片张数线性增长：

| 参考图 | 序列长度 | 注意力矩阵 | 合计 | 结果 |
| --- | --- | --- | --- | --- |
| 1 张 | ~2.3k | 1.4 GB | ~27.7 GB | ✅ |
| 2 张 | ~3.8k | 3.8 GB | ~30.1 GB | ✅ 刚好在 31.86 GB 以内 |
| 3 张 | ~5.4k | 7.4 GB | ~33.7 GB | ❌ |
| 6 张 | ~9.9k | 23.5 GB | ~49.8 GB | ❌ |

悬崖在 2 张与 3 张之间，这也解释了为什么此前所有成功任务都只有 0–2 张参考图。判断是否超限要看 **token 总数**：2026-10-19 的“9 图 + 3 视频”能在 864×480 下跑通，因为每张图只需约 256 token。

## 修复

新增原生节点 `platforms/comfyui/worker_nodes/h3_packs/h3_attention_patch/`，当前承担三项职责：

1. **文本编码器注意力**：只把 `comfy.text_encoders.llama` 的 small-input 注意力换成 `attention_sub_quad`（按空闲显存把 query 分块，峰值约 1 GiB）；Qwen3-VL 视觉塔保持 `attention_basic`；扩散模型保持 `--use-ck-attention` 的 Comfy Kitchen int8 注意力。
2. **kv 分块下限**：`efficient_dot_product_attention` 的 `kv_chunk_size` 默认取 `sqrt(k_tokens)`（14k token 时为 118），显存紧张时会让内层循环增加约 10 倍。下限固定为 1024（最多约 33 MiB），实测只快 2%，因为显存充足时原逻辑本就选中大 chunk；保留是为了避免极端显存压力下的退化。
3. **参考图视觉缓存**：见下节。

LoRA、采样与解码路径不变。

`engines/shared/paiton/upstream/models/MiniMax-H3/compose.yaml` 增加该目录的只读挂载。节点在容器启动时加载，启动日志出现：

```text
[h3-attention-patch] llama text-encoder attention -> chunked (sub-quadratic)
[h3-attention-patch] reference vision embeddings cached by image content
```

改动后需重启容器（`docker restart paiton-h3-comfyui-1` 或 `./lab comfyui start`）。回滚方法：删除 compose 中的挂载行和节点目录，再重启。目录内的 `__init__.py.subquad.bak` 是加入缓存前的两功能版本。

## 编码缓存（2026-10-25）

ComfyUI 的节点缓存按输入哈希复用；此前参考图上传使用 `reference-<randomUUID>.png`，每次都是新文件名，`LoadImage` 输入永不重复，**缓存从未生效**。两处改动让它真正生效：

| 层 | 位置 | 作用 |
| --- | --- | --- |
| 网关 | [media.mjs](../platforms/workbench/lib/media.mjs) `contentId` | 参考图按 sha256 前 32 位命名；ComfyUI 上传时同名且内容一致会复用原文件 |
| 文本编码器 | `h3_attention_patch` 的 `preprocess_embed` 包装 | 图像 → Qwen3-VL 视觉 embedding 按图像内容缓存，与提示词无关；条目存 CPU、LRU 12 条，命中时搬回 GPU |

实测（2 张 1.5MP 参考图、1664×928、124 帧）：

| 提交方式 | 耗时 | 缓存行为 |
| --- | --- | --- |
| 首次 | 496.6 s | 无缓存 |
| 完全相同 | 2.0 s | 整图缓存 |
| 只换 seed | 317.0 s | 编码命中，只跑扩散 |
| 换提示词 | 482.9 s → **396.4 s** | 视觉塔命中（日志 `vision cache hit`），语言编码与扩散重跑 |

6 张参考图时视觉塔约 250 s，换提示词可从 1158 s 降到约 900 s。视觉塔约 40 s/张，与提示词无关，是缓存收益的上限。缓存驻留内存，容器重启即清空；LRU 只保留 12 条，超过两组 6 图参考会淘汰最早的。

## 实测

`gzr-s02a-v8`（6 图、1664×928、243 帧、10.125 秒、含音轨）：任务总耗时 1453 秒，成片 12.2 MB。

参考编码分阶段（热页缓存，2026-10-23 单独测量）：

| 阶段 | 耗时 | 占比 |
| --- | --- | --- |
| Qwen3-VL 视觉塔（6 张图） | 250.3 s | 67% |
| 视频 VAE 编码 6 张图 | 28.4 s | 8% |
| 语言编码（分块注意力 + MLP） | ≈ 92 s | 25% |
| 合计 | 370.8 s | — |

容器刚重启、32B 权重需从磁盘冷读时，整段编码会多出数分钟。视觉塔约 **40 秒/张**，与参考图数量线性相关。

## 没有采用的方案

| 方案 | 结论 |
| --- | --- |
| flash SDPA 跑语言编码器 | 不可用。这台机器（ROCm 10.0 / gfx1201）的因果 flash kernel 在同一进程**第二次调用**必报 `hipErrorInvalidValue`（非因果连续调用正常；fp16、K/V 展开、`TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL`、`empty_cache`、换 stream 均无法绕过）。对应修复 [PyTorch PR #188114](https://github.com/pytorch/pytorch/pull/188114) 已关闭但**未合并** |
| 改用 SDPA mem-efficient（`EFFICIENT_ATTENTION`） | 不可用，且与 flash 同病。2026-10-24 复测：fp16/bf16 × causal/非 causal 四组组合全部是**第一次成功、第二次 `hipErrorInvalidValue`**，此后同一进程内连 `torch.randn` 都分配失败。表现为整个 GPU 上下文被污染，不是显存不足。这解释了 ComfyUI 对 AMD 一刀切关闭 pytorch attention 的判断依据 |
| 视觉塔改 bfloat16 | 收益不足。整段编码 370.8 s → 326.1 s，单张仍 39–41 s，说明视觉塔是访存受限而非精度问题 |
| 重建 torch 2.12 + 该补丁 | 不划算。需从 fork 构建 1–3 小时，且 `torchvision`、`comfy-kitchen`、Paiton 算子均按原 ABI 编译，收益只有语言编码约 90 秒 |

ROCm 10.1 本身已在本机运行（宿主 SDK `10.1.0-3`），其优化方向是数据搬运；flash 问题属于 PyTorch 的 CK 内核，不在 SDK。参见 [ROCm 10.1 升级记录](rocm101-upgrade.md)。

## 运维结论

- 6 图 × 1.5MP 现在可以直接跑，代价是编码变慢（分块 fp32 注意力）；
- 编码时间随参考图数量线性增长（视觉塔 ~40 s/张），不随张数突变；
- **批量出片先按分镜分组、再组内多 seed**：同分镜换 seed 走节点缓存（单条约 317 s），不同分镜换提示词走视觉缓存（省 ~250 s）；
- 想继续提速，优先降低参考图分辨率（每张 token 数按面积缩放），或对视觉塔做性能剖析；不要再从 flash / mem-efficient SDPA 方向投入，两者在本机都是第二次调用必崩的 CK 内核缺陷；
- 补丁目录是定制版，ComfyUI 镜像升级会覆盖挂载内容，升级后需确认两行启动日志都在。
