# 虚拟主播 / 数字人直播：本机技术栈与可行性

> 状态：2026-10-19 调研。硬件与本机链路为实测；模型速度为各项目**官方声明**或第三方汇总，未在本机复现的均标注「推算」。
> 范围：只讨论可私有部署的开源方案；SaaS（HeyGen、硅基智能等）不计入成本比较。

## 一、结论

1. **显卡不是瓶颈。** R9700 的 32 GB 显存、实测约 96 TFLOPS（fp16 矩阵乘）与 RTX 4090 的算力同级；同时跑「语音识别 + 语音合成 + 口型模型」在算力上绰绰有余。
2. **写实数字人：实时档做得到，高质量档做不到。** 实时档是 256×256 脸区生成、1080p 画布回贴（MuseTalk / QuickTalk / LiteAvatar 一类），25–30 fps 可行；OmniHuman、Wan-S2V、InfiniteTalk 这类整帧生成模型只能离线出片，32 GB 也只够跑短片。
3. **AI 自主主播：没有硬门槛。** Live2D 皮套在浏览器里用 WebGL 渲染，GPU 只负责 ASR/TTS/LLM；这台机器的缺口在 Linux 推流链路，以及 OBS 30 没有浏览器源，不在算力。
4. **要站起来跳舞，得换 3D。** Live2D 是分层 2D，做不了转身和迈步；实时跳舞用 VRM + 动作库在浏览器渲染，几乎不占显存；写实的全身跳舞只能靠 Wan-Animate-2 一类模型离线预制，实时做不到。
5. **真正的风险在软件栈。** 这批项目默认 CUDA + TensorRT + flash-attn。AMD 上 TensorRT 无替代（只能退回 PyTorch，慢 1.5–3 倍）；flash-attn 的 CK 后端只覆盖 MI200/MI300，RDNA 上要用 PyTorch 自带的 SDPA（AOTriton 已含 gfx1201 目标）；onnxruntime 的 CUDA EP 不可用，要换 MIGraphX EP。**选型的第一标准是「依赖干不干净」，不是「效果好不好」。**

## 二、本机基线（实测）

| 项 | 实测值 | 说明 |
| --- | --- | --- |
| GPU | AMD Radeon AI PRO R9700，`gfx1201`，31.9 GB | RDNA4，PCI `1002:7551` |
| fp16 算力 | **95.8 TFLOPS**（4096³ matmul，20 次平均） | 容器内实测，`local-ai-vbench:rocm101` |
| 推理栈 | torch `2.12.0+rocm10.0.0`，HIP `7.15` | gfx1201 kernel 已包含，`torch.cuda.is_available()=True` |
| ROCm 支持面 | ROCm 10.1 官方矩阵含 gfx1201（6.4.1 起） | PyTorch 2.13/2.14、ORT 1.29、MIGraphX 2.18、vLLM 0.29 均标注支持 |
| 内存 / CPU | 94 GiB / 双路 Xeon E5-2696 v4（44 核 88 线程） | 足够做 CPU 侧 ASR、编码、容器 |
| 系统 | Ubuntu 24.04，内核 7.0，Mesa 25.2.8 | Mesa 25.2 支持 RDNA4 的 VAAPI 编码 |
| 硬编 | ffmpeg 含 `h264_vaapi` / `hevc_vaapi` / `av1_vaapi` | RDNA4 的 VCN 支持 H.264/HEVC/AV1 编码 |
| 显示 | 2 路 DP 已连接（DP-1、DP-2） | 可以一路放皮套、一路放工作台 |
| 摄像头 | 无（`/sys/class/video4linux` 为空） | 只能做「AI 驱动」，不能做真人面捕 |
| OBS | 30.0.2，**无 `obs-browser` 插件** | 浏览器源不可用，见第七节 |
| 空闲磁盘 | 约 536 GiB | 模型权重够放 |

复测命令（已验证通过）：

```bash
docker run --rm --entrypoint /bin/bash --device=/dev/kfd --device=/dev/dri \
  --group-add video local-ai-vbench:rocm101 -lc \
  'python3 -c "import torch;print(torch.__version__, torch.cuda.get_device_name(0))"'
```

## 三、三条路线的结构差异

```text
路线 A（AI 自主主播）          路线 B（写实数字人）
  弹幕 / 语音                      TTS 音频
      │                              │
   ASR ──► LLM ──► TTS           音频特征（HuBERT / wav2vec）
      │                              │
  Live2D 骨骼/口型参数            口型 + 表情模型（生成脸区）
      │                              │
  浏览器 WebGL 渲染              回贴 + 超分 + 合成整帧
      │                              │
      └────────► OBS / WebRTC ──► RTMP 推流 ◄──┘
```

- A 是**参数驱动**：GPU 只算文本和语音，画面是矢量动画，显存占用低、延迟低、风格是二次元。
- B 是**像素生成**：每帧都要过神经网络，画质取决于模型和分辨率，显存和算力才是真瓶颈。
- C 是**骨骼动画**：3D 模型 + 动作剪辑，实时渲染，显存几乎为零，能全身跳舞，见第六节。

## 四、路线 A：全 AI 自主主播（Live2D 皮套）

### 4.1 分层技术栈

| 层 | 候选 | 本机结论 |
| --- | --- | --- |
| 弹幕/输入 | `blivedm`（B 站）、平台开放平台、抖音弹幕 | Python 库，可直接接 |
| ASR | SenseVoiceSmall（FunASR）、sherpa-onnx、whisper.cpp（HIP）、faster-whisper | SenseVoice / sherpa 走 ONNX，CPU 即可；**whisper.cpp 支持 HIP，`-DAMDGPU_TARGETS=gfx1201` 可编译**；faster-whisper 依赖 CTranslate2，官方只文档化 CUDA，AMD 上要自编译 |
| LLM | 本机 `qwen38-27b-w3a4`（OpenAI 兼容，`127.0.0.1:18982`）或云端 API | 已有；单路解码约 70 tok/s，够对话 |
| TTS | CosyVoice3-0.5B、GPT-SoVITS、Fish-Speech、F5-TTS、Kokoro（ONNX）、Edge-TTS | GPT-SoVITS 提供 `install.sh --device ROCM`；Fish-Speech 有 `compose.rocm.yml`；F5-TTS README 提到 gfx1201 + ROCm 7.x；Kokoro ONNX 可 CPU 兜底 |
| 变声 | RVC、so-vits-svc | RVC 官方 Linux 仅 CPU，ROCm 只有实验 PR；非必需 |
| 形象渲染 | Live2D（Cubism Native / Web SDK）、VRM（three-vrm）、PNGTuber | Cubism Native **官方支持 Linux**（OpenGL/Vulkan），Web SDK 支持 Linux Chrome；`pixi-live2d-display` 已停更，用 `@naari3` 的 Cubism 5 分支 |
| 合成/推流 | OBS 30 + VAAPI、ffmpeg 直推 | OBS 可用，缺浏览器源（见第七节） |

### 4.2 推荐组合

**MVP（1–2 天能出声）**

- [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)：MIT，官方支持 Linux 与非 NVIDIA GPU，内置 Live2D 前端、ASR/TTS 插件，LLM 可指到任意 OpenAI 兼容端点。把 LLM 换成 `http://127.0.0.1:18982/v1`，TTS 先用 Edge-TTS 跑通，再换 GPT-SoVITS（`install.sh --device ROCM`）或 CosyVoice。
- 弹幕接入先用 `blivedm` 读弹幕，走一个简单的优先级队列喂给 LLM。

**进阶（自研、可控）**

```text
blivedm ─┐
         ├─► 对话调度（打断、优先级、冷却）─► LLM 流式 ─► TTS 流式 ─► Live2D 参数
语音输入 ─┘                                                    │
                                                     WebSocket（口型/表情/动作）
                                                               │
                                                    Chrome kiosk 页面（pixi-live2d-display）
                                                               │
                                                    OBS 窗口捕获 ─► VAAPI ─► RTMP
```

- 自研的收益是**打断**和**多角色**：TTS 要能按句切分、边合成边播，说话时收到新弹幕能立即停。
- [AIRI](https://github.com/moeru-ai/airi) 是另一条路线（WebGPU、VRM + Live2D、桌面端），浏览器版在 AMD 上可直接用，但桌面端的本地推理走 candle（CUDA/Metal），AMD 上只能用 Web 版或远程 API。

### 4.3 延迟预算（本机推算）

| 环节 | 典型耗时 | 本机预估 | 备注 |
| --- | --- | --- | --- |
| ASR（流式） | 100–300 ms | 200 ms | SenseVoice 在 CPU 上足够 |
| LLM 首 token | — | 200–500 ms | 27B W3A4，短提示 |
| LLM 生成 20 token | — | 约 300 ms | 70 tok/s |
| TTS 首包 | 150–300 ms | 300 ms（待测） | CosyVoice 流式 |
| 皮套渲染 | 16–33 ms | 33 ms | 浏览器 30 fps |
| 编码 + 推流 | 100–300 ms | 150 ms | VAAPI + RTMP 缓冲 |
| **合计** | — | **约 1.0–1.5 s** | 接近真人接话的体感上限 |

弹幕场景可以更宽松（10 s 内回复都自然），语音对话才需要压到 1.5 s 内。

## 五、路线 B：照片/视频驱动的写实数字人

### 5.1 分层技术栈

| 层 | 候选 | 说明 |
| --- | --- | --- |
| 形象资产 | 参考图 / 模板视频 / 3D 重建（LAM、3DGS） | 参考图最省事；模板视频画质更稳 |
| 人脸检测对齐 | InsightFace `buffalo_l`（ONNX）、SCRFD、MediaPipe | ONNX 走 CPU 或 MIGraphX EP，别指望 CUDA EP |
| 音频特征 | HuBERT、wav2vec2、Whisper encoder | PyTorch，ROCm 可跑 |
| 口型/表情 | MuseTalk、QuickTalk、SoulX-FlashHead、Ditto、LivePortrait | 见 5.2 |
| 回贴与修复 | GFPGAN / CodeFormer / RestoreFormer、泊松融合 | 小模型，ROCm 或 CPU 都行 |
| 编码推流 | ffmpeg VAAPI、OBS、WebRTC | 同路线 A |

### 5.2 候选方案对比（2026-10）

| 方案 | 输入 | 分辨率 | 官方速度 | 显存 | AMD 可行性 | 许可 |
| --- | --- | --- | --- | --- | --- | --- |
| **LiteAvatar** | 参考图 + 音频 | 2D 脸 | 30 fps @ **纯 CPU** | 0 | ★★★★★ 无 GPU 依赖 | MIT |
| **MuseTalk 1.5** | 模板视频 + 音频 | 256² 脸区回贴 | 30 fps+ @ V100 | ~8 GB | ★★★★☆ 无 TensorRT/flash-attn；DWPose 的 `mmcv` 需源码编译或换 ONNX 版 | MIT（代码） |
| **QuickTalk**（OpenTalking 集成） | 参考图 + 音频 | 256² | 3090/4090 实时 | 未标 | ★★★☆☆ 需 InsightFace ONNX（走 CPU） | 框架 Apache-2.0 |
| **SoulX-FlashHead Lite** | 参考图 + 音频 | 512² | 96 fps @ 4090，可 3 路并发 | 8–12 GB | ★★★☆☆ 源码默认 SDPA，flash-attn/xformers 是可选；要剔除 `nccl-cu12` 并验证 VAE | Apache-2.0 |
| **SoulX-FlashHead Pro** | 同上 | 512² | 10.8 fps @ 4090；25 fps @ 2×5090 | — | ★★☆☆☆ 另外依赖 SageAttention（无 ROCm）| Apache-2.0 |
| **Ditto** | 参考图 + 音频 | 512² | RTF 0.895 @ A100 + TensorRT | — | ★★☆☆☆ 官方推理走 TensorRT；PyTorch 分支 2025-07 才补，帧率会明显低于宣称 | Apache-2.0 |
| **LivePortrait** | 照片 + **驱动视频** | 512² | 67 fps @ 4090（torch.compile） | ~8 GB | ★★★☆☆ 无音频驱动，适合「真人出镜换形象」；`onnx_provider` 默认 cuda，要改 CPU | 需核对（代码与依赖模型许可不同） |
| **Wav2Lip** | 视频 + 音频 | 96² 嘴部 | 60–100 fps | <4 GB | ★★★★★ | 非商用条款，商用需授权 |
| **Ultralight-Digital-Human** | 视频 + 音频 | 轻量 | 20–25 fps @ 2080（ONNX） | <1 GB | ★★★★☆ 每人需单独训练 | Apache-2.0 |
| **Live Avatar / FlashTalk 14B** | 图 + 音频 | 720p | 需 5×H800 / 8×H800 | 单卡 48–80 GB | ☆ 32 GB 直接出局 | 各异 |
| **OmniHuman / Wan-S2V / InfiniteTalk / OmniAvatar** | 图/视频 + 音频 | 720p+ | 离线，分钟级出几秒 | 20–40 GB | ★★☆☆☆ 14B 能加载但远不到实时 | 各异 |

> 速度列来自项目 README 或第三方汇总（[实时性全景对比](https://gongshangzheng.github.io/digital-human-realtime-gpu-comparison.html)），不是本机实测。R9700 的 fp16 算力接近 4090，但显存带宽约 640 GB/s（4090 约 1008 GB/s），**像素生成类模型按 0.6–0.7 倍估算**。

### 5.3 推荐落地顺序

**第 1 步：跑通链路（不碰 GPU 风险）**

[OpenAvatarChat](https://github.com/HumanAIGC-Engineering/OpenAvatarChat)（模块化、WebRTC、Apache-2.0）+ LiteAvatar（CPU，30 fps）+ SenseVoice（ASR）+ 本机 LLM + CosyVoice（TTS）。这一步验证的是**对话编排、打断、WebRTC 播放、推流**，画面先用 CPU 版顶着。

> 移植注意：OpenAvatarChat 的依赖组写死 `pytorch-cu128`，AMD 上要把 torch 源换成 ROCm 索引再用 CPU 版 LiteAvatar；LiteAvatar 本身是 ONNX Runtime CPU，不受影响。

**第 2 步：换 GPU 口型模型**

用 MuseTalk 替换 LiteAvatar：它是这批方案里依赖最干净的（diffusers + transformers + opencv，无 TensorRT / flash-attn / 自定义 CUDA kernel），在 ROCm 上跑通的概率最高。目标是 1080p 画布、25 fps、脸区 256²。

**第 3 步（可选）：冲刺更高画质**

SoulX-FlashHead Lite 是 2026 年公开方案里最值得试的：1.3B DiT、4090 上 96 fps、可 3 路并发，全链路 Apache-2.0。它的源码默认就是 `AttnProcessor2_0` + SDPA，`flash_attn` / `SageAttention` 是 try/except 的可选加速；真正要处理的是 `nvidia-nccl-cu12` 这类 CUDA 专属依赖、`xformers` 缺失，以及在 gfx1201 上验证 Wan/LTX VAE 的数值稳定性。**这仍是研究性工作，不是改配置**，建议放在前两步稳定之后。

### 5.4 混合路线：离线高质量 + 实时口型

实际生产里最划算的组合，也是很多「AI 数字人」产品的做法：

1. 用离线模型（Wan-S2V / InfiniteTalk / 商用合成）生成 3–5 分钟高质量「待机 + 说话」素材；
2. 直播时用 MuseTalk 在素材上做实时口型覆盖；
3. 动作、眨眼、呼吸来自素材本身，嘴型跟着 TTS 走。

画质接近离线模型，延迟是实时的。代价是动作不能即兴，需要准备多段素材轮换。

### 5.5 显存预算（关键约束）

| 组件 | 常驻显存 | 备注 |
| --- | --- | --- |
| LLM Qwen3.8 27B W3A4 | 约 20 GB | 估计值，以 `/v1/models` 查询为准 |
| ASR SenseVoice | 1–2 GB | 也可纯 CPU |
| TTS CosyVoice3-0.5B | 3–5 GB | |
| Avatar MuseTalk | 约 8 GB | |
| Avatar FlashHead Lite | 8–12 GB | |
| Avatar LiteAvatar | 0 | 纯 CPU |
| 桌面 + 浏览器 | 1–3 GB | |

- **27B + MuseTalk + TTS ≈ 33 GB，会超。**
- 可行组合：`27B + LiteAvatar(CPU) + TTS`（约 27 GB）；或 `8B 级 LLM + MuseTalk + TTS`（约 20 GB）；或 LLM 走云端 API，把 32 GB 全留给数字人。
- 现有服务是「按请求加载模型」的调度模式，数字人常驻进程和它的冲突要提前规划，别让调度器把显存抢走。

## 六、路线 C：全身体与跳舞

Live2D 是分层 2D，做不了"站起来、转身、迈步"，要跳舞必须换 3D（或整帧视频生成）。先分清三种诉求：

| 诉求 | 技术路线 | 实时性 | 本机判断 |
| --- | --- | --- | --- |
| 二次元 3D 皮套，按动作库/音乐跳舞 | VRM + 动画剪辑 + 浏览器渲染 | 实时 60 fps | ★★★★★ 推荐 |
| 真人跳什么它跳什么 | 摄像头/追踪器 + VMC 协议 | 实时 | 需加摄像头，属"真人驱动" |
| 写实形象全身跳舞视频 | Wan-Animate-2 一类视频生成 | 离线 | ★★☆☆☆ 只能预制片段 |

### 6.1 VRM 实时路线（推荐）

```text
VRM 模型 ──► three.js + @pixiv/three-vrm（Chrome WebGL）
                    ▲
   动画剪辑 ────────┤  AnimationMixer：idle / 说话 / 跳舞 交叉淡入
   （Mixamo / VMD）  │
   TTS 音频 ────────┘  blendshape（aa/ih/ou）驱动口型 + 表情
                    ▲
   LLM 工具调用 ─────┘ play_dance("科目三") / set_expression("开心")
```

- **形象**：VRM 是跨平台标准，[VRoid](https://vroid.com/) 捏人、booth 买现成模型；Linux 上用 Blender 的 VRM 插件做修模和减面。
- **渲染**：[three-vrm](https://github.com/pixiv/three-vrm) 在 Chrome 里跑，WebGL 足够 60 fps；要原生窗口可以用 Godot 4 + godot-vrm。**这一步几乎不吃显存**，GPU 还是留给 TTS/LLM。
- **动作**：
  - Mixamo 免费动作库 → `vrm-mixamo-retarget` 重定向到 VRM；
  - MMD 的 VMD 舞蹈动作 → [vrm-dance-viewer](https://github.com/JLChnToZ/vrm-dance-viewer)（MIT）直接在浏览器加载，B 站上大量"虚拟主播跳舞"就是这个路线；
  - 想要独家动作：手机/摄像头录一段，用 GVHMR 之类的视频动捕提骨骼再重定向。
- **口型**：VRM 自带 `aa/ih/ou/ee/oh` 五个口型 blendshape，用 TTS 的能量包络驱动即可，不需要神经网络，跳舞时也能同时说话。
- **编排**：给 LLM 暴露几个工具（`play_dance`、`set_expression`、`switch_camera`），它按弹幕点舞；动作队列 + 交叉淡入，避免"瞬移"。
- **"站起来"**：本质就是从坐姿 idle 剪辑切到站姿剪辑，加 0.3 s 交叉淡入即可。

### 6.2 写实全身：只能离线预制

- [Wan2.2-Animate-2-14B](https://huggingface.co/Wan-AI/Wan2.2-Animate-2-14B)（2026，Apache-2.0）：直接吃驱动视频 + 角色图，输出同动作、同表情的视频，还支持文本控制机位。**官方默认配置是 8×A800 跑 720P，480P 也要 2×A800**；Lite 版宣称能到实时流式，但没给单卡消费级的配置。32 GB 单卡只能低分辨率 + 量化 + 长时间等待，定位是"预生成 5–10 秒片段，直播时循环播放"。
- 上一代 [Wan2.2-Animate-14B](https://humanaigc.github.io/wan-animate)（2025-09）已进 Diffusers，思路相同。
- 结论：**写实 + 全身 + 实时 = 目前做不到**，三选二。

### 6.3 真人动捕（"我跳什么它跳什么"）

- 摄像头方案：MediaPipe / Rokoko Video 提骨骼 → VMC 协议 → 浏览器或 Godot。这台机器**没有摄像头**，要加一个（百元级 USB 摄像头就够）。
- 追踪器方案：VIVE Tracker / SlimeVR，精度高，成本高。
- 注意这条是"真人驱动"，和"AI 自主主播"是两种形态，通常不会同时用。

### 6.4 推荐组合

- **直播主形态**：VRM + 动作库 + LLM 编排，实时、可互动、显存几乎为零。
- **高质量片段**：Wan-Animate-2 离线预渲染几段舞蹈，作为"MV 环节"插播，和实时皮套用同一套 OBS 场景切换。
- **版权**：Mixamo 可商用；MMD 动作多数**禁止商用**，booth 上的 VMD 要逐项看许可；商用直播建议自制或买授权。

## 七、推流与音频（三条路线共用）

### 7.1 拓扑

```text
渲染进程（浏览器 / WebRTC / 本地窗口）
        │  画面
        ▼
   OBS 30（窗口捕获 / pipewire 捕获）
        │  VAAPI H.264/HEVC/AV1
        ▼
   RTMP ──► B 站 / 抖音 / Twitch

TTS 音频 ──► PipeWire 虚拟 sink ──► OBS 音频源（monitor）
```

### 7.2 OBS 没有浏览器源的三种解法

本机 OBS 30.0.2 是 Ubuntu 仓库版，**不含 `obs-browser`（CEF）**，所以「浏览器源」加不了。按成本排序：

1. **Chrome kiosk + 窗口捕获**（推荐）：`google-chrome --kiosk --app=http://127.0.0.1:PORT`，OBS 用 PipeWire 窗口捕获。Wayland 下走 xdg-desktop-portal，稳定。
2. **换 OBS 发行版**：Flatpak / 官方 PPA 版本通常带浏览器源，装之前先 `obs --version` 确认，避免和仓库版冲突。
3. **不用 OBS**：应用直接 ffmpeg 合成画面 + 音轨推 RTMP。省一层捕获，但叠字幕/场景切换要自己写。

### 7.3 编码与平台参数

- 编码器选 `FFmpeg VAAPI H.264`（兼容性最好）或 HEVC/AV1（B 站支持 AV1，抖音以 H.264 最稳）。
- 1080p60 建议 6000–8000 kbps，关键帧 2 s；竖屏直播用 1080×1920。
- 音频 48 kHz、AAC 128–160 kbps；TTS 输出先重采样到 48 kHz 再混。
- 虚拟声卡：`pactl load-module module-null-sink sink_name=vtuber`，TTS 输出到 `vtuber`，OBS 采集 `vtuber.monitor`。

## 八、风险清单

### 8.1 AMD 依赖矩阵

| 依赖 | 用途 | gfx1201 现状 | 替代 |
| --- | --- | --- | --- |
| PyTorch ROCm | 所有模型 | ✅ 官方 wheel 自 2.7 起含 gfx1201；本机实测 2.12 可用 | — |
| TensorRT | Ditto / FasterLivePortrait 加速 | ❌ 仅 NVIDIA | 退回 PyTorch，慢 1.5–3× |
| flash-attn | FlashHead 等 DiT | ⚠️ CK 后端只覆盖 MI200/MI300，RDNA 无可用构建 | PyTorch SDPA（AOTriton 含 gfx1201） |
| SageAttention | FlashHead Pro | ❌ 无 ROCm 实现 | 无，Pro 档放弃 |
| xformers | 部分仓库 | ⚠️ 官方轮子只到 rocm7.1/7.2，10.x 需源码编译 | SDPA |
| onnxruntime-gpu（CUDA EP） | InsightFace、检测模型 | ❌ CUDA EP 不可用；ROCm EP 自 ORT 1.23 移除 | MIGraphX EP（`onnxruntime-rocm`）或 CPU EP |
| CTranslate2 | faster-whisper | ⚠️ 有 ROCm 构建（4.8.x/ROCm 7.2），但文档只写 CUDA | SenseVoice / whisper.cpp |
| MediaPipe | 人脸关键点 | ❌ 无 ROCm，仅 CPU | CPU 即可 |
| NCCL | 多卡通信 | ❌ | RCCL（单卡无关） |
| VAAPI | 推流编码 | ✅ | — |

### 8.2 授权与合规

**内容标识（硬性）**

- 《人工智能生成合成内容标识办法》2025-09-01 施行：AI 生成的画面与声音要同时做**显式标识**（画面角标/语音提示）和**隐式标识**（文件元数据）。
- 《直播电商监督管理办法》2026-02-01 施行，第 37 条：用 AI 生成人物图像/视频直播，须**持续向消费者提示**；违反按第 59 条罚 1 万–10 万元。
- 2026-05 起，抖音、B 站等 12 家平台强制「必选标签」，「含有 AI 生成内容」是其中一类，发布前必须勾选。

**素材与模型授权**

- **Live2D Cubism**：SDK 对个人/小规模免费，超过营收门槛需商用授权；官方样例模型另有条款，商用要换自制模型。
- **Wav2Lip**：代码为非商用许可，商用需单独授权。
- **InsightFace `buffalo_l`**：模型权重为非商用研究许可，商用需替换或购买。
- **ChatTTS**：AGPL + CC BY-NC，不能直接商用。
- **声音克隆**：用真人音色需本人书面同意；平台对 AI 合成声音另有备案要求。

### 8.3 7×24 稳定性

- 显存泄漏：长跑要在每 N 小时重启渲染 worker，或在句间做 `torch.cuda.empty_cache()`。
- 断流重连：OBS 开「自动重连」，外层加看门狗脚本。
- TTS 长文本：按标点切句，单句 < 30 字，边合成边播，避免整段等待。
- 弹幕洪峰：入队限流 + 冷却，别让 LLM 被刷屏拖垮。

## 九、验证清单（按顺序做，别跳）

1. **ROCm 基线**：上面的 fp16 命令，确认 `gfx1201` 和 95 TFLOPS 级算力（已验证）。
2. **MuseTalk 单条推理**：克隆仓库，用 ROCm 版 torch 装依赖（跳过 `tensorflow`），跑 `scripts/realtime_inference`，记录 1080p 下的 fps 和显存。
3. **TTS RTF**：CosyVoice 合成 10 s 音频，测「首包延迟 / 实时率」，RTF < 0.5 才算能直播。
4. **推流闭环**：本地起 nginx-rtmp，OBS 用 VAAPI 推 1080p60，测端到端延迟和 CPU 占用。
5. **端到端打点**：从「一句话结束」到「画面首帧」埋时间戳，目标 < 1.5 s。

## 十、落地路线图

| 阶段 | 内容 | 预计工时 | 产出 |
| --- | --- | --- | --- |
| 0 | 依赖验证：ROCm 基线、TTS RTF、OBS+VAAPI 闭环 | 0.5–1 天 | 一组基线数字 |
| 1 | AI 主播 MVP：Open-LLM-VTuber + 本地 LLM + Edge-TTS + Live2D | 1–2 天 | 会说话的皮套 |
| 2 | 写实数字人 MVP：OpenAvatarChat + LiteAvatar + SenseVoice + CosyVoice | 2–4 天 | WebRTC 数字人，可推流 |
| 3 | MuseTalk 接入 + 超分回贴，1080p/25 fps | 1–2 周 | 直播可用的写实画面 |
| 4 | SoulX-FlashHead Lite 移植（改 SDPA、验 LTX-VAE） | 2–4 周 | 更高画质与并发，研究性质 |
| 5 | VRM 全身跳舞：模型 + 动作库 + LLM 工具调用 | 1–2 周 | 能站起来跳舞的 3D 皮套 |
| 6 | Wan-Animate-2 预渲染舞蹈片段（可选） | 1–2 周 | 插播用的高画质 MV |

阶段 1 和 2 可以并行：它们共用 ASR/TTS/LLM/推流，只换渲染层。

## 十一、参考

- [MuseTalk](https://github.com/TMElyralab/MuseTalk)：实时唇形同步，V100 30 fps+，MIT。
- [SoulX-FlashHead](https://github.com/Soul-AILab/SoulX-FlashHead)：1.3B 流式说话头，4090 96 fps，Apache-2.0。
- [LivePortrait](https://github.com/KlingAIResearch/LivePortrait)：肖像动画，4090 约 67 fps。
- [OpenAvatarChat](https://github.com/HumanAIGC-Engineering/OpenAvatarChat)：模块化数字人对话框架（LiteAvatar / MuseTalk / FlashHead / LAM），WebRTC。
- [lite-avatar](https://github.com/HumanAIGC/lite-avatar)：纯 CPU 30 fps 的 2D 说话头，MIT。
- [OpenTalking](https://github.com/flyfire/opentalking)：开源数字人产线（LLM/TTS/WebRTC + QuickTalk/Wav2Lip/MuseTalk）。
- [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)：AI 主播全栈，Linux/非 NVIDIA 可用，MIT。
- [AIRI](https://github.com/moeru-ai/airi)：WebGPU + Live2D/VRM 的 AI VTuber。
- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)：`install.sh --device ROCM`。
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp)：HIP 后端，`-DAMDGPU_TARGETS=gfx1201`。
- [three-vrm](https://github.com/pixiv/three-vrm)：three.js 里加载 VRM，浏览器 3D 皮套的事实标准。
- [vrm-dance-viewer](https://github.com/JLChnToZ/vrm-dance-viewer)：VRM + MMD VMD 舞蹈动作，MIT，浏览器直接放。
- [Wan2.2-Animate-2](https://huggingface.co/Wan-AI/Wan2.2-Animate-2-14B)：驱动视频 → 角色动画，Apache-2.0，离线。
- [GVHMR](https://github.com/zju3dv/GVHMR)：单目视频恢复世界坐标人体动作，用于自制舞蹈动作。
- [实时性全景对比](https://gongshangzheng.github.io/digital-human-realtime-gpu-comparison.html)：30+ 模型按 GPU 档位的 FPS/显存汇总。
- [实时数字人 Benchmark 汇总](https://gongshangzheng.github.io/digital-human-engineering-benchmark.html)：A10 等卡上的实测数据。
- [ROCm 10.1 兼容矩阵](https://rocm.docs.amd.com/en/docs-10.1.0/compatibility/compatibility-matrix.html)：gfx1201 与各框架的支持状态。
