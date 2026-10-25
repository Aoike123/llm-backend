# 本机图像与视频验证（2026-10-12）

[文档目录](README.md)

硬件：Radeon AI PRO R9700 32GB，宿主 amdgpu 7.1.9.31600000、ROCm SDK 10.1。所有 GPU 任务顺序运行，模型保存在项目 NVMe。下表是少量实际请求，不代表长期稳定性或通用画质评分。

| 引擎 / 路径 | 设置 | 完成时间 | 说明 |
|---|---|---:|---|
| FLUX.2 klein / Paiton / ComfyUI | 1024方图、4步 | 2.44秒 | 热请求，Math SDPA |
| FLUX.2 klein / Paiton API | 同上 | 24.29秒 | 首轮生成含编译；另有加载31.88秒 |
| FLUX.2 klein / Stock API | 同上 | 157.20秒 | 首轮生成；另有加载39.96秒；不能与热态直接计算加速比 |
| Qwen-Image 文生图 | 1024方图、40步、schedule-int8、native fusions | 19.96秒 | 热请求 |
| Qwen-Image 文生图 | 2048方图、同上 | 107.46秒 | 热请求；官方约103秒使用不同提示词，不能当作完全匹配测试 |
| Qwen-Image 透明图 / ComfyUI | 1024方图 | 21.22秒 | alpha 有0–255范围 |
| Qwen-Image 编辑 / ComfyUI | 1024方图 | 27.21秒 | 改色有效，但纹理明显变化，保真度未验收 |
| H3 文生视频 | Turbo8、576×320、124帧、24fps | 约55秒 | 冷任务，含原生音频 |
| H3 文生视频 | Turbo8、864×480、124帧 | 105.54秒 | 冷任务；细节改善，仍有粗糙纹理 |
| H3 首尾帧 / ComfyUI | Turbo4、576×320、124帧 | 44.14秒 | 首尾参考可用，含音频 |
| H3 单参考图 / ComfyUI | Turbo4、576×320、124帧 | 34.21秒 | 含音频 |
| Wan2.2 文生视频 | TI2V 5B、20步、832×480、49帧 | 86.15秒 | 首轮含编译，不含音频 |
| Wan2.2 参考图 / ComfyUI | 同上 | 48.97秒 | 不含音频 |

H3 的124帧视频约5.17秒，Wan的49帧视频约2.04秒。H3 工作流现在默认 Turbo8；Turbo4 留作快速预览。参考图视频当前指首帧约束，H3 还支持首尾帧约束；不能将其称为任意角色/物体参考图的一致性控制。

中央 ComfyUI：http://127.0.0.1:8188。节点与模板说明见 [公共 ComfyUI](../platforms/comfyui/README.md)。原始图像结果在 `workspace/reports/image/`，视频历史在 `workspace/reports/video/`，作品在 `workspace/outputs/`。测试期间未观察到新的 GPU 页错误或重置，但此前闪屏故障根因尚未最终确认。

FLUX：Paiton、Stock 与中央 ComfyUI 文生图均已通过。供应商 Torch Flash SDPA 在 gfx1201 上返回参数错误，当前使用 Math SDPA；Paiton 其余编译优化保持开启。

评测工具链：lm-evaluation-harness 的 GSM8K 两样本链路已通过；VBench 主体/背景一致性、防闪烁、运动平滑度对两段视频已完成；GenEval 两条官方提示词样本导出通过，检测器评分环境尚未验收。详见 [评测协议](EVALUATION.md)。

多参考图编辑与跨模型 API 工作流已经通过：两张参考图生成首帧并自动切换 H3 输出视频（113.34秒完整工作流）。报告见 `workspace/reports/api-reference-to-video-workflow.json`；耗时包括加载、切换与生成，不能视为纯推理速度。
