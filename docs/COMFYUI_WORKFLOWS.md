# ComfyUI 工作流清单

更新：2026-10-20。唯一 H3 原生实例：`http://127.0.0.1:8188`。

| 分类 | 工作流 |
| --- | --- |
| 视频生成 | H3 · 文生视频 |
| 视频生成 | H3 · 首帧视频 |
| 视频生成 | H3 · 首尾帧视频 |
| 视频生成 | H3 · 多参考图生视频 |
| 视频生成 | H3 · 参考视频生视频 |
| 视频生成 | H3 · 图像与视频混合参考 |
| 第三方工作流 | 金鱼 · H3 终极篇（原版） |

金鱼原版需要自备 `女医生角色设定图.jpg`、`男患者角色设定图2.jpg`、`首帧场景4.jpg`，或通过唯一 MCP 接口导入自己的素材并配置开关。保留其所需 SelfLift 等原生节点。

- 源文件：`platforms/comfyui/workflows/`，注册表 `catalog.json`。
- 界面目录：`workspace/data/video/minimax-h3/user/default/workflows/`。
- 同步：`./lab comfyui sync`。
- Wan、Qwen/FLUX API 桥接和画布内跨服务组合流程已移除。
- 生图后转视频通过 API / MCP 分别提交，先等待图片完成，再将其导入为 H3 素材。

执行、调度和记录边界见 [当前模式](RUNTIME_TOPOLOGY.md) 与 [H3 原生说明](COMFYUI_NATIVE.md)。
