# H3 图片、视频与混合参考生成可行性

[文档目录](README.md)

> 状态：2026-10-19 已接入公共 API 与三个完整原生 ComfyUI 模板；本机推理验收记录见 `workspace/reports/h3-reference-20261019/`。下文保留2026-10-13调研依据；当前接口见 [API 参考](CURRENT_API.md)。

调研日期：2026-10-13。结论来自官方文档、模型发布者和本地源码检查；当时尚未进行 Ref2VA GPU 推理验收；当前接入与验证见末节。

## 结论

H3-Base-Ref2VA 支持真正的多模态参考生成。图片可提供人物、物体、服装、场景或风格；视频可提供动作、运镜、剪辑结构，或作为视频编辑素材；图片与视频可以混合使用。应新增 Ref2VA 生成路径。

[MiniMax 官方模型说明](https://huggingface.co/MiniMaxAI/MiniMax-H3)列出的输入上限为：9 张图片、3 段视频、3 段音频，总文件数最多 12；视频及音频单段 2–15 秒，同类总时长不超过 15 秒。这是模型规格，不能直接视为本机可稳定运行的上限。

## 2026-10-13 本地已有与缺失（历史）

- 当前扩散权重是 `minimax_h3_fl2va_pruned_w4a8_mixed.safetensors`，本地模型目录尚无 Ref2VA。
- 本地构建源码 `workspace/data/runtime/rocm101/assembly/minimax-h3/comfyui/comfy_extras/nodes_minimax_h3.py` 已含 `MiniMaxH3ReferenceToVideo`，接受 `ref_images`、`ref_videos`、`ref_video_audios`、`ref_audios`。实际容器注册情况需要接入时确认。
- 已有 Qwen3-VL 编码器、视频 VAE、音频 VAE；官方 R2V 模板使用相同组件，可复用。
- `platforms/workbench/lib/media.mjs` 目前只构建首尾帧工作流；公共 H3 桥接节点也只暴露首尾帧。需要添加参考素材上传、视频解码/24fps 重采样、工作流及参数验证。
- 本地参考节点同时把视觉输入送入 Qwen 编码器和视频 VAE。视频输入是完整帧批次，Qwen 另取 2fps 语义帧；不能只提取一张首帧来实现视频参考。
- 本地节点会把参考视频截到目标输出帧数，并按 17k+5 对齐；长参考配短输出会丢失后段素材，应在接口明确校验或提示。

## 权重选择

| 路径 | 新增扩散模型下载量 | 用途 |
| --- | --- | --- |
| starsfriday Ref2VA W4A8 mixed | 约 12.5 GB | 优先验证，贴近现有量化路径 |
| Comfy-Org Ref2VA INT8 ConvRot | 约 21 GB | 兼容性对照方案，资源压力更高 |

文件来源：[W4A8 发布仓库](https://huggingface.co/starsfriday/MiniMax-H3-w4a8/tree/main)、[Comfy-Org INT8 权重](https://huggingface.co/Comfy-Org/MiniMax-H3/blob/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors)。下载体积不等于运行显存。

R2V 应使用专用 Ref2V Turbo LoRA；[官方模板](https://github.com/Comfy-Org/docs/blob/main/tutorials/video/minimax/minimax-h3-native.mdx)提供 20 步基线与 4 步加速路径。[Ref2V 4 步 LoRA](https://huggingface.co/Comfy-Org/MiniMax-H3/blob/main/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors)约 1.96 GB。现有 FL2V Turbo4/Turbo8 不应直接作为 Ref2VA 的已验收适配器。

## R9700 32GB 判断

量化权重和本地参考节点均已具备可获取的实现，因此本地接入有可行基础；AMD/ROCm 下 Ref2VA 实际兼容性、显存、速度和参考保真度仍需推理实测。

已有 FL2VA 15 秒测试曾达到约 30.34 GiB 驱动显存，参考素材还会增加编码与采样开销。因此先验证小规模输入，不能承诺全量参考、768p、15 秒同时运行。建议首轮：576×320、约 5 秒输出、`ref_image_size=match`，先单图，再两图，再 2 秒参考视频，最后单图加视频。

### 动态卸载对结论的修正

30.34 GiB 是该测试配置的使用峰值，不是模型运行的最低显存门槛。ComfyUI 可在编码、采样、解码阶段间卸载模型，也能按层按需加载权重，给激活和参考条件腾出显存。[Comfy-AIMDO 官方实现](https://github.com/Comfy-Org/comfy-aimdo)支持 AMD/HIP。

本地 H3 Compose 配置未禁用 Dynamic VRAM，使用 `--fast-disk --reserve-vram 2 --cache-ram 2`；本地 ComfyUI 启动源码对 ROCm 7.14+ 支持自动启用动态显存。是否实际初始化成功应以容器启动日志为准。2026-10-13 检查宿主机约 94 GiB 系统内存、72 GiB 可用，具备比上游 16 GB 测试环境更充足的卸载空间。

因此应把动态卸载纳入 Ref2VA 默认验证方案，32GB 显存不应据此被判断为硬性阻碍。卸载仍有传输耗时；正在计算的激活、注意力工作区和参考条件张量不能由权重卸载机制全部消除。长视频与大量参考的可运行范围仍需测量。首轮小规模测试是为了逐步测出边界，不代表只能生成低分辨率短片。

Paiton 优化对矩阵形状、量化配置及 token 数有条件限制，不能预先承诺 Ref2VA 同等加速。应先以 stock 路径确认正确性，再对比 Paiton。

## 提示词与验收

[官方参考提示词指南](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)要求明确每个参考的职责，例如把人物外观来源指向 `<Picture 1>`、动作来源指向 `<Video 1>`。官方 H3-Context-IR 编排服务未随开源权重发布，本地可按指南手工写结构化提示，再验证现有 Qwen 对素材理解和提示改写的效果。

验收用同一提示和种子替换参考素材，检查生成是否随人物外观、动作和运镜改变；记录峰值显存、耗时、身份保持、动作迁移和混合参考冲突。单纯获得可播放 MP4 不足以证明参考生成有效。

建议顺序：Ref2VA W4A8 + stock + 20 步基线 → 图片/视频/混合参考验收 → Ref2V 4 步加速 → Paiton 对照 → 公共 API 与 ComfyUI 模板接入。

## 2026-10-19 接入实现

- 新增Ref2VA W4A8扩散权重与Ref2V 4步LoRA，分别按发布仓库LFS SHA256校验；来源、版本和摘要锁定于 `engines/video/pation-model-minimax-h3/reference-models.lock.json`。
- API支持 `reference_images_b64`（9图）、`reference_videos_b64`（3视频）及混合输入。默认20步质量档，可设20–25步；4步仅作可选预览。支持最高1344×768面积与约15秒输出，不自动缩短输出或降低步数。
- API按真实视频流检查时长、总时长、分辨率并重采样至24fps；已有合规24fps编码视频复用视频流，避免重复压缩。参考视频长于输出时在GPU切换前拒绝；参考有效帧数、音轨接入情况写入响应metrics。
- 公共ComfyUI新增完整原生「多参考图生视频」「参考视频生视频」「图像与视频混合参考」模板，保留可编辑采样和解码。relay支持真实视频文件上传，工作容器新增完整帧24fps转换节点。
- 实际启动日志确认 `DynamicVRAM support detected and enabled`、`Using async weight offloading with 2 streams`。编码器、扩散模型和VAE按阶段动态加载，并启用 `--disable-smart-memory` 在切换模型时主动卸载已用模型，保留2GB VRAM预留、2GB RAM结果缓存和fast-disk策略；VAE保留原有OOM时分块解码回退。
- 完整网关回归117项通过、工作流测试6项通过、原生relay测试8项通过；真实30fps素材与工作容器帧重采样均已验证。GPU推理的分辨率、时长、参考规模、耗时和显存以本次报告逐项记录为准，不能把数量规格当作所有参数满载保证。

### 本机最终验收

主动阶段卸载配置下，单视频参考20步（576×320/124帧）135.10秒，峰值18.20GiB；9图+3视频4步预览241.37秒，峰值22.15GiB。单图参考20步长片864×480/362帧（15.083秒）753.71秒，峰值21.17GiB，带音轨，未降步数或时长。默认参考引擎为Paiton；短片同种子对照解码帧逐帧一致，但整体速度受冷/热加载、参考规模与主动卸载传输开销影响。

后续用户追加混合测试：9图+3段各2秒视频、864×480/362帧/20步，生成1345.96秒，峰值22.935GiB，带音轨，无降参数，已验证12参考与15秒同跑。以上是具体样例的观测值，最高1344×768与最大参考同时满载仍未测。素材为狐狸片段，未验收真实人物身份保持。详见 [完整验收记录](../workspace/reports/h3-reference-20261019/SUMMARY.md)。
