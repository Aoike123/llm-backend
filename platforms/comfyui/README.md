# H3 原生 ComfyUI

唯一实例：`paiton-h3-comfyui-1`，`http://127.0.0.1:8188`。

只保留 H3 原生执行和 7 个模板。Wan 与跨服务 API 桥接已移除；图像生成和跨模型编排通过 API / MCP 完成。Workbench 管理页面不作为 MCP 服务导出。

```bash
./lab comfyui start
./lab comfyui status
./lab comfyui check
./lab comfyui sync
```

`start` 通过调度器申请 H3，不创建第二个实例。切换到其他 GPU 后端时 ComfyUI 会按需停止。不要在活动任务期间手工停止容器。

[当前运行与调度](../../docs/RUNTIME_TOPOLOGY.md) · [原生工作流与挂载](../../docs/COMFYUI_NATIVE.md) · [模板目录](../../docs/COMFYUI_WORKFLOWS.md)
