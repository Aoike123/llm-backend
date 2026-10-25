# ROCm 10.1 升级记录

[文档目录](README.md)

> 状态：2026-10-11 起的迁移与验证记录，保留当轮环境及配置。日常操作见 [安装与运维](OPERATIONS.md)，当前能力见 [项目现状](PROJECT_STATUS.md)。

2026-10-11：宿主升级并重启完成，已加载 amdgpu 7.1.9.31600000，amdrocm 10.1.0-3，内核 7.0.0-38-generic。开始分项验证，单卡模型保持顺序运行。

宿主机为 Ubuntu 24.04.5、7.0 HWE 内核、Radeon AI PRO R9700。AMD 官方 10.1 兼容矩阵包含此组合，驱动要求 31.60 或 31.50。安装脚本使用官方 31.60 安装器；其 Noble 仓库 `rocmradeon/apt/26.16` 的 `amdrocm` 为 `10.1.0-3`。

在本机终端执行：

```bash
cd /mnt/Code/llm-backend
bash .workbench/scripts/upgrade-host-rocm101.sh
```

输入 sudo 密码，安装成功后保存工作并手动重启。脚本不会自动重启。

容器升级配方在 `.workbench/runtime/rocm101/`；SDK 包保存于 NVMe 的 `workspace/data/runtime/rocm101/packages/`，文件及 SHA256 锁定在 `packages.lock.json`。分别构建 Qwen LLM、Qwen Image、MiniMax H3、FLUX 推理、FLUX 工具与 FLUX ComfyUI 容器。Wan/FastWan 运行时使用已验证的 H3 Ubuntu 24/SDK 10.1 基础镜像，以满足优化库 GLIBC_2.38 依赖；关闭文本 W3 hooks 开关。视频容器以宿主 UID 运行，并显式设置 USER、HOME 与编译缓存，避免系统用户名查询失败。旧基础镜像保留用于回退。

```bash
./lab runtime status
./lab runtime build --engine qwen-image21
./lab runtime check --engine qwen-image21
```

检查命令不传入 GPU 设备，核验 SDK 版本、PyTorch 导入、HIP 库加载路径和运行时版本。它不能证明 GPU 推理成功。Qwen 的 PyTorch 保留引擎供应商编译版本；FLUX/H3 原 PyTorch 2.12 的二进制直接依赖 10.1 已移除的旧 SMI 库，必须迁移为 Qwen LLM 供应商的 PyTorch 2.12 ROCm 10.0 构建，再配合 SDK 10.1。`torch_compiled_hip` 与运行时版本分别记录，定制扩展兼容性仍需要 GPU 实测。SDK 旧 overlay 和固定旧库路径需要一并清理。

供应商 PyTorch 初始化适配位于 `patch-torch-init.py`：SDK 版本检查改为 10.1，并移除已被 AMD SMI 替代的 `rocm_smi64` 预加载项。其他缺失的库会使构建失败，不会静默忽略。LLM 的 FP8 lm_head 等特征识别保留原基础镜像信息，避免本地镜像改名改变既有推理配置。

构建后的 `*-cpu-check.json` 和 `*-image.json` 记录实际结果。`./lab runtime activate --engine ENGINE` 必须先通过 CPU 库检查才会更新配置；它不会启动推理。FLUX 必须三个相关镜像均激活，启动入口才切换整套后端。GPU 基础检查脚本 `probe-gpu.py` 已通过有限值矩阵乘法与卷积检查，显存峰值约 35 MB。

宿主升级后，按小规模运算、1024 图像、RGBA、参考图编辑、ComfyUI 工作流的顺序验证，并检查内核日志及输出像素。发现新的 GPU 页错误、非法指令或显示异常立即停止。此前输出的全零 PNG 不算生图成功。

中央 ComfyUI 使用 CPU PyTorch，无 GPU 设备挂载，通过 API 调用工作容器；监控平台也不依赖 ROCm。它们可以在 GPU 服务停用时继续运行。

来源：[ROCm 10.1 兼容矩阵](https://rocm.docs.amd.com/en/docs-10.1.0/compatibility/compatibility-matrix.html)、[官方安装说明](https://rocm.docs.amd.com/en/docs-10.1.0/install/rocm.html)、[R9700 hipBLASLt 故障记录](https://github.com/ROCm/TheRock/issues/7699)。本机故障与该记录相似，尚不能证明是同一原因或升级已解决。

## 本轮结果

七个运行时镜像已构建，SDK 10.1、PyTorch 导入和 HIP 库加载检查通过，项目启动配置已切换。FLUX/H3 的图像依赖导入通过。21 项项目检查通过，CPU ComfyUI 健康、节点注册正常。

宿主 AMD 驱动已安装并重启验证。Qwen Image 在 exact、关闭 native fusions、SDMA off、hipBLAS 配置下生成有效的 1024 图片，首次请求 46.93 秒，设备显存峰值 13.94 GiB。该配置保留为兼容回退：`start --precision-profile exact --no-native-fusions`。

ComfyUI 文生图 33.22 秒、RGBA 33.21 秒、参考图编辑 44.36 秒，均得到有效输出并通过工作流历史检查。RGBA 有 373882 个全透明像素。参考图编辑改变了茶壶颜色，但纹理明显改变，不能认定编辑保真度已达到要求。测试期间未观察到新的 GPU 页错误或重置；有限轮次不能证明长期稳定性，也不能认定此前故障根因已解决。

优化配置 schedule-int8 + native fusions 已通过 1024、2048、ComfyUI RGBA 和编辑测试，现设为启动默认。1024 热请求 19.96 秒，2048 热请求 107.46 秒（40 步、CFG 1）；RGBA 21.22 秒，编辑 27.21 秒。编辑纹理异常仍存在，暂不认定保真度合格。

LLM 已通过基础聊天、数学和代码测试，以及 256018 输入 token 的视觉/思考验证、8 路混合请求验证（8/8 成功）。关闭不支持该单卡架构且依赖旧 SMI 的可选 MoRI 包，保留源文件用于回退。H3/Wan ComfyUI 容器已离线组装并通过 CPU 节点导入；H3 文生视频、参考图及首尾帧通过中央 ComfyUI，576×320/124帧含音频；864×480/8步文生视频用时105.54秒，画质比低分辨率更细致但仍有粗糙纹理。FLUX 已完成离线转换（82.28秒，100层 INT8），Wan 已通过 832×480/49帧文生视频（首轮86.15秒）与中央参考图视频（48.97秒）。FLUX Flash SDPA 在小 GQA 张量上返回 HIP invalid argument，Math SDPA 有限值检查与完整 Paiton 编译生图通过；Math 配置已加入两个 FLUX 镜像并在后续重建时自动应用。Paiton、Stock API 和中央工作流均已通过；Paiton 中央热请求1024/4步为2.44秒。各检查结果在 `workspace/reports/runtime/rocm101/` 与 `workspace/reports/image/qwen-image21/`。
