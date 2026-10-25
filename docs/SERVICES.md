# 常驻服务、项目结构与启动原理

[文档目录](README.md)

更新：2026-10-20。当前架构以 [运行与调度模式](RUNTIME_TOPOLOGY.md) 为准。工作目录 `/mnt/Code/llm-backend`。

## 日常入口

- 自动跟随模型的监控：http://127.0.0.1:13000/ 。切换模型后整组图表自动替换。
- 唯一公共 ComfyUI：http://127.0.0.1:8188/ 。H3 原生画布与执行，不调用其他服务 API。详见 [原生工作流](COMFYUI_NATIVE.md)。
- 统一推理 API：http://127.0.0.1:18982/v1 。不必先手动启动模型。

## 常驻服务

| systemd 用户单元 | 职责 | 实际工作进程 / 容器 |
|---|---|---|
| ai-workbench.target | 总启动目标 | 聚合下列三个单元 |
| ai-workbench-gateway.service | Next.js 页面、统一 API、队列、GPU 切换 | Node.js，13000 / 18982 / 18990 |
| ai-workbench-comfyui.service | 通过调度器准备 H3 原生画布 | paiton-h3-comfyui-1，8188 |
| ai-workbench-monitoring.service | 启动指标采集 | ai-monitoring-prometheus / node / gpu |

```bash
cd /mnt/Code/llm-backend
./lab services install   # 安装并设置开机启动，重复执行安全
./lab services start     # 启动全部公共服务
./lab services status    # 状态及 Linger
./lab services restart  # 重启公共服务；先等活动请求结束
./lab services logs     # API 网关近期日志
./lab services stop     # 停止公共服务及已登记 GPU 工作容器
```

单独操作：`systemctl --user start|stop|restart <服务名>`，日志：`journalctl --user -u <服务名> -n 60 --no-pager`。单独停止 gateway 不停止 GPU 容器。单独停止 target 不保证停止其 Wants，完整停止请使用 `./lab services stop`。

Next.js 与调度共用进程，异常自动重启；ComfyUI 与监控的 oneshot 单元显示 `active (exited)` 仅表示启动命令已完成。ComfyUI 随 H3 后端按需启停，实时状态以 Docker / 管理页面为准。用户 Linger 允许注销后运行、开机启动；Docker 服务也需要开机启用。

网关通过 Linux abstract Unix socket 保证同一数据目录只有一个实例。互斥由内核原子建立，正常退出、异常退出、SIGKILL 和系统重启均自动释放；不依赖 PID 或磁盘锁文件。历史 `workspace/data/scheduler/node.lock` 不再参与启动判断，无需手动删除。此机制要求 Linux，且所有实例使用相同的数据目录与网络命名空间。

## GPU 工作服务

| 调度键 / API model | 部署入口 | 工作容器 | 内部端口 |
|---|---|---|---|
| llm / qwen38-27b-w3a4 | pation-model-qwen38-27b-w3a4 | paiton-qwen38 | 18983 |
| qwen-image / qwen-image21 | pation-model-qwen-image-21 | paiton-qwen-image21 | 8191 |
| flux / flux2-klein | pation-model-flux2-klein | paiton-flux2-paiton-1、paiton-flux2-stock-1 | 7861 / 7862 |
| h3 / minimax-h3 | pation-model-minimax-h3 | paiton-h3-comfyui-1 | 8188 |
| tts / cosyvoice3-rl | pation-model-cosyvoice3 | paiton-tts | 18986 |

这些服务按需运行，不全部开机加载。单卡调度选择一个部署；FLUX 部署内含两种实现，生成按请求选择。H3 的画布和视频 API 使用同一个原生 ComfyUI 进程；语音复用 CPU 视觉的 ROCm 镜像，仅通过 MCP 持久任务调用；Wan 已下线。FLUX 启动只带 API 工作服务，不启动供应商 8189 界面。

CPU 权重驻留未通过完整模型验收，`platforms/scheduler/residency.json` 保持关闭。完整 LLM 睡眠启动尚有 ROCm 分配器兼容问题，日常服务继续冷切换；详见 [测试结果与限制](MODEL_SCHEDULING.md#内存驻留与重载)。

已登记的 vLLM、llama.cpp、Strata、MXFP4 等其他部署供维护与研究，未自动列入当前生产调度；登记不等于本机验收。`./lab engines` 查看。

## 文件结构

```text
lab → .workbench/cli.py                  统一命令分发
engines/{llm,image,video}/               各模型部署、配置与控制器
engines/shared/paiton/                   共享启动器及供应商实现
platforms/workbench/                    Next.js、React、图表与 Node.js 调度
platforms/scheduler/                    租约客户端与驻留实验辅助工具
platforms/comfyui/                       唯一公共 ComfyUI、API 节点和工作流
platforms/monitoring/                    采集器与 Prometheus
platforms/services/                     systemd 单元和服务管理入口
docs/                                   操作、架构、验证说明
workspace/data/                         原始权重、下载及运行缓存
workspace/outputs/                      生成作品
workspace/reports/                      推理与运行验收记录
.workbench/                             内部工具、依赖、版本锁和研究
```

## 运行原理

API 与 MCP 共用网关任务执行及 GPU 调度。H3 API 提交原生图到唯一 ComfyUI；直接画布任务使用 ComfyUI 自身队列，切换前会检查该队列是否空闲。跨后端切换先停止旧容器再启动目标，ComfyUI 会随之暂时不可用。详见 [当前运行模式](RUNTIME_TOPOLOGY.md)。

Prometheus 每 5 秒采集网关、vLLM、宿主机和 GPU 数据。13000 使用 Next.js App Router、React 19 和 Recharts，通过同一 Node.js 进程中的指标接口查询真实数据，支持 15/30/60 分钟、悬停查看和自动模型调度。Grafana 与独立图表服务已移除；遗留镜像、历史目录和密码文件已于 2026-10-23 清理。

当前模型重载策略及内存卸载评估见 [调度说明](MODEL_SCHEDULING.md)。

监控前端、指标查询及GPU调度的实现技术见 [技术说明](ARCHITECTURE.md)。
