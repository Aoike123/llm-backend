# 语音合成（TTS）在 ROCm 上的选型调研

更新：2026-10-23。状态：**已结案**。2026-10 已接入 CosyVoice 3（RL checkpoint），见 [引擎目录](ENGINES.md) 与 [媒体 MCP](MEDIA_MCP.md) 的 `generate_audio`；以下为当时的选型记录，文中 CosyVoice 2 的结论由 3 代替。目标硬件：Radeon AI PRO R9700（gfx1201，32 GB），宿主 ROCm 10.1，容器内 PyTorch `2.12.0+rocm10.0.0`、torchaudio `2.11.0+rocm10.0.0`。

## 结论

1. 如果**必须支持逐字指定读音（多音字/生僻名）**，主选 **CosyVoice 2**：它是目前唯一原生支持行内拼音标注（`[shan4]`）的中文开源 TTS，同时具备零样本克隆和 Instruct 语气控制。
2. 如果读音可以用同音字替换解决，**Qwen3-TTS 0.6B** 是更稳的选择：Apache-2.0、10 种语言、克隆 + 音色设计 + 自然语言控制、官方提供 vLLM 路径，显存参考值约 2.7 GiB（第三方 AMD 实现的实测）。
3. **GPT-SoVITS 只作为“固定角色音色精调”的第二引擎**：官方 README 已合入 AMD 支持步骤，ROCm 风险最低，但流水线最重。
4. 无论选谁，MCP/API 契约保持 `generate_audio` + `model` 参数不变，后端可替换。

## 候选对比

| 候选 | 中文自然度 | 零样本克隆 | 多音字/拼音 | ROCm 证据 | 显存 | 主要风险 |
| --- | --- | --- | --- | --- | --- | --- |
| CosyVoice 2 | 高 | 是 | **原生行内拼音** | 无官方文档，纯 PyTorch | 6–8 GB | pynini/onnxruntime 依赖、gfx1201 未验证 |
| Qwen3-TTS 0.6B | 高 | 是 | 未提供拼音标注 | 官方未提 ROCm；AMD 纯 HIP 实现限定 gfx1100/1151 | **~3 GB** | flash-attn 可选、SDPA 在 gfx1201 的因果内核问题 |
| IndexTTS 2.5 | 高（情感强） | 是 | 无（需同音字表） | 第三方 ROCm sidecar 已适配 ROCm torch | 6–8 GB | RDNA2 上 bf16 段错误记录，RDNA4 需复测 |
| GPT-SoVITS | 高（可精调） | 是（少样本） | 自定义词典 + g2pW | **官方 README 已合入 AMD 步骤** | 6–8 GB | g2pW 依赖 TensorFlow（需 CPU）、流程重 |
| Kokoro 82M | 中 | 否 | 无 | ONNX/CPU，天然跨平台 | CPU | 无克隆，中文音色一般 |

### CosyVoice 2

- 优点：流式大模型架构，呼吸感与停顿自然；Instruct 支持“轻快/带笑意”等描述；行内拼音 `[shan4]` 可 100% 指定声调，且保持整句语流。
- 依赖：`torch`/`torchaudio`、`matcha`、`WeTextProcessing`（pynini，编译常失败）、`onnxruntime`（说话人向量，CPU EP 即可）。
- ROCm 判断：没有检索到官方 AMD 文档；但模型是纯 PyTorch 前向，卷积/STFT/GRU 类算子在 ROCm 上通常可用，主要不确定性在依赖安装与 vocoder 算子。
- 结论：**值得先花 1–2 天做 spike**。

### Qwen3-TTS 0.6B / 1.7B

- 2026-01 发布，Apache-2.0 代码；10 种语言；支持 Voice Design、Voice Clone、自然语言指令控制；提供 vLLM 用法。
- AMD 生态：社区项目 [navi-tts](https://github.com/shawnshekari/navi-tts) 用纯 HIP 重写，7900 XTX 上 RTF 0.086、权重 + vocoder 约 2.7 GiB；但**只支持 gfx1100 / gfx1151，明确不提供回退**，gfx1201 需要自己移植内核。
- 官方 PyTorch 路径推荐 FlashAttention 2；ROCm 无 flash-attn，会退回 SDPA。注意：本机已有的 CK 因果 flash 在第二次调用会报 `hipErrorInvalidValue`（见 [H3 多参考编码](H3_REFERENCE_ENCODE.md)），TTS 注意力是否触发同一问题需要实测。
- 结论：**最佳备选**；若拼音不是硬需求，可直接评估。

### IndexTTS 2.5

- 中文情感与零样本克隆口碑好；社区 [VoiceStudio](https://github.com/debpalash/VoiceStudio) 已合入“在 ROCm 宿主机安装 ROCm torch”的 sidecar 修复（PR #2423），说明可跑。
- 已知问题：RDNA2（gfx1030）上因 `is_bf16_supported()` 误判导致段错误（issue #2372）；gfx1201 的 bf16 在 H3 上工作正常，但仍需复测。
- 无原生拼音标注，只能靠同音字替换表。

### GPT-SoVITS

- 官方仓库已合并 [AMD 支持 PR #2076](https://github.com/RVC-Boss/GPT-SoVITS/pull/2076)，README 含 AMD 额外步骤，是 ROCm 证据最完整的一个。
- 适合“有几十秒到几分钟干声、要精调专属音色”的场景；G2P 用 g2pW（TensorFlow 模型，需 CPU 推理）。
- 作为第二引擎在需要固定角色音色时再接入，不建议首发。

## gfx1201 特有风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| CK 因果 flash 二次调用崩溃 | 若 TTS 使用 SDPA 因果注意力，可能直接失败 | 强制 math/eager 注意力或 `is_causal` 分块；实测确认 |
| flash-attn 2 不支持 ROCm | 官方推荐路径不可用 | 退回 PyTorch SDPA 或 eager，接受速度损失 |
| bf16 在 RDNA 上偶发段错误 | IndexTTS 等模型可能崩溃 | 强制 fp16/fp32 启动 |
| pynini / WeTextProcessing 编译失败 | CosyVoice 文本正则装不上 | 跳过 TN，用简化正则；或预编译 wheel |
| 单卡 32 GB 与 H3 互斥 | TTS 与视频任务必然切换 | 任务合批 + 调用规范；TTS 模型小，切换成本可接受 |

## 推荐路线

```text
第一优先：CosyVoice 2（拼音是硬需求）
   └─ spike 失败 → IndexTTS 2.5（有 ROCm sidecar 证据）
        └─ 仍失败 → GPT-SoVITS（官方 AMD 步骤）
             └─ 只做轻量旁白 → Kokoro ONNX（CPU，常驻，不占 GPU）
```

如果确认**不需要逐字拼音**，顺序调整为：Qwen3-TTS 0.6B → IndexTTS 2.5 → CosyVoice 2。

## 验证计划（spike，2 天，不改现有服务）

1. 用现有 `pation-qwen38-cpu-vision:20261013-r2` 作基础镜像（已含 ROCm torch / torchaudio），装 CosyVoice 依赖，独立容器跑在 `127.0.0.1:18986`；
2. 三个用例：
   - 内置音色朗读 200 字中文（含“银行/行走/着火/看着”）；
   - 10 秒干声零样本克隆，再读同一段；
   - 行内拼音：`今天我去见[shan4]田芳`，核对是否 100% 读作 shàn；
3. 指标：RTF（实时率）、显存峰值、首次加载时间、克隆相似度（主观 + 可选 ASR 回环字错率）；
4. **通过标准**：RTF < 0.3、拼音标注生效、克隆无明显机械感、显存 < 10 GB；任一不满足则按回退梯子换模型；
5. 产出：`workspace/reports/tts/` 下的耗时、显存与样例音频，供你试听后再决定正式接入。

## 待确认

1. 拼音标注是否硬需求？（决定主选 CosyVoice 还是 Qwen3-TTS）
2. 是否需要克隆真人/角色音色，还是内置音色即可？
3. 是否接受 TTS 与 H3 之间更频繁的 GPU 切换？
4. 许可证：Qwen3-TTS 权重为 Qwen Community License，CosyVoice / GPT-SoVITS / IndexTTS 的权重条款需在正式接入前确认商用边界。

## 参考

- [Qwen3-TTS 仓库](https://github.com/QwenLM/Qwen3-TTS)（Apache-2.0 代码，0.6B/1.7B）
- [navi-tts：AMD-first Qwen3-TTS（纯 HIP）](https://github.com/shawnshekari/navi-tts)（gfx1100/1151，RTF 0.086）
- [GPT-SoVITS AMD 支持 PR #2076](https://github.com/RVC-Boss/GPT-SoVITS/pull/2076)（已合并）
- [VoiceStudio：IndexTTS ROCm sidecar PR #2423](https://github.com/debpalash/VoiceStudio/pull/2423)
- [VoiceStudio issue #2372：RDNA2 bf16 段错误](https://github.com/debpalash/VoiceStudio/issues/2372)
- [CosyVoice 仓库](https://github.com/QwenAudio/CosyVoice)
