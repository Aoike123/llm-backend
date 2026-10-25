# 上下文分层存储研究（未实施）

[文档目录](README.md)

> 状态：活动 KV 的 RAM/GPU 分层尚未实施。CPU 视觉已另行接入，见 [CPU 视觉实现](CPU_VISION_DESIGN.md)；当前运行策略见 [LLM 配置](LLM_MODES.md)。

用户目标：八路65K继续使用当前GPU方案；仅针对256K长上下文研究RAM+GPU分层，沿用现有KV4格式、W3A4权重与DFlash2。改变KV存储位置，不提高或更换精度。当前服务未启用活动KV卸载。

## Strata已实现什么

Strata使用完整KV主存副本+有限GPU页池，页表记录驻留位置；QSA选出要读的token后，GPU内核处理命中、CLOCK替换和缺页，从映射的锁页内存读取所需KV页。写入更新主存及驻留副本。注意力仍在GPU执行，不是CPU完成attention。文档例子--kv-resident 32768不是截断对话；也不是保证所有模型只读最后32K。批槽文档明确每槽持有独立状态，KV流式时每槽完整历史驻留主存。

其QSA可在选择后只加载所需页。本机27B Dense配置有64层，其中16个full_attention层、每层4 KV头、head_dim 256。全注意力访问全部历史，无法照抄QSA的索引选择而不改变模型语义。应借鉴页池、锁页内存、预取、状态一致性和缓存指标；需要另写全注意力分块计算与在线softmax归并。仅丢掉冷历史或只读最近32K不属于等价分离。

## 三条路线

| 路线 | 解决的问题 | 当前条件 |
|---|---|---|
| 空闲会话/前缀停放RAM | 多会话轮换不重复预填充 | Paiton已有实验性host-cache；保存现有KV格式与循环/草稿状态，不增加活动full-attention池的上限 |
| 活动KV分块从RAM送GPU | 活动请求超过GPU容量仍保留完整历史 | 新开发：GPU常驻一部分KV，其余按层/块双缓冲；GPU对所有块计算，在线合并softmax，测试与全驻留结果一致。瓶颈是PCIe及长上下文读取 |
| CPU算部分attention | 避免反复送整个KV，只传Q和部分输出 | 新开发：CPU/GPU各算自己的块，合并max、exp和加权输出。须有高效AVX2实现并验证GQA、RoPE、KV格式与DFlash的兼容性，不能将cpu-offload开关等同此方案 |

## 格式与容量

全注意力描述访问范围，不指定KV精度。当前目标保持Paiton现有KV4页面在RAM/GPU之间原样迁移，包括量化值、比例因子和元数据；GPU使用现有解码方式。之前BF16容量表只是另一个格式的示例，未改动实际配置，不属于用户目标，已移除。

本机KV4日志的slot_bytes为280，每个token每个KV头的K/V及其量化元数据合计280 bytes。16个全注意力层、每层4 KV头，约17,920 bytes/token。单路262,144 token约4.375 GiB；两路满256K约8.75 GiB；八路满256K约35 GiB。这里只是全注意力KV4数据，不包括循环状态、draft KV、对齐、工作区、CPU视觉、模型与系统，不能替代启动日志的总池预算。

从容量看，用约94 GiB主存保存多路256K的KV4值得试验。方案优先让尽可能多的活动KV留在GPU，只迁移超出预算的部分；RAM完整镜像是否必要由一致性方案决定，不强制每一步回传完整历史。RAM保存KV4，GPU计算时按当前内核所需解码；解码过程不要求RAM存储BF16。

长上下文全注意力仍需读取RAM中的历史。不能假设较早历史永远不被访问，也不能照搬QSA只加载少量索引页的性能。按层/块双缓冲、预取、多个query复用和NUMA本地锁页内存用于降低搬运开销；CPU部分attention是后续可选路线，不作为第一版要求。速度取决于真实PCIe带宽和缺页量，不预先承诺八路256K达到500总输出。

## 试验顺序

1. CPU视觉参考Strata独立编码器，匹配原模型与预处理，不为偶发任务默认削小图片token；精度不是此次改造目标。
2. 先验证空闲前缀RAM停放，记录复用收益与锁页/TTM预算，确认它不支持活动KV扩容。
3. 活动上下文分离作为独立运行时实验，与当前已验证Paiton模式隔离；沿用现有KV4格式迁移，以全GPU驻留为输出一致性基准，不额外增加BF16 KV分支。
4. 首先测试一条256K加短请求，再测试两条256K；逐层/按块核对输出、循环状态、DFlash接受/拒绝、缓存恢复，最后评估更多256K并发和图片位置编码；报告速度与容量，未通过前不替换当前服务。

依据：[Strata KV流式接口](https://github.com/Niko1221/Strata/blob/main/include/strata/kernels/kv_stream.hpp)、[内核实现](https://github.com/Niko1221/Strata/blob/main/src/kernels/cuda/kv_stream.cu)、[并发槽](https://github.com/Niko1221/Strata/blob/main/docs/BATCHING.md)、[详情](https://github.com/Niko1221/Strata/blob/main/docs/DETAILS.md)。本机配置：workspace/data/llm/paiton/models/qwen38-nvfp4/config.json。
