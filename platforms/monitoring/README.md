# 本地监控平台

页面由 [Next.js Workbench](../workbench/README.md) 提供：http://127.0.0.1:13000/ 。原 Grafana 已移除，13000 由新版工作台接管。

```bash
./lab monitor start
./lab monitor status
./lab monitor check
./lab monitor export
./lab monitor logs --tail 60
./lab monitor stop
```

| 组件 | 端口 | 内容 |
|---|---|---|
| Prometheus | 19090 | 5 秒采集；30 天或 4GiB 时序块保留上限 |
| node_exporter | 19100 | CPU、RAM、磁盘 |
| AMD 采集器 | 19101 | 只读 sysfs GPU 指标、模型健康及配置 |
| Node.js / Next.js | 13000 / 18982 / 18990 | 页面、推理 API、单卡调度 |

所有服务绑定本机回环地址。监控代码在 `platforms/monitoring/`，历史数据在 `workspace/data/monitoring/`，报告在 `workspace/reports/monitoring/`。原 Grafana 的镜像、历史数据与密码文件已于 2026-10-23 删除；监控只保留 Prometheus、node-exporter 与 GPU 采集器。

页面支持 15/30/60 分钟、悬停读数与 5 秒刷新；LLM 展示全服务输出吞吐、TTFT P95、请求和 KV，媒体展示完整请求、等待与切换、累计完成及任务耗时拆分。任务记录最多 30 条，柱图最多 8 条，列表 5 条，不保存提示词。处理与返回包含传输，不能视作纯推理时间。

输出图表支持 5 / 15 / 30 / 60 秒统计窗口，默认 30 秒。5 秒档用相邻采样计数增量 / 实际间隔，其余档用窗口平均速率，包含思考、全部并发及窗口内空闲时间。峰值卡片独立显示近一分钟中最高的 5 秒采样区间均速，不是区间内部瞬时峰值。输入显示滚动一分钟计数增量估算，不标作预填充速度。采集掉线及恢复后的不完整窗口显示断点，真实空闲显示零。TTFT P95 为近 5 分钟直方图估算；空闲或无请求样本时显示空值。`check` 仅验证接入，不测速。

Prometheus 的 4GiB 是历史块保留目标，WAL 和当前块另计。Prometheus 限制 1GiB，采集器各 128MiB。AMD 采集器不加载 ROCm，不建立 GPU 上下文。

## CPU 图像计算

CPU 视觉服务在 `18984/metrics` 暴露独立指标，每 5 秒采集。卡片显示服务状态、计算中与排队数量、按配置线程数归一的近一分钟 CPU 使用率、容器内存、编码耗时、特征缓存容量和近五分钟缓存命中率。编码均耗只统计真正的视觉计算与特征序列化，不包含缓存命中和等待计算锁；最近编码仅在本次启动已有成功编码后显示。累计编码、命中和失败次数均以本次视觉服务启动为范围，不保存图像或提示词。
