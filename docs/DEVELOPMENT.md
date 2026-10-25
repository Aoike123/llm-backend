# 开发与项目整理

[文档目录](README.md)

## 目录职责

| 目录 | 内容 |
|---|---|
| `engines/` | 各部署的注册、模型配置与运行入口；`shared/` 存放公共实现 |
| `platforms/` | 网关与页面、ComfyUI、调度、监控和 systemd 服务 |
| `.workbench/scripts/` | 安装、检查、同步、评测与诊断工具 |
| `.workbench/runtime/` | ROCm 与 CPU 视觉运行时实现、镜像定义和版本锁 |
| `.workbench/tests/` | 部署路由、运行时与工具的回归测试 |
| `docs/` | 使用说明、架构、研究结论与验证摘要 |
| `workspace/data/` | 模型、缓存、服务状态与本机凭据 |
| `workspace/outputs/` | 各子目录均为外部生成物目录的符号链接 |
| `workspace/reports/` | 外部报告目录的符号链接 |
| `workspace/research/` | 外部专题研究资料目录的符号链接 |
| `workspace/archive/` | 外部历史构建归档目录的符号链接 |

## 外部生成物存储

2026-10-19，作品、报告、研究下载、设计稿和归档迁入用户家目录。旧路径保留符号链接，脚本、文档和 API 无需更改路径；后续写入也会落到外部目录。

| 项目中的兼容入口 | 实际目录 |
|---|---|
| `workspace/outputs/image/` | `/home/aoike/图片/llm-backend/模型输出/` |
| `workspace/outputs/video/` | `/home/aoike/视频/llm-backend/模型输出/` |
| `workspace/outputs/api/` | `/home/aoike/视频/llm-backend/API/` |
| `workspace/outputs/comfyui/` | `/home/aoike/文档/llm-backend/生成物/ComfyUI/` |
| `workspace/outputs/geneval/` | `/home/aoike/文档/llm-backend/生成物/GenEval/` |
| `workspace/outputs/paiton/` | `/home/aoike/文档/llm-backend/生成物/Paiton/` |
| `workspace/reports/` | `/home/aoike/文档/llm-backend/报告/` |
| `workspace/research/` | `/home/aoike/文档/llm-backend/研究资料/专题/` |
| `workspace/avatar-research/` | `/home/aoike/文档/llm-backend/研究资料/数字人/` |
| `workspace/rocm-research/` | `/home/aoike/文档/llm-backend/研究资料/ROCm/` |
| `workspace/designs/` | `/home/aoike/文档/llm-backend/设计稿/` |
| `workspace/archive/` | `/home/aoike/文档/llm-backend/归档/` |

ComfyUI 的图片、视频以及工作流关联目录整体保存；GenEval 的样本图片、元数据和回执整体保存。报告中的验证图片和视频也保留在对应报告中。

新增下载资料放到 `workspace/research/<主题>/<日期>/`，结论写入 `docs/`；截图与验证输出放入对应的 `workspace/reports/` 子目录。两者均通过符号链接写入家目录。运行所需的模型、缓存、依赖和生产构建保留在项目中。

迁移清单、逐文件 SHA256 和容器恢复记录位于 `/home/aoike/文档/llm-backend/迁移记录/`。迁移时逐目录复制并校验后才移除原件；相关输出容器重新启动以刷新挂载，并验证容器能够读取外部输出文件。

迁移项目到其他机器时，需要一并复制外部生成物目录，或重建兼容符号链接。修改外部目录位置后，先更新对应链接，再重启挂载这些输出目录的容器。

## 统一检查

在根目录执行：

```bash
./lab check                        # 四组 Python 测试与工作台 Node.js 测试
./lab check --suite python         # 仅 Python
./lab check --suite node           # 仅工作台
./lab check --python /path/to/python
```

Python 默认使用已有 `.workbench/envs/tools/bin/python`，不存在时使用当前解释器；ComfyUI 中继测试需要 `aiohttp`。工作台需要 Node.js 22.19+ 与已安装的 `platforms/workbench/node_modules/`，可用 `WORKBENCH_NODE=/absolute/path/to/node` 指定解释器。检查不会安装依赖；缺少依赖时修复环境后重新执行。

入口运行以下测试，任一组失败都会返回非零状态，并继续汇总其他组：

- `.workbench/tests/`：部署路由、配置、模型校验、运行时与监控工具。
- `platforms/comfyui/tests/`：原生中继与工作流模板同步。
- `platforms/scheduler/tests/`：驻留实验辅助工具。
- `.workbench/runtime/cpu-vision/test_telemetry.py`：并发计数与计算延迟。
- `platforms/workbench/tests/*.test.mjs`：网关、调度、API、访问密钥与页面状态。

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
