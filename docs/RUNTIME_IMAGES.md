# 运行时镜像与共享 ROCm SDK

[文档目录](README.md) · [引擎目录](ENGINES.md) · [存储](STORAGE.md) · [容器存储](CONTAINER_STORAGE.md)

更新：2026-11-02。

## 原则

1. **镜像也按包注册**。每个运行时的配方 `image.json` 放在拥有它的包里；`./lab runtime` 自动发现所有配方，没有中心清单。
2. **ROCm SDK 只有一份**，装在宿主机上，以只读方式挂进所有 GPU 容器。镜像里只保留指向它的符号链接，升级 SDK 不用重建镜像。
3. **镜像始终是单层**。构建在供应商底座的一次性容器里执行配方，然后直接导出成单层镜像。不在旧镜像上叠层，所以无论重建多少次，都不会积累被覆盖的旧文件。
4. **当前用哪个镜像是本机状态**，记录在 `workspace/config/runtime-images.json`，不进 Git。构建出来的新镜像只有在 GPU 验收后才会被激活，上一版保留用于回滚。

## 配方

| 运行时 | 配方 | 使用者 |
| --- | --- | --- |
| `llm` | `engines/llm/pation-model-qwen38-27b-w3a4/image.json` | Qwen3.8 W3A4、CPU 视觉容器 |
| `qwen-image` | `engines/image/pation-model-qwen-image-21/image.json` | Qwen-Image 2.1 |
| `comfy` | `engines/shared/comfyui/image.json` | H3、Anima |
| `vbench` | `.workbench/evaluation/vbench/image.json` | VBench 评测（工具，不是引擎） |

audio.cpp 运行时用的是 `ubuntu:24.04`，把宿主机上编译好的程序挂进去运行，所以没有自己的配方；它同样挂载共享 SDK。

```jsonc
{
  "runtime": "comfy",                      // 与 engine.json 的 platform.runtime.id 一致
  "repository": "local-ai/comfy-h3",       // 产出的镜像名；标签是构建时间
  "base": "ghcr…/paiton-vllm-plugin@sha256:…",   // 供应商底座，必须带 digest
  "prepare": "engines/shared/comfyui/image/prepare.py",   // 可选：构建前在宿主机上的校验
  "steps": [
    {"script": "attach-sdk.py"},           // 不带路径的名字指 .workbench/runtime/rocm101/steps/
    {"copy": {"runtime": "llm", "from": "…/dist-packages", "names": ["torch", "…"],
              "into": "/opt/paiton/site-packages", "replace": ["torch", "torch-*.dist-info"]}},
    {"script": "engines/shared/comfyui/image/assemble.sh"},   // 仓库内路径；.sh 用 sh，其余用 python3
    {"remove": ["/opt/rocm"]}
  ],
  "env": {},                               // 可选：附加环境变量
  "config": {}                             // 可选：覆盖 Entrypoint / Cmd / WorkingDir
}
```

离线依赖的 wheel 按锁文件放在 `workspace/data/runtime/<runtime>/wheels/`（ComfyUI、VBench），需要更新时用 `.workbench/runtime/prefetch-wheels.py --requirements … --destination …` 重新下载并记录 SHA256；配方的 `prepare` 脚本在构建前逐个校验。

构建时容器里能看到：`/src`（仓库，只读）、`/opt/rocm101-sdk`（共享 SDK，只读）、`/build`（`copy` 步骤从其他运行时的当前镜像里取出的文件）。构建以 root 身份运行，最后会清掉 `/tmp` 和 pip 缓存。

`attach-sdk.py` 是每个配方的第一步。它删除供应商自带的 SDK（包括装在 site-packages 之外的命令脚本），把 SDK 的 Python 包和 dist-info 拷进镜像，把 `_rocm_sdk_core/devel/libraries` 三个目录换成指向 `/opt/rocm101-sdk` 的符号链接，再按 10.1 调整 torch 的初始化。torch 的 RUNPATH 指向的是供应商构建机上的路径，实际是靠 `rocm_sdk` 按包位置预加载库，所以符号链接对它是透明的。

## 命令

```bash
./lab runtime status                     # 每个运行时的配方、当前与上一版镜像、SDK 版本
./lab runtime build comfy                # 构建新镜像并做 CPU 侧检查；不激活
./lab runtime activate comfy <tag>       # GPU 验收后切换；会打印回滚命令
./lab runtime prune                      # 预览可删除的东西；--apply 执行，--keep-bases 保留供应商底座
./lab runtime sdk install 10.2.0         # 从 packages.lock.json 锁定的 wheel 安装新 SDK 版本
./lab runtime sdk verify                 # 按 SHA256SUMS 校验当前 SDK
```

`prune` 只删除没有被 `runtime-images.json` 引用的东西：本项目旧标签和旧命名的镜像、供应商底座（需要时可按 digest 重新拉取）、非当前版本的 SDK 目录、构建残留、悬空镜像和卷，以及构建缓存。

## 升级流程

| 要升级的东西 | 做法 |
| --- | --- |
| 引擎依赖或补丁 | 改配方（换底座 digest、加减步骤）→ `build` → 用真实请求做 GPU 验收 → `activate` → `prune --apply` |
| ROCm SDK | 下载新 wheel，更新 `packages.lock.json` → `sdk install <版本>` → 改 `sdk.json` 的 `active` → 每个运行时做一次 GPU 验收 → 删除旧版本目录。镜像不用重建，除非新 SDK 要求换 torch |
| 回滚 | `./lab runtime activate <runtime> <上一版 tag>`；SDK 回滚就是把 `sdk.json` 改回去 |

## 共享 SDK

- 位置：`workspace/data/runtime/rocm101/sdk/<版本>/`。当前版本由 `.workbench/runtime/rocm101/sdk.json` 决定，wheel 锁在 `.workbench/runtime/rocm101/packages.lock.json`，下载包放在 `workspace/data/runtime/rocm101/packages/`。
- 2026-11-02 核对：从锁定 wheel 安装出的 10.1.0，与当时三个已验收镜像里的 SDK 逐文件一致（23,023 个文件、90 个符号链接）；完整安装共 23,080 个文件、6.6 GB。
- 挂载点：所有启动入口都调用 `sdk.mount()`，即 `-v <SDK>:/opt/rocm101-sdk:ro`。目录缺失时直接报错，不会悄悄退回镜像里的旧库。启动入口包括 Qwen-Image 控制器、LLM 启动器、CPU 视觉、H3 compose 与 `run.sh`、audio.cpp、VBench 和 CPU 检查。

## 2026-11-02 改造记录

- 改造前，每个镜像都通过 `docker build` 叠层：先装 SDK（约 7 GB），`rocm_sdk init` 再把 devel 树复制一遍（约 7 GB），供应商底座里的旧 SDK 和用完即删的安装包也留在下层。H3 还在此基础上叠了 ComfyUI 组装层。
- 结果：LLM 61.8 → 17.3 GB，Qwen-Image 31.3 → 6.09 GB，H3 的两个镜像（24 + 26.7 GB）合成 12.4 GB；SDK 在宿主机上只占 6.6 GB。三个镜像都实测过生成，结果和耗时与改造前一致。
- 旧构建链已删除：`rocm101/controller.py`，`Dockerfile`、`finalize`、`torch-sdk`、`comfy-offline` 几份 Dockerfile，`build-comfy-offline.py`，`upgrade-sdk.py`，`init-sdk.py`，`images.json`，`active.json`，以及 CPU 视觉和 VBench 的 Dockerfile。
- 四个运行时都按配方从供应商底座重建，并和改造前已验收的镜像逐文件对比：差异只有 pip 元数据、旧补丁叠层的残留目录，以及 SDK 的 Python 命令包装脚本（真实程序在 PATH 第一位的 `/opt/rocm101/bin`）。GPU 验收：Qwen-Image 文生图 29.99 秒；Anima、H3 参考视频、金鱼持久任务正常；LLM 文本与视觉正常；VBench 四维分数与历史记录逐项一致。
- `./lab runtime prune --apply` 之后，Docker 镜像总量从 223 GB 降到 85.5 GB，其中 36.5 GB 是三个运行时的上一版（用于回滚，确认不再需要时再执行一次 `prune` 删除）。
