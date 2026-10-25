# Qwen-Image 2.1 / Paiton

[文档目录](../../../docs/README.md) · [引擎目录](../../../docs/ENGINES.md)

类别：image。项目 NVMe 权重9.33GB已完成 SHA256 校验。ROCm 10.1 下文生图1024/2048、透明图与单图编辑均已通过中央 ComfyUI 实测；默认 schedule-int8、native fusions。1024热请求约19.96秒，2048约107.46秒。编辑改色有效，但纹理保真未验收。

此前 ROCm 10.0 出图曾触发 GPU 映射错误与桌面异常；升级后的测试未观察到新的内核故障，长期稳定性及旧故障根因仍未最终确认。原始诊断保存在 `workspace/reports/image/qwen-image21/BLACK_SCREEN.md`。

权重位于 `workspace/data/image/qwen-image/models/qwen-image21-mxfp4-rdna4`，输出位于 `workspace/outputs/image/qwen-image`。

入口：`./lab pation-model-qwen-image-21 prepare|start|stop|status|logs|check|generate`。可用 `start --precision-profile exact --no-native-fusions` 回到保守路径（该路径也已验证）。先停止其他 GPU 引擎再启动。

自定义节点和模板位于 `platforms/comfyui/`，公共入口 http://127.0.0.1:8188。完整实测见 [媒体验证结果](../../../docs/MEDIA_RESULTS.md)。
