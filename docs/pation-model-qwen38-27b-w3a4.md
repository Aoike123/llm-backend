# 本机 Qwen3.8 27B W3A4

[文档目录](README.md)

官方来源：https://eliovp.com/blog/paiton-qwen38-w3a4-radeon-ai-pro-r9700

日常调用见 [API 参考](CURRENT_API.md)，现行策略见 [LLM 配置](LLM_MODES.md)。以下手动命令用于维护窗口。

## 启动

```bash
cd /mnt/Code/llm-backend
./lab pation-model-qwen38-27b-w3a4 start w3a4
./lab smoke --wait 900
```

首次启动需要拉取官方运行时镜像，随后加载本地模型、准备缓存。基础检查等候工作后端 `http://127.0.0.1:18983/health` 返回 200，再请求网关 `/v1/models`，验证中文回答、17×23 的结果及 Python 代码响应。原始响应与请求耗时保存在 `workspace/reports/llm/paiton/smoke-*.json`；这不是正式测速或能力评测。

API：`http://127.0.0.1:18982/v1`，模型名：`qwen38-27b-w3a4`。停止服务：`./lab pation-model-qwen38-27b-w3a4 stop w3a4`。查看日志：`docker logs --tail 100 -f paiton-qwen38`。

## 当前配置

2026-10-14 起，启动参数按已保存的上下文和并发配置设置，修改后等待任务结束并重启生效。默认 KV 池预算：64K 及以下为 8,859,648,000 字节，长上下文为 8 GiB；面板可自定义 Eager 和 KV 预算。embedding 放系统内存，CPU 服务计算图片特征，主模型输出头强制 BF16。此前 256K、8 路及 FP8 输出头的验证记录属于历史配置，不能直接作为当前配置的容量或稳定性依据。

## 此前配置与基础验证记录

上一轮 `llm-fast` 使用 `--mode 65k --vision --max-num-seqs 8 --thinking on`；上下文上限 65,536，KV 缓存格式和预算由已锁定的上游视觉预设决定。该配置属于历史验证；当前启动器按保存的上下文选择短/长模式，详见 [LLM 配置](LLM_MODES.md)。`--ignore-vram-check` 保留用于本机桌面占用，实际显存容量仍需以运行测试确认。

测试脚本：`python3 .workbench/scripts/test-vision-long.py`；测试视觉计数、默认思考、约 8K／32K／60K 单请求检索及 8 路约 8K／32K 并行检索。结果保存在 `workspace/reports/llm/paiton/vision-long-context/`。这是自定义功能与负载检查，不是标准能力分数；不能与博客关闭思考的测速数字直接比较。

下述 8K 单并发为此前已经通过的基础配置，备份为 `workspace/reports/llm/paiton/before-vision-long-profile.json`。

### 原始基础配置

当次检查桌面占用约 1.2 GiB 显存。此前 `llm-fast` 使用官方 `desktop` 配置，并将 KV 缓存从 2 GiB 缩减为 805306368 字节（0.75 GiB），上下文暂设为 8192，单并发、关闭 thinking。此配置使用 FP8 KV 缓存，W3A4 模型权重保持不变。

官方预检无论缓存是否已经缩减，都会拒绝非空闲显卡。因此，在缩减预算后使用官方 `--ignore-vram-check` 参数；这不会为其他 GPU 工作负载自动预留资源。运行前应停止其他推理／生成服务。这里的配置以本机基础推理为目标，不是博客的 65K／八并发测速配置。

## 模型和运行时

三个模型目录来自 `engines/llm/pation-model-qwen38-27b-w3a4/config/local-models.json`，已复制到项目 NVMe 的 `workspace/data/llm/paiton/models/` 并通过全部 91 项 SHA256 校验，均从 NVMe 只读挂载。资源盘原件保留，运行时不再从机械盘读取这些权重。`./lab fetch --fast` 复用本地模型，并验证 INT3 包的 SHA256。运行时缓存写入项目 `workspace/data/llm/paiton/runtime/qwen38/`。

上游锁定启动器的 2026-10-05 基础镜像 digest 如下；本机后续 ROCm 10.1 与 CPU 视觉运行时派生自该底座，实际启用镜像见 `.workbench/runtime/rocm101/active.json` 与 [升级记录](rocm101-upgrade.md)。

```text
ghcr.io/eliovp/paiton-vllm-plugin:qwen38-rocm10-vllm029-20261005-r1@sha256:245c71d54f046f89b74dbfbd4c894003754561e55c9d215a8d3ce65364fb0f80
```

它不等同于博客历史测速所使用的镜像，不应直接套用历史 tok/s 数字。

## 下载链路

本机 `llm-fast` 已改用南京大学 GHCR 镜像站 `ghcr.nju.edu.cn` 拉取相同镜像。镜像清单的 SHA256 与官方固定 digest 完全一致，运行版本不变。站点说明：https://doc.nju.edu.cn/books/e1654/page/ghcr 。本机 16 MiB 样本测试用时 4.50 秒（含建立连接），约 3.56 MiB/s；实际整层速度仍以 Docker 输出为准。

## 历史基础验证（2026-10-11）

2026-10-11：健康检查返回 200，中文回答、17×23=391、Python 加法函数三项实际推理检查全部通过。当次检查后服务保持运行。运行日志确认 W3A4 内核启用、DFlash2 草稿模型加载，模型加载报告 15.89 GiB；该数值是模型分配，不是整卡显存峰值。

原始响应：`workspace/reports/llm/paiton/smoke-20261011T051856428044Z.json`。实际容器镜像、启动参数和 NVMe 挂载：`workspace/reports/llm/paiton/w3a4-deployment.json`。启动日志：`workspace/reports/llm/paiton/w3a4-startup.log`。该条记录仅验证 8K／单并发基础推理，不代表博客 65K／八并发测速成绩。

## 部署名称和运行机制

部署入口为 `pation-model-qwen38-27b-w3a4`，模型为 Qwen3.8 27B，运行配置为 W3A4；MXFP4 使用独立入口 `pation-model-qwen38-27b-mxfp4`，后端为 Paiton / vLLM。此发布包是经过专门优化的模型与硬件组合，其他模型／量化格式需要对应加载器、权重和内核，并另行验证。

宿主机提供 AMD 驱动和 GPU 设备，容器提供 ROCm 用户态库、PyTorch、vLLM 与 Paiton 内核。基础模型、INT3 overlay 和 DFlash2 草稿从 NVMe 只读挂载；编译缓存独立写入 `/cache`。vLLM 加载后提供本机 OpenAI 兼容 API。API 别名 `qwen38-27b-w3a4` 由 `--served-model-name` 决定，可修改别名，但不会改变实际模型或量化格式。

## 思考／视觉／多并发实测

2026-10-11 的官方 65K 视觉预设完成 20 项检查及长文本与图片组合检查，全部通过。约 61K 单请求完成时间 19.24 秒；8 路各约 32K 整批 73.63 秒。详细限制、实际输入 token、耗时与显存见 [实测报告](../workspace/reports/llm/paiton/vision-long-context/SUMMARY.md)。

内部后端别名在 `engines/shared/paiton/config/profiles.json` 的 `llm-fast.served_model_name` 中配置；公共网关发布固定名称 `qwen38-27b-w3a4`，客户端使用该名称。测速、能力评测及视觉验证脚本自动读取运行中 API 的模型名称。

### harness 自定义模型 API

选择「自定义模型 API」后填写：

| 字段 | 值 |
|---|---|
| Provider ID | `pation`（提供商标识，可以自行命名） |
| 显示名称 | `Pation-Qwen3.8-27b`（显示标签，可以自行命名） |
| API 地址 | `http://127.0.0.1:18982/v1` |
| API 协议 | `OpenAI Chat Completions` |
| API 密钥 | `local`（服务无需鉴权，必填时用占位值） |
| 模型 ID | `qwen38-27b-w3a4`（必须与 API 返回的名称一致） |

点击「获取可用模型」或「添加模型」登记模型 ID，再创建提供商并在会话中选择该模型。API 地址不要追加 `/chat/completions`。网关重启期间获取列表可能连接失败。网关运行时 `/v1/models` 可返回已保存配置，即使 Qwen 未加载；模型实际状态查看 `/status`，首次推理需等待加载及预热。

## 历史修正（2026-10-14）

2026-10-14 KV 对齐修正：64K 及以下恢复官方 65k 配置的 lazy GDN、4096-token 批处理、8,859,648,000-byte 固定池；长上下文保持 eager GDN、1024-token 批处理和 8 GiB 池。CPU embedding、CPU 图像、BF16 输出头和重启切换保留。之前统一长模式在 64K 强制 eager，导致缓存容量显著下降。
