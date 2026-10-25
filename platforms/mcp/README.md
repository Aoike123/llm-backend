# local-media MCP

本机 stdio 媒体工具服务，注册 10 个工具：生图、编辑、视频生成（H3 原版工作流），以及目录、素材、任务和作品下载。其他 ComfyUI 原生工作流通过自身 HTTP API 调度，不自动注册到 MCP。

- 接入与运行：[本机媒体 MCP](../../docs/MEDIA_MCP.md)
- 设计与后续阶段：[MCP 规划](../../docs/MEDIA_MCP_PLAN.md)

```bash
npm ci --prefix platforms/mcp
./lab mcp setup
./lab mcp stdio
```

测试：`npm test --prefix platforms/mcp`，或在项目根目录运行 `./lab check`。stdio 的 stdout 仅输出 MCP 协议消息。
