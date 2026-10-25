# FLUX.2 klein 4B

[文档目录](../../../docs/README.md) · [引擎目录](../../../docs/ENGINES.md)

类别：`image`。Paiton、Stock API 与中央 ComfyUI 的 1024/4步文生图均通过本机 ROCm 10.1 验证。Paiton 中央热请求约2.44秒，首次加载和编译需要额外时间。

启动：`./lab pation-model-flux2-klein start`；停止：`./lab pation-model-flux2-klein stop`。先停止当前 GPU 引擎，再启动本部署。现在仅启动 7861/7862 API 工作服务，唯一公共 ComfyUI 位于 http://127.0.0.1:8188。日常调用统一 API 或节点即可自动切换，手动入口用于维护。

模型与缓存保存在项目 NVMe 的 `workspace/data/image/flux2/`；源 SDNQ 权重已转换为运行时 INT8/BF16。运行配置使用 Math SDPA 避免 gfx1201 上的 Flash 参数错误；其余 Paiton 编译优化保留。

共享后端：`engines/shared/paiton`。性能与限制见 [媒体验证结果](../../../docs/MEDIA_RESULTS.md)。
