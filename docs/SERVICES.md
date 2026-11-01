# 常驻服务、项目结构与启动原理

[文档目录](README.md)

更新：2026-11-02。当前架构以 [运行与调度模式](RUNTIME_TOPOLOGY.md) 为准。工作目录 `/mnt/Code/llm-backend`。

## 日常入口

- 控制台：http://127.0.0.1:13000/ 。切换模型后，整组图表会跟着替换。
- 统一推理 API：http://127.0.0.1:18982/v1 。不需要先手动启动模型。
- ComfyUI 画布：http://127.0.0.1:8188/ 。按需运行，先执行 `./lab comfyui start`，见 [ComfyUI 运行时](COMFYUI.md)。

## 常驻服务

常驻的只有网关和监控；所有 GPU 运行时（包括 ComfyUI）都由网关按需启动。

| systemd 用户单元 | 职责 | 实际工作进程 / 容器 |
|---|---|---|
| ai-workbench.target | 总启动目标 | 聚合下列两个单元 |
| ai-workbench-gateway.service | Next.js 页面、统一 API、队列、GPU 切换 | Node.js，13000 / 18982 / 18990 |
| ai-workbench-monitoring.service | 启动指标采集 | ai-monitoring-prometheus / node / gpu |
| ai-workbench-public-tunnel.service | 公网反向隧道（可选，不在 target 内） | 见 [公网 API](PUBLIC_API.md) |

```bash
cd /mnt/Code/llm-backend
./lab services install   # 安装并设置开机启动，可重复执行
./lab services start     # 启动公共服务
./lab services status    # 查看状态及 Linger
./lab services restart   # 重启公共服务；先等活动请求结束
./lab services logs      # API 网关近期日志
./lab services stop      # 停止公共服务及已登记的 GPU 工作容器
```

单独操作：`systemctl --user start|stop|restart <服务名>`；查看日志：`journalctl --user -u <服务名> -n 60 --no-pager`。

- 单独停止 gateway 不会停止 GPU 容器。
- 单独停止 target 不保证停止它 Wants 的单元；要完整停止，用 `./lab services stop`。

Next.js 与调度共用一个进程，异常时自动重启。监控单元是 oneshot，显示 `active (exited)` 只表示启动命令已经执行完。用户 Linger 允许注销后继续运行和开机启动；Docker 服务也需要设为开机启用。

网关通过 Linux abstract Unix socket 保证同一数据目录只有一个实例。互斥由内核原子建立；无论正常退出、异常退出、SIGKILL 还是系统重启，都会自动释放，不依赖 PID 或磁盘锁文件。这一机制要求 Linux，并且所有实例使用相同的数据目录和网络命名空间。

## GPU 运行时

运行时由各引擎包的 `engine.json` 声明；同一运行时上的引擎之间切换不重启容器。

| 运行时 | 引擎（调度键 / 模型） | 工作容器 | 内部端口 |
|---|---|---|---|
| llm | `llm` / qwen38-27b-w3a4 | paiton-qwen38 | 18983 |
| qwen-image | `qwen-image` / qwen-image21 | paiton-qwen-image21 | 8191 |
| comfy | `h3` / minimax-h3、`anima` / anima | paiton-h3-comfyui-1 | 8188 |
| audiocpp | `fish-drama3`、`bs-roformer`、`qwen3-asr` | paiton-audiocpp | 18986 |

单卡调度一次只运行一个运行时。查看全部登记的引擎包：`./lab engine list`。

CPU 权重驻留没有通过完整模型验收，`platforms/scheduler/residency.json` 保持关闭；完整的 LLM 睡眠启动还有 ROCm 分配器兼容问题，所以日常服务继续冷切换。详见 [测试结果与限制](MODEL_SCHEDULING.md#内存驻留与重载)。

vLLM、llama.cpp、Strata、MXFP4 等其他部署只供维护与研究登记，不在生产调度里；登记不代表已在本机验收。

## 文件结构

```text
lab → .workbench/cli.py                  统一命令分发
engines/{llm,image,video,audio}/         引擎包：engine.json、adapter.mjs、配置与测试
engines/shared/comfyui/                  共享 ComfyUI 运行时：客户端、节点、模板
engines/shared/audiocpp/                 共享 audio.cpp 运行时
engines/shared/paiton/                   Paiton 启动器及供应商实现
platforms/workbench/                     Next.js、React、图表与 Node.js 网关
platforms/mcp/                           local-media stdio MCP
platforms/scheduler/                     租约客户端与驻留实验辅助工具
platforms/monitoring/                    采集器与 Prometheus
platforms/services/                      systemd 单元和服务管理入口
docs/                                    操作、架构、验证说明
workspace/                               权重、缓存、作品与报告
.workbench/                              内部工具、依赖、版本锁和研究
```

## 运行原理

API 与 MCP 共用网关的任务执行和 GPU 调度。H3 与 Anima 的请求把原生图提交给 ComfyUI；直接在画布上提交的任务进入 ComfyUI 自己的队列，切换运行时前会检查这个队列是否已经空闲。跨运行时切换时，先停止旧容器再启动目标容器，ComfyUI 会随之暂时不可用。详见 [当前运行模式](RUNTIME_TOPOLOGY.md)。

Prometheus 每 5 秒采集一次网关、vLLM、宿主机和 GPU 数据。控制台（13000）基于 Next.js App Router、React 19 和 Recharts，经同一 Node.js 进程里的指标接口查询数据。

模型重载策略见 [调度说明](MODEL_SCHEDULING.md)，实现技术见 [技术说明](ARCHITECTURE.md)。
