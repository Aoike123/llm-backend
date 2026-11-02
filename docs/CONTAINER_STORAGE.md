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

## 镜像体积

2026-11-02 起，所有运行时镜像都由 `./lab runtime build` 从供应商底座构建成单层镜像，ROCm SDK 在宿主机上只存一份，以只读方式挂载。之前叠层构建留下的旧 SDK、安装包和重复副本因此一并消失：三个 GPU 镜像从约 145 GB 降到约 36 GB。做法和升级流程见 [运行时镜像](RUNTIME_IMAGES.md)。

## 迁移与回退

维护脚本：`.workbench/scripts/migrate-container-storage.py`。要求 root、`--apply`、目标分区已挂载且空间足够，发现已有目标目录会拒绝重跑。

流程为在线预复制、再次检查渲染队列、停止原先运行的容器和运行时、最终同步、对比文件元数据、更新两个存储配置、恢复原容器、核对容器与镜像 ID、检查两个 ComfyUI 服务。验证前失败会恢复原配置和存储；验证成功后才删除旧副本。

维护单元日志、原配置备份和执行清单位于 `workspace/reports/maintenance/docker-20261019/`。迁移完成后，旧存储副本已删除，后续回迁需要重新停服务并同步当前数据，不能只恢复旧配置。

镜像清理用 `./lab runtime prune`：它只删除没有被 `workspace/config/runtime-images.json` 引用的镜像、SDK 版本和构建残留，默认只预览。停止的 GPU 容器可能只是在等待调度；不要使用无范围的 `docker system prune`。
