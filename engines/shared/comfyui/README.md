# ComfyUI 运行时

H3 与 Anima 共用的原生 ComfyUI（`paiton-h3-comfyui-1`，http://127.0.0.1:8188）。按需启动：请求路由到 `h3` 或 `anima` 时由调度器拉起，切到其他 GPU 引擎时等队列空闲后停止。

```bash
./lab comfyui start | status | check | sync | stop
```

- `client.mjs`：引擎 adapter 共用的 ComfyUI 客户端，负责 `/prompt` 提交、历史轮询、中断、产物下载和重启恢复。
- `nodes/`：挂进容器的节点。第三方包由 `.workbench/scripts/fetch-h3-packs.sh` 恢复。
- `workflows/`：画布模板及对应的 API 图。

完整说明见 [ComfyUI 运行时](../../../docs/runtime/COMFYUI.md)。
