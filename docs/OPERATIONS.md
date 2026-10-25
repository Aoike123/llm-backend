# 安装与运维

[文档目录](README.md)

日常入口和能力状态见 [项目首页](../README.md) 与 [项目现状](PROJECT_STATUS.md)，完整接口见 [API 参考](CURRENT_API.md)。所有命令在项目根目录执行。

## 安装与第一次启动

在宿主机终端执行，代理沙箱不提供 GPU 设备访问：

```bash
cd /mnt/Code/llm-backend
./lab install-host
# 按提示输入 sudo 密码，然后注销并重新登录
./lab bootstrap
./lab setup-tools
./lab doctor
./lab fetch
./lab services install
./lab services start
./lab services status
```

已将资源盘中的 Paiton 模型复制到项目 NVMe 的 `workspace/data/llm/paiton/models/`，全部 91 项 SHA256 校验通过，原件保留。运行路径保存在 `engines/llm/pation-model-qwen38-27b-w3a4/config/local-models.json`。`./lab fetch` 会检查并复用本地文件，跳过下载；`llm-fast` 使用归档中的 INT3 权重。项目内的模型副本通过上游启动器以只读方式挂载，编译缓存仍写入项目的 `workspace/data/llm/paiton/runtime/`。详情见 [本地模型清单](MODELS.md)。

安装脚本安装 Ubuntu 的 Docker、Compose v2、Python venv、curl 和 git，并启用 Docker。它为当前用户添加 docker/render/video 组权限。不会安装另一套宿主机 ROCm；推理框架来自官方容器。

安装完成后，通过统一 API 或公共 ComfyUI 发起推理即可自动加载模型。网关健康检查 `http://127.0.0.1:18982/health` 只说明网关可用，实际模型状态通过 `/status` 查询；W3A4 后端就绪检查为 `http://127.0.0.1:18983/health`。冷启动可能需要数分钟。

## 日常服务管理

```bash
./lab services start
./lab services status
./lab services logs
./lab services restart    # 先等待活动和排队任务结束
./lab services stop       # 停止公共服务及已登记 GPU 工作容器
```

服务名单、单独启停和开机启动说明见 [服务说明](SERVICES.md)。LLM 参数在面板调整，应用会重启引擎，详见 [LLM 配置](LLM_MODES.md)。

## 手动模型维护

日常通过统一 API 或公共 ComfyUI 请求模型，自动排队与切换。常驻服务用 `./lab services start|stop|status` 管理；以下手动入口仅供维护，操作前等待任务结束。服务名与架构见 [服务说明](SERVICES.md)。

| 部署 | 启动命令 | 工作服务 |
| --- | --- | --- |
| W3A4 文本 | `./lab pation-model-qwen38-27b-w3a4 start w3a4` | 内部后端 18983；公共 API 18982 |
| FLUX.2 klein | `./lab pation-model-flux2-klein start` | API 7861/7862；公共界面8188 |
| Qwen-Image | `./lab pation-model-qwen-image-21 start` | API 8191 |
| MiniMax H3 | `./lab pation-model-minimax-h3 start` | 统一 GPU ComfyUI 8188（仅 H3 原生节点） |

停止指定部署时将 `start` 换成 `stop`。模型加载、编译或预热期间需等待服务就绪。Wan / FastWan 已从当前引擎注册移除。

手动入口用于维护和独立检查。直接访问后端或手动启停不受完整调度互斥保证。旧 `./lab start llm` 指向独立 MXFP4 配置；当前已验证文本入口使用上表 W3A4 命令。

## 维护检查

```bash
./lab check              # 四组 Python 测试及工作台 Node.js 测试
./lab check --suite python  # 仅 Python；可用 --suite node 单独检查工作台
./lab doctor             # 宿主环境检查
./lab runtime status     # 查看运行时配置
./lab monitor check      # 检查指标接入，不执行测速
./lab comfyui check      # 检查公共工作流服务
./lab comfyui sync       # 同步磁盘模板，不重启服务
```

ROCm 10.1 的迁移过程与运行时构建说明见 [升级记录](rocm101-upgrade.md)，工作流同步与自定义说明见 [模板目录](../platforms/comfyui/workflows/README.md)。
测试依赖、执行环境及整理约定见 [开发与整理](DEVELOPMENT.md)。

## 测速与测能力

```bash
# 维护窗口启动 W3A4，并等待后端 18983/health 成功
./lab bench llm --num-prompts 32
./lab eval-llm --limit 10
./lab eval-llm

# 离线图像／视频测速前先停止服务
./lab stop
./lab bench image --engine paiton
./lab bench image --engine stock
./lab bench video --engine paiton
./lab bench video --engine stock
./lab bench video-audio --engine paiton
./lab bench video-audio --engine stock
```

测速使用官方工具；32 请求和 10 道题属于冒烟检查，不能当作正式排行榜成绩。详细协议、GenEval 样本导出及 VBench 环境配置见 [评测说明](EVALUATION.md)。

## 存储与复现

- `workspace/data/`：模型、HF 下载和运行时缓存。
- `workspace/outputs/`：图像、视频、GenEval 样本及媒体测速原始数据。
- `workspace/reports/`：LLM 测速 JSON、能力评测结果和环境记录。
- `.workbench/sources.lock.json`：四个官方项目的确切 Git commit。
- `.workbench/tools.resolved.txt`：`setup-tools` 安装完成后记录解析出的依赖版本。

作品、报告、研究资料、设计稿与归档已迁到 `/home/aoike/` 下的图片、视频和文档目录；上述 `workspace/outputs/` 子目录及 `workspace/reports/` 等入口通过符号链接访问外部文件，后续生成也写入外部目录。实际目录与挂载维护方法见 [外部生成物存储](DEVELOPMENT.md#外部生成物存储)。模型、运行缓存、依赖与生产构建仍保存在项目中。

Qwen 文本的模型 revisions 固定；Qwen 容器由上游按 digest 锁定。FLUX／Qwen-Image 使用上游发布 tag，其他视频容器使用上游固定底座构建；正式评测还应保存实际镜像 digest。H3 Compose 文件做了本地补丁，将发布地址改为 `127.0.0.1`；`bootstrap` 会复用补丁，保留缓存和已有改动。

所有工作负载按需下载，避免一次拉取全部模型。为全套镜像、权重、编译缓存和输出预留约 200–300 GB，是规划值。2026-10-19 的容器存储维护将 Docker 与 containerd 分别迁往 `/mnt/Code/.runtime/docker` 和 `/mnt/Code/.runtime/containerd`，执行状态及检查方法见 [容器存储与空间维护](CONTAINER_STORAGE.md)。模型与运行缓存保存在项目 NVMe，作品与报告通过上述符号链接保存到家目录。实际余量用 `df -h / /mnt/Code` 查看。

官方来源：[Paiton](https://github.com/Eliovp-BV/paiton-vllm-plugin)、[EleutherAI](https://github.com/EleutherAI/lm-evaluation-harness)、[GenEval](https://github.com/djghosh13/geneval)、[VBench](https://github.com/Vchitect/VBench)。不同模型和权重保留各自使用条款，见上游 model guides 和 notices。
