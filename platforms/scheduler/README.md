# 统一 API 与 GPU 调度

调度器已经迁入 [Next.js Workbench](../workbench/README.md)。Node.js 同时提供前端页面、18982 推理接口和 18990 租约控制接口。

```bash
./lab scheduler status
./lab scheduler switch llm
./lab scheduler switch h3
```

支持 LLM、Qwen-Image、FLUX、H3。客户端提交后自动排队、等待空闲、切换容器并检查就绪；LLM 同模型支持共享租约与 SSE。默认保持最后一个模型，`stop` 不停止模型容器。直接后端请求、外部 GPU 程序与手动启停仍不受完整互斥保证。

本目录保留 Python 外部租约客户端、CPU 驻留配置与实验辅助代码；没有常驻 Python 调度器。`residency.json` 默认关闭，Node.js 中保留预算检查与失败回退。

验证：`cd platforms/workbench && npm test`；驻留实验辅助工具验证：`python3 -m unittest discover -s platforms/scheduler/tests -v`。

API 与 MCP 共享调度，ComfyUI 只执行 H3 原生工作流；直接画布的队列与持久任务分开。见 [当前模式](../../docs/RUNTIME_TOPOLOGY.md)。
