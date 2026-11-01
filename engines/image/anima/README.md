# Anima

动漫与插画图像生成，运行在共享的 [ComfyUI 运行时](../../../docs/COMFYUI.md)，与 H3 共用容器和模型目录；两者互相切换时不重启。

| 能力 | 参数 | 说明 |
| --- | --- | --- |
| `image.generate` | `quality`（`turbo` / `aesthetic`）、`aspect_ratio`（1:1、3:4、4:3、9:16、16:9，约 1MP）、`negative_prompt` | 自动在提示词前加质量与分级标签 |
| `image.edit` | `quality`、`strength`（默认 0.6）、`negative_prompt` | 对唯一一张参考图做图生图重绘，不是按指令编辑 |

模型 id 为 `anima`，优先级排在 Qwen-Image 之后；未配置路由时，它是 `image.generate` 和 `image.edit` 的降级。如果不希望“指令编辑”降级成“风格重绘”，到控制台「能力」页调整 `image.edit` 的降级链。

权重锁定在 `config/models.lock.json`，下载与许可见 [ComfyUI 运行时 · Anima](../../../docs/COMFYUI.md#anima)。测试：`tests/adapter.test.mjs`（随 `./lab check` 运行）。
