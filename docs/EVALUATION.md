# 评测协议与当前状态

[文档目录](README.md)

本项目配置了常用公开评测工具。没有一个统一的“智商”分数；数学、知识、代码和媒体生成能力应分项报告。**文本基础推理及 lm-evaluation-harness 两样本 API 链路已通过；尚未完成标准能力全量评测。视频四维评测已通过，GenEval 检测评分环境未验收。**

## LLM 性能：vLLM bench serve

`./lab bench llm` 在运行中的 Qwen 容器内调用该容器版本的 `vllm bench serve`。固定 random 输入 1024 token、输出 256 token、seed 42，关闭 thinking，依次测并发 1/2/4/8。默认每档 32 请求，正式运行建议 `--num-prompts 256` 并重复三次。使用 JSON 输出中的成功请求数、输出吞吐、TTFT、TPOT/ITL 和延迟分位数；失败请求和实际输出长度也必须保留。

2026-10-12 已验证四档各8请求、全部成功（32/32），实际输入合计每档8292 token、输出每档2048 token，报告 `workspace/reports/llm/paiton/20261011T170606695673Z/results/`。整批输出吞吐1/2/4/8路为71.71/107.19/173.51/237.09 tok/s，包含批次耗时；不能理解成单路解码速度。此短样本只验收工具链，不是正式性能结论。测速客户端禁用服务端专用 Paiton/DFlash 插件，服务端 W3A4/DFlash 推理配置不变。

随机合成负载用于受控吞吐测量，不能替代真实聊天／代码流量。先做一次预热，再做正式测试；下载、冷启动和热态性能分开记录。上述数字属于当轮运行配置，不能直接与博客的独占 GPU 配置或后来改动的引擎配置比较；现行策略见 [LLM 配置](LLM_MODES.md)。

测速结果复制到 `workspace/reports/llm/paiton/时间/results/`；Docker 版本、运行容器和 GPU sysfs 状态随报告保存。完整镜像元数据可以追加：

```bash
docker inspect paiton-qwen38 > workspace/reports/qwen-container.json
docker exec paiton-qwen38 python3 -c \
  'import torch; print(torch.__version__, torch.version.hip); print(torch.cuda.get_device_properties(0))'
```

以容器内 HIP 返回的型号、架构和可用显存作为运行兼容性的最终依据。

## LLM 能力：EleutherAI lm-evaluation-harness

安装在 `.workbench/envs/tools`，通过本机 API 调用 GPU 服务。2026-10-12 已使用 GSM8K 两条样本验证请求、生成、答案提取和结果保存（2/2正确，仅链路测试）。数据集官方源下载成功；当次国内镜像未返回数据集。聊天接口不使用客户端 tokenizer，服务端负责 token 化；本地最大长度配置不能代替服务端截断检查。默认 `gsm8k_cot` 是数学生成任务，temperature 0、单请求并发、seed 42、输出上限 4096 token、thinking 关闭。

```bash
./lab eval-llm --limit 10     # 验证链路，不能报告正式能力分数
./lab eval-llm               # 完整 GSM8K
./lab eval-llm --tasks mmlu_pro --limit 10
```

任务名以锁定版本中的 `lm-eval ls tasks` 为准。Chat API 只支持 `generate_until`；传统 MMLU、HellaSwag、ARC 等依赖 loglikelihood 的任务不能直接塞进聊天接口。要评测这些任务，应使用 completion/logprobs 后端并确认该服务提供所需 logprobs，或建立独立的原生模型评测环境。HumanEval/MBPP 等代码执行任务需要独立隔离的执行环境，本配置不自动运行生成的代码。

报告保留 prompts、模型输出、量化格式、上下文长度、few-shot 设置、是否 thinking、截断数量和样本数量。按模型的官方评测协议对照，不能把本项目“thinking 关闭”的结果与其他模型不同设置混为一谈。

## 图像／视频性能

`./lab bench image|video|video-audio --engine stock|paiton` 调用 Paiton 官方 benchmark。FLUX 的标题成绩计时到 PIL 图像，不包括 PNG 编码与文件保存；视频包含提示处理、去噪、解码、编码和写 MP4。按相同 prompt/seed/分辨率/帧数/步数分别运行 stock 和 paiton；原始结果保存在 `workspace/outputs/{image,video}/*/benchmarks/`。

FLUX 使用三提示词 suite；FastWan 使用 480 分辨率级别、2 秒短片；H3 使用 turbo8、124 帧短片。下载／模型准备发生在计时外。正式比较前检查原始结果是否确实具有同样的设置与成功输出，不能拿不同步数或不同分辨率的耗时直接比。

## 图像能力：GenEval

官方 prompts、检测器评分程序与源码已锁定下载。两条官方提示词、每条一张1024图片的真实 API 导出已通过（`workspace/outputs/geneval/20261011T164912595014Z`），参数与回执齐全；尚未执行检测器评分。样本导出接到本机 Qwen-Image API：

```bash
./lab pation-model-qwen-image-21 start  # 空闲维护窗口，手动启动图像后端
# 另一终端，先验证两条 prompt，每条一张
./lab geneval-export --limit 2 --samples 1
# 完整官方 prompt suite，每条四张图
./lab geneval-export
```

样本位于 `workspace/outputs/geneval/时间/00000/metadata.jsonl` 和 `samples/00000.png`；保存每次请求参数、服务回执和 HTTP 耗时，不复写旧结果。GenEval 衡量对象、计数、颜色、位置和属性组合对齐，不是纯审美分数。完整样本导出会产生数千张图片，应先完成冒烟检查。

**兼容性限制：评分环境未构建。** 上游 `environment.yml` 固定 Python 3.9、CUDA 11.3、PyTorch 1.12 和 MMDetection 2.x；评测程序明确要求 GPU。不能将该 CUDA 环境直接安装到本机 AMD 推理环境。需要独立验证 ROCm + MMCV 编译兼容性，或将导出样本交给兼容的评分设备。源码和模型下载脚本都已保留。

准备好独立评分环境及 Mask2Former checkpoint 后可运行：

```bash
export GENEVAL_PYTHON=/absolute/path/to/geneval-env/bin/python
export GENEVAL_MODEL_DIR=/absolute/path/to/detector-checkpoints
./lab evaluate-media geneval workspace/outputs/geneval/某次生成目录
```

## 视频能力：VBench

源码已锁定，已构建并验证独立 ROCm 10.1 四维环境，镜像 `local-ai-vbench:rocm101`。依赖从项目 NVMe 的 SHA256 校验 wheel 安装；上游指标代码保持不变，运行入口关闭本机异常 Flash SDPA 并启用 Math SDPA。四维实测 H3 与 Wan 共两段视频成功，均返回有限数值。

```bash
# 先停止 GPU 模型服务
./lab stop
./lab evaluate-media vbench workspace/data/vbench/validation-videos
# 离线重建已验证评测环境
python3 .workbench/scripts/build-vbench.py
```

| 当前测试片段 | 主体一致性 | 背景一致性 | 防闪烁 | 运动平滑度 |
|---|---:|---:|---:|---:|
| H3 Turbo8 480p | 0.9539 | 0.9716 | 0.9366 | 0.9817 |
| Wan2.2 480p | 0.9720 | 0.9665 | 0.9025 | 0.9634 |

原始结果：`workspace/reports/vbench-20261011T164444-110379/`。这些维度越高越好，但两段片的提示词、时长不同，不能推导模型排名；画质噪点和审美也不由这四个数直接衡量。`custom_input` 四维只是局部诊断，不能当成完整 VBench 排行榜总分。音频不属于这些维度。

运行器会拒绝与已登记推理 GPU 容器同时运行。容器禁网，仅挂载指定视频、NVMe 评测缓存和本次结果目录；新内核 GPU 故障会触发停止，不保证能避免瞬时桌面异常。若有其他已验证环境，可设置 `VBENCH_PYTHON` 使用自己的解释器。

完整 VBench 16维及 VBench-2.0 未安装验证；需额外依赖和官方生成协议。旧 CUDA 定向全量构建配方已移除，避免误用。

## 本机视觉与长上下文功能检查

`python3 .workbench/scripts/test-vision-long.py` 使用服务默认思考设置，检查一张确定性几何图中的计数、多位置随机密钥检索以及 8 路同时提交的请求。记录真实 API token 数、首个流式 token 延迟、总耗时和整卡显存采样峰值。并行测试的吞吐按整个批次计算，包含预填充及思考输出；不能当作纯解码速度，也不能当作公开标准能力评测分数。
