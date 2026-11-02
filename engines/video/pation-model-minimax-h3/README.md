# MiniMax H3 / ComfyUI

[文档目录](../../../docs/README.md) · [引擎目录](../../../docs/ENGINES.md)

类别：video。ROCm 10.1 下文生视频、参考首帧、首尾帧均通过实测，带原生音频。默认 Turbo8、864×480、124帧、24fps，约5.17秒；该冷请求用时105.54秒，仍有粗糙纹理。

按需启动：请求或 `./lab comfyui start` 通过调度器拉起共享 ComfyUI，不需要手工停止其他引擎。Turbo8/Turbo4 共35.92GB权重已校验，位于项目 NVMe 的 `workspace/data/comfy/models`。

FL2VA参考图作为首帧约束，也可提供末帧；多图、视频和混合参考使用新增Ref2VA路径，见下文。任意人物或物体参考一致性仍需按素材验收。Turbo4 可用于快速预览；首尾帧与参考模板保留已验证的576×320设置。

运行在 [共享 ComfyUI](../../../docs/COMFYUI.md)（http://127.0.0.1:8188），与 Anima 共用容器。包内结构：`graphs/` 是同步 API 的四个图预设，`lib/` 放图构建、金鱼工作流与参考素材处理，`tests/` 随 `./lab check` 运行。

## 多图 / 视频 / 混合参考（Ref2VA）

API：`POST /v1/videos/generations`，使用 `reference_images_b64`（最多9张PNG）和 `reference_videos_b64`（最多3段，各2–15秒，合计≤15秒）。两个数组可同时提供。默认 `preset: reference` 为20步质量档，`reference-turbo4` 为专用4步预览。保留原有FL2VA首尾帧路径。

参数与调用示例见 [视频API](../../../docs/CURRENT_API.md#6-视频-api)；公共ComfyUI新增多参考图、参考视频、混合参考三个完整原生模板。提示词用 `<Picture 1>` / `<Video 1>` 指定素材职责。

新增权重锁：`reference-models.lock.json`。可用项目既有下载工具复现：

```bash
python3 .workbench/scripts/fetch-locked-checkpoint.py \
  --lock engines/video/pation-model-minimax-h3/reference-models.lock.json \
  --destination workspace/data/comfy/models
```

ROCm运行配置保留 `--fast-disk --reserve-vram 2 --cache-ram 2`、DynamicVRAM及双流异步卸载，不通过降低输出帧数或步数回避显存问题。公共原生模板的视频24fps转换节点由项目控制器挂载到GPU工作容器，宿主API使用FFmpeg/FFprobe。更改Compose后通过原调度器重新准备H3工作容器。

验证脚本：`python3 .workbench/scripts/verify-h3-references.py --case image-quality`；其他用例为 `video-quality`、`mixed`、`maximum`、`long-quality`，实测报告位于 `workspace/reports/h3-reference-20261019/`。最高参数组合的可运行性与参考保真度应分别记录。
