# Qwen3.8 27B W3A4

[文档目录](../../../docs/README.md) · [引擎目录](../../../docs/ENGINES.md)

后端：Paiton / vLLM。设备：Radeon AI PRO R9700 32GB。

启动：`./lab pation-model-qwen38-27b-w3a4 start`。停止：`./lab pation-model-qwen38-27b-w3a4 stop`。

权重共享项目 NVMe 的 `workspace/data/llm/paiton/models/`；公共源码位于 `engines/shared/paiton/`。W3A4 已完成本机基础推理验证，MXFP4 尚待验证。

当前统一引擎：262,144 token 技术上限、最多八路、CPU 视觉与默认 medium 思考。面板设置上下文、并发、Eager 与 KV 预算，应用时等待已有任务结束并重启引擎，旧引擎缓存清空。默认 KV 预算为上下文 ≤64K 时 8,859,648,000 字节，更长上下文时 8 GiB；自定义预算以已保存配置为准。所有兼容模型名使用当前面板额度。

`start w3a4` 和 `start high-concurrency` 均读取已保存的上下文与并发配置。满载余量读取当前引擎实测容量，超预算可保存但实际请求会按容量排队。完整策略与调用见 [统一引擎说明](../../../docs/LLM_MODES.md)。基础推理验证不等于满上下文长期稳定性验收。
