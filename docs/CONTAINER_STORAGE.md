# 容器存储与空间维护

## 本机目录

系统目录和 `/home/aoike` 共用 `/dev/nvme0n1p4`。模型位于 `/mnt/Code/llm-backend/workspace/data/`，属于 `/dev/nvme0n1p2`。两者为同一块 SSD 上的不同分区。

2026-10-19 22:41 的维护已把容器存储迁往数据分区（单元 `Result=success`，旧副本已删除），最终核对见 `workspace/reports/maintenance/docker-20261019/migration-final.json`。系统分区可用空间由约 26GiB 回升到约 201GiB；`/mnt/Code` 剩余约 350GiB。

| 内容 | 目标目录 |
| --- | --- |
| Docker 配置、容器元数据和卷 | `/mnt/Code/.runtime/docker` |
| containerd 镜像包和解压快照 | `/mnt/Code/.runtime/containerd` |
| 模型 | 继续沿用 `workspace/data/` 中的现有目录 |

Docker 使用 containerd 镜像存储，**只改 Docker 的 `data-root` 不会迁走镜像包和快照**。containerd 的 `root` 也必须迁移；`state` 保持 `/run/containerd`。两个服务均通过 systemd 的 `RequiresMountsFor=/mnt/Code` 等待数据分区挂载。

## 检查

```bash
docker info --format '{{.DockerRootDir}} {{.Driver}}'
docker system df
df -h / /mnt/Code
cat /etc/containerd/config.toml
```

`docker image ls` 的镜像大小含共享层，不能逐项相加。containerd 还保存镜像下载包；镜像历史层中被后续删除或覆盖的文件仍占空间。不要直接删除 containerd 的 blobs 或 snapshots。

## 本次清理和构建优化

- 清理两个失败的临时容器和无容器引用的无标签镜像；保留正式容器、模型、具名镜像及配置引用的运行时。
- ComfyUI 离线组装与 VBench 改用多阶段构建，最终镜像只复制已安装依赖，不携带 wheel 包的 COPY 层。兼容本机现有传统 Docker 构建器。
- ROCm `finalize` 先检查已有 SDK 运行库，已初始化时只检查或修复链接，避免重复运行初始化而产生约 7GB 的文件重写层。
- 修改后的构建配方在后续构建时生效。本次迁移继续使用原镜像，不更换推理环境。

SDK 升级镜像仍继承原供应商镜像的旧层，安装包 COPY 层也仍在现有镜像中。进一步缩小这部分需要重新组织 SDK 构建并逐个验证 ABI，不能通过在容器里删除文件实现。

## 迁移与回退

维护脚本：`.workbench/scripts/migrate-container-storage.py`。要求 root、`--apply`、目标分区已挂载且空间足够，发现已有目标目录会拒绝重跑。

流程为在线预复制、再次检查渲染队列、停止原先运行的容器和运行时、最终同步、对比文件元数据、更新两个存储配置、恢复原容器、核对容器与镜像 ID、检查两个 ComfyUI 服务。验证前失败会恢复原配置和存储；验证成功后才删除旧副本。

维护单元日志、原配置备份和执行清单位于 `workspace/reports/maintenance/docker-20261019/`。迁移完成后，旧存储副本已删除，后续回迁需要重新停服务并同步当前数据，不能只恢复旧配置。

定期清理前先核对 `active.json`、`images.json` 和服务配置中的镜像。停止的 GPU 容器可能只是等待调度；不要使用无范围的容器或卷清理命令。
