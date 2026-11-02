# 开发与项目整理

[文档目录](README.md)

## 目录职责

| 目录 | 内容 |
|---|---|
| `engines/` | 各部署的注册、模型配置与运行入口；`shared/` 存放公共实现 |
| `platforms/` | 网关与页面、MCP、调度、监控和 systemd 服务 |
| `.workbench/scripts/` | 安装、检查、同步、评测与诊断工具 |
| `.workbench/runtime/` | 运行时镜像构建器（`images.py`）、共享 ROCm SDK 与构建步骤（`rocm101/`）、CPU 视觉 |
| `.workbench/evaluation/` | 评测工具的镜像配方（VBench） |
| `.workbench/tests/` | 部署路由、运行时与工具的回归测试 |
| `docs/` | 使用说明、架构、研究结论与验证摘要 |
| `workspace/data/` | 模型、缓存、服务状态与本机凭据；`media/` 为任务记录、素材与遥测 |
| `workspace/config/` | 本机状态：引擎启用与路由、运行时镜像选择 |
| `workspace/outputs` | 指向作品盘根目录的链接 |
| `workspace/reports/` | 外部报告目录的符号链接 |
| `workspace/research/` | 外部专题研究资料目录的符号链接 |
| `workspace/archive/` | 外部历史构建归档目录的符号链接 |

## 存储

作品、任务状态和引擎数据的位置只在 `platforms/platform.json` 的 `storage` 段定义，布局、离线行为和 2026-11-02 的迁移记录见 [存储](STORAGE.md)。报告、研究资料、设计稿和归档仍通过 `workspace/reports`、`workspace/research` 等链接放在 `~/文档/llm-backend/`：

| 项目中的入口 | 实际目录 |
|---|---|
| `workspace/outputs` | 作品盘 `/media/aoike/Resource_Trad/Assets/` |
| `workspace/reports/` | `~/文档/llm-backend/报告/` |
| `workspace/research/` | `~/文档/llm-backend/研究资料/专题/` |
| `workspace/avatar-research/` | `~/文档/llm-backend/研究资料/数字人/` |
| `workspace/rocm-research/` | `~/文档/llm-backend/研究资料/ROCm/` |
| `workspace/designs/` | `~/文档/llm-backend/设计稿/` |
| `workspace/archive/` | `~/文档/llm-backend/归档/` |

新增下载资料放到 `workspace/research/<主题>/<日期>/`，结论写进 `docs/`；截图与验证输出放进对应的 `workspace/reports/` 子目录。代码里需要输出目录时，用 `storage.manual(<引擎包或工具名>)`，不要写死路径。迁移项目到其他机器时，改 `platform.json` 的 `storage` 段，并重建上面这些链接。

## 统一检查

在根目录执行：

```bash
./lab check                        # Python 四组 + 工作台、引擎包、MCP 的 Node.js 测试
./lab check --suite python         # 仅 Python
./lab check --suite node           # 仅 Node.js
./lab check --python /path/to/python
```

Python 默认使用已有 `.workbench/envs/tools/bin/python`，不存在时使用当前解释器。工作台需要 Node.js 22.19+ 与已安装的 `platforms/workbench/node_modules/`，可用 `WORKBENCH_NODE=/absolute/path/to/node` 指定解释器。检查不会安装依赖；缺少依赖时修复环境后重新执行。

入口运行以下测试，任一组失败都会返回非零状态，并继续汇总其他组：

- `.workbench/tests/`：部署路由、配置、模型校验、运行时与监控工具。
- `engines/shared/comfyui/tests/`：ComfyUI 模板与同步。
- `engines/*/*/tests/*.test.mjs`：引擎包自己的 Node.js 测试（H3 图与金鱼、Anima adapter），由 `./lab check` 自动发现。
- `platforms/scheduler/tests/`：驻留实验辅助工具。
- `.workbench/runtime/cpu-vision/test_telemetry.py`：并发计数与计算延迟。
- `platforms/workbench/tests/*.test.mjs`：网关、调度、API、访问密钥与页面状态。
- `platforms/mcp/tests/*.test.mjs`：MCP stdio 与工具协议。

HTTP 测试使用临时目录及本机临时端口；执行环境必须允许创建本机监听 socket。测试不需要模型推理或重启正式服务。GPU 验证与在线诊断仍使用 [运维文档](OPERATIONS.md) 中的独立命令。

## 页面构建

在 `platforms/workbench/` 执行 `npm run build`。检查构建时设置独立的 `WORKBENCH_NEXT_DIST`，避免覆盖正在使用的目录；实际生产目录以 systemd 配置为准，见 [公网 API](PUBLIC_API.md)。所有 `.next/`、`.next-*/` 和 `node_modules/` 都属于本地产物，已从 Git 与根目录 Docker 构建上下文排除。

## 整理与恢复

- 整理前核对代码引用、服务配置与运行进程；被生产、默认配置或服务 drop-in 引用的构建保留。
- 历史构建先打包，校验归档与原目录一致后再移除原目录；归档实际位于 `/home/aoike/文档/llm-backend/归档/`，兼容入口为 `workspace/archive/`，恢复时从项目根目录解包。
- 模型、下载缓存、作品、测试报告和服务凭据分别保留；不把整个 `workspace/` 当作临时目录删除。
- 保留上游源码目录及镜像、依赖版本锁。不要将第三方代码与生成文件混入批量格式化。
- 本机 `.env`、`.env.*`、`.aws/`、`.codex/`、`.agents/` 不提交；示例环境文件可提交。根目录 Docker 构建仍包含 ComfyUI 所需的 `.workbench/vendor/comfyui/`。

本次整理明细、归档路径与验证结果见 `workspace/reports/project-cleanup-20261019/`。
