# 本地 AI 工作台

单卡 AMD AI 工作台，统一提供文本、图像和视频推理。API 与 MCP 共用执行服务和单卡 GPU 调度；ComfyUI 统一检测全部原生工作流，不调用其他服务 API。当前模式见 [运行与调度](docs/RUNTIME_TOPOLOGY.md)。

本机环境：Ubuntu 24.04、Radeon AI PRO R9700 32GB、约 94 GiB 系统内存、ROCm 10.1 运行时。当前保留五个模型服务（文本、两个图像、视频、语音）；能力与验收边界见 [项目现状](docs/PROJECT_STATUS.md)。

## 快速开始

在项目根目录执行；首次安装见 [安装与运维](docs/OPERATIONS.md)。

```bash
./lab services start        # 启动公共服务，模型按请求加载
./lab services status       # 查看公共服务状态
./lab engines               # 查看登记部署
```

| 入口 | 地址 | 用途 |
|---|---|---|
| 工作台 | [127.0.0.1:13000](http://127.0.0.1:13000/) | 总览、任务、模型服务、API、MCP、访问管理 |
| ComfyUI | [127.0.0.1:8188](http://127.0.0.1:8188/) | H3 原生工作流与执行 |
| 推理 API | `http://127.0.0.1:18982/v1` | 聊天与媒体生成 |

服务监听本机回环地址。聊天模型名为 `qwen38-27b-w3a4`；本机同步调用保留 `local` 兼容；公网与持久媒体 API/MCP 使用有效密钥。

```bash
curl --max-time 900 http://127.0.0.1:18982/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen38-27b-w3a4","messages":[{"role":"user","content":"你好，请用中文介绍自己。"}],"max_tokens":256,"reasoning_effort":"none"}'
```

LLM 已启用前缀缓存与 Mamba align，重复长输入可复用驻留的前缀；引擎切换或重新加载会清空缓存。首次加载和跨模型切换可能需要数分钟。LLM 上下文、并发、Eager 和 KV 预算在面板配置，应用时等待任务结束并重启引擎；当前额度通过 `/v1/models` 查询。完整请求格式见 [API 参考](docs/CURRENT_API.md)。

## 文档导航

- [文档目录](docs/README.md)：全部文档、阅读顺序与维护约定。
- [开发与整理](docs/DEVELOPMENT.md)：目录职责、完整检查入口、构建与归档恢复。
- [本机媒体 MCP](docs/MEDIA_MCP.md)：11 个工具：生图、编辑、视频（金鱼原版工作流）、语音生成与任务工具；Workbench 查看概览、接入配置、工具和调用记录。
- [项目现状](docs/PROJECT_STATUS.md)：已有能力、待验收事项及证据入口。
- [安装与运维](docs/OPERATIONS.md)：首次安装、启停、检查及维护命令。
- [API 参考](docs/CURRENT_API.md)：聊天、图像、视频、查询与配置接口。
- [LLM 配置](docs/LLM_MODES.md)：上下文、并发、KV 预算与容量解释。
- [服务说明](docs/SERVICES.md) / [实现架构](docs/ARCHITECTURE.md)：端口、进程与请求生命周期。
- [ComfyUI 模板](platforms/comfyui/workflows/README.md)：图像、视频与组合流程。

## 项目结构

```text
llm-backend/
├── lab           统一命令入口
├── engines/      llm / image / video / audio 部署及配置
├── platforms/    工作台、ComfyUI、调度、监控与服务管理
├── docs/         使用、运维、架构、验证与研究文档
├── workspace/    模型、缓存、作品和报告
└── .workbench/   内部工具、依赖源码、测试与版本锁
```

模型和运行缓存位于 `workspace/data/`。生成物已迁出项目：图片在 `/home/aoike/图片/llm-backend/`，视频在 `/home/aoike/视频/llm-backend/`，报告、混合工作流产物、研究资料、设计稿和归档在 `/home/aoike/文档/llm-backend/`。`workspace/outputs/` 下的各子目录及 `workspace/reports/` 等旧入口通过符号链接指向外部目录，现有命令和文档路径继续可用；新增输出也直接写入外部目录。完整映射见 [开发与整理](docs/DEVELOPMENT.md)。

部署目录和命名见 [引擎目录](docs/ENGINES.md)，本地文本权重来源见 [模型资源](docs/MODELS.md)。

## 开源说明

本仓库以 [MIT 许可证](LICENSE) 发布，只包含编排、网关、工作台与部署脚本。以下内容不随仓库分发：

- 模型权重、运行缓存与生成物（`workspace/`），按 [模型资源](docs/MODELS.md) 自行准备；
- 上游源码与依赖（`.workbench/vendor/`、`engines/*/*/upstream/`），按 `.workbench/sources.lock.json` 获取；
- H3 工作流依赖的第三方 ComfyUI 节点包（KJNodes、VideoHelperSuite 等，多为 GPL-3.0），版本锁定在 `platforms/comfyui/worker_nodes/h3_packs/manifest.json`，执行 `.workbench/scripts/fetch-h3-packs.sh` 恢复；它们遵循各自的许可证。

项目面向单卡 AMD Radeon AI PRO R9700（ROCm 10.1）调优，文档中的 `/home/aoike/...` 等路径为作者本机约定，其他环境需按实际目录调整。公网接入的域名与服务器地址以占位符给出，见 [公网 API](docs/PUBLIC_API.md)。
