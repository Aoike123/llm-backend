# H3 工作流模板

当前发布 `catalog.json` 中的 7 个 H3 原生模板与 3 个 Anima 原生生图模板，界面文件位于 `ui/`，API 图位于 `api/`。Wan、图像 API 桥接和跨服务组合模板已删除。

使用 `./lab comfyui sync` 同步到 `workspace/data/video/minimax-h3/user/default/workflows/`。用户自定义文件保留，修改过的托管模板更新前保留备份。不要用旧 API 模板生成器恢复已退役模板。

H3 的模型、LoRA、条件、采样、视频/音频解码和输出都在同一 GPU ComfyUI 运行。金鱼只保留原版，参考素材与开关统一由 generate_video 配置。Anima 权重锁定在 `../models/anima.lock.json`，与 H3 共用模型目录。

[完整清单](../../../docs/COMFYUI_WORKFLOWS.md) · [执行边界](../../../docs/COMFYUI_NATIVE.md)
