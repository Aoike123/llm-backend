# ComfyUI 工作流清单

更新：2026-10-20。唯一 H3 原生实例：`http://127.0.0.1:8188`。

| 分类 | 工作流 |
| --- | --- |
| 图像生成 | Anima · 文生图（Turbo） |
| 图像生成 | Anima · 文生图（Aesthetic 质量档） |
| 图像生成 | Anima · 图生图（Turbo） |
| 视频生成 | H3 · 文生视频 |
| 视频生成 | H3 · 首帧视频 |
| 视频生成 | H3 · 首尾帧视频 |
| 视频生成 | H3 · 多参考图生视频 |
| 视频生成 | H3 · 参考视频生视频 |
| 视频生成 | H3 · 图像与视频混合参考 |
| 第三方工作流 | 金鱼 · H3 终极篇（原版） |

金鱼原版需要自备 `女医生角色设定图.jpg`、`男患者角色设定图2.jpg`、`首帧场景4.jpg`，或通过唯一 MCP 接口导入自己的素材并配置开关。保留其所需 SelfLift 等原生节点。

Anima 是 2B 动漫/插画模型（CircleStone Labs 与 Comfy Org，ComfyUI 原生支持），在同一 GPU ComfyUI 内用原生 UNETLoader / CLIPLoader / VAELoader / KSampler 执行。Turbo 用 CFG 1、10 步；Aesthetic 用 CFG 4、30 步 er_sde，不加 score_* 标签。权重约 9.8 GB，按锁文件校验下载：

```bash
python3 .workbench/scripts/fetch-locked-checkpoint.py --lock platforms/comfyui/models/anima.lock.json --destination workspace/data/video/minimax-h3/models
```

2026-10-25 实测（R9700，1024²，含首次加载）：Turbo 文生图 14.4 秒、Aesthetic 30 步 15.9 秒、Turbo 图生图 6.0 秒，三张图内容与提示词一致。Anima adapter 需要 `h3_attention_patch` 的 math SDPA 修复，否则 KSampler 报 `hipErrorInvalidValue`。复测：`python3 .workbench/scripts/check-anima.py`（取得 h3 租约，报告在 `workspace/reports/image/anima/`）。

模型为 CircleStone Labs 非商用许可（不得付费托管 API），生成图像可商用。Anima 目前只作为原生画布 / `/prompt` 工作流发布，未接入 MCP `generate_image`。

- 源文件：`platforms/comfyui/workflows/`，注册表 `catalog.json`。
- 界面目录：`workspace/data/video/minimax-h3/user/default/workflows/`。
- 同步：`./lab comfyui sync`。
- Wan、Qwen/FLUX API 桥接和画布内跨服务组合流程已移除。
- 生图后转视频通过 API / MCP 分别提交，先等待图片完成，再将其导入为 H3 素材。

执行、调度和记录边界见 [当前模式](RUNTIME_TOPOLOGY.md) 与 [H3 原生说明](COMFYUI_NATIVE.md)。
