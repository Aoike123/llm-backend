# 本地模型复用

[文档目录](README.md)

本页记录资源盘文本权重的来源与复用，不是全部已部署模型的清单。资源目录：`/media/aoike/Resource_AI/LLM_Assets`；归档清单包含下述文本模型。媒体模型位于项目 `workspace/data/image/` 与 `workspace/data/video/`，部署状态见 [项目现状](PROJECT_STATUS.md)。

## 已接入的 Paiton 组合

原始文件来自下表的资源目录。当前运行配置 `engines/llm/pation-model-qwen38-27b-w3a4/config/local-models.json` 已改为指向项目 NVMe 的 `workspace/data/llm/paiton/models/{qwen38-nvfp4,qwen38-dflash2,qwen38-w3rot-int3}`；归档 manifest 中的三个 repository revisions 与部署方案一致：

| 用途 | 目录（相对于资源目录） | 权重大小 |
| --- | --- | --- |
| Qwen3.8 27B NVFP4 基础权重 | `models/qwen3.8-27b-paiton/qwen38-nvfp4` | 约 21.81 GiB，含 MTP |
| DFlash2 FP8 草稿 | `models/qwen3.8-27b-paiton/qwen38-dflash2` | 约 1.97 GiB |
| 可选 W3Rot INT3 替换权重 | `models/qwen3.8-27b-paiton/qwen38-w3rot-int3` | 约 8.89 GiB |

三个组件必须保留对应组合，INT3 是 overlay，不能单独作为完整模型启动。`llm` 使用基础模型和草稿，`llm-fast` 再加载 INT3 overlay。

```bash
cd /mnt/Code/llm-backend
./lab fetch       # 本地存在时跳过下载，不要求 HF CLI
./lab pation-model-qwen38-27b-w3a4 start w3a4  # 维护入口，仍需 Docker 和 GPU 权限
./lab pation-model-qwen38-27b-w3a4 stop w3a4
```

主模型、草稿及 overlay 被上游启动器只读挂载到 `/models/target`、`/models/draft`、`/models/w3rot`；已按要求复制这约 32.70 GiB 的权重到项目 NVMe，原件保持不变。项目运行时缓存独立放在 `workspace/data/llm/paiton/runtime/qwen38`。

资源盘是 `fuseblk` 文件系统，仅作为原始模型备份。本项目内的副本位于 `/dev/nvme0n1p2` 的 ext4 分区；运行时不依赖资源盘挂载。

归档的 `manifest.json` 记录 91 个文件，共 35,113,691,045 字节。原件校验日志位于 `workspace/reports/local-model-sha256.txt`；NVMe 副本全部 91 项校验通过，日志位于 `workspace/reports/nvme-model-sha256.txt`，迁移记录见 `workspace/reports/nvme-model-verification.json`。校验是与归档附带 SHA256SUMS 的一致性检查，W3A4 已通过本机容器内 GPU 基础推理验证，MXFP4 运行仍待验证。

## 已发现但暂未接入

- `models/qwen3.8-27b-vllm/Qwen3.8-27B-int4-AutoRound`：约 17.69 GiB，AutoRound INT4，需独立配置支持相应量化格式的 vLLM。
- `models/qwen3.8-27b-vllm/Qwen3.8-27B-DFlash2-W4A16`：约 1.19 GiB，与已接入的 FP8 草稿格式不同。
- `Strata-workspace/data/models/swift-IQ3_XXS/`：两段 Flash Next GGUF，另有视觉 mmproj 和 Strata 打包运行时文件；不能直接替代当前 Paiton NVFP4 / INT3 组合。

这些候选模型保留在原目录，后续可作为其他运行时或量化对照方案。已验证的媒体部署与运行路径见 [服务说明](SERVICES.md) 和 [引擎目录](ENGINES.md)。
