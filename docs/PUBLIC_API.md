# 统一 API 与密钥管理

只有一套推理网关、模型调度和密钥配置：

`HTTPS 客户端 → api.example.com / Caddy:443 → VPS 127.0.0.1:28984 → 反向 SSH → 本机原 API:18982`

本地原控制台：http://127.0.0.1:13000 。左侧「密钥管理」与各模型同级，适用于聊天、图片生成/编辑、视频生成及作品下载。公网服务器只负责 TLS 和转发，不运行第二套模型或管理平台。

## 分发与限额

- 在「密钥管理」创建密钥，填写接收者名称、并发上限和每分钟请求数；复制密钥或分发配置。
- 新密钥完整内容只在创建时显示一次。服务端仅存 SHA256 摘要；遗失后重新创建并停用旧密钥。
- 可修改名称和限额、停用、启用或删除，保存后立即用于后续请求。已有请求继续完成。
- 每个密钥分别限额，同时受全局总并发和总请求频率限制。**执行并发只计正在占用 GPU 租约的生成请求**：排队、等待其他引擎和上传下载都不占名额；连接断开但后端任务仍在执行时继续占用。并发用满时进入有界等待队列，队列满或请求频率超限时返回 HTTP 429。
- 限额分别返回 `API_KEY_CONCURRENCY_LIMIT_EXCEEDED`、`GLOBAL_CONCURRENCY_LIMIT_EXCEEDED`、`API_KEY_REQUEST_RATE_LIMIT_EXCEEDED`、`GLOBAL_REQUEST_RATE_LIMIT_EXCEEDED`，位于 `error.code`；`details` 给出当前用量和上限。HTTP 429 和 `type: rate_limit_error` 保留通用分类，具体排查和重试依据见 [错误代码](CURRENT_API.md#入口限流与调度错误代码)。拒绝请求与连接断开均写入网关结构化日志。
- 密钥并发是公平额度，模型实际能同时处理多少由引擎容量决定（LLM 按面板并发、TTS 3 路、图像与视频 1 路），两者取较小值。
- 每把密钥最多「并发 + 等待名额」个请求在系统内（默认等待 8 个），全局同理（默认等待 32 个），单次最多等待 900 秒。将等待名额设为 0 可恢复立即拒绝行为。本地 `Bearer local` 跳过密钥限额，但仍受引擎容量和单卡调度限制。
- 控制台分别显示执行中和等待中的请求数，可配置每把密钥的执行并发与等待名额，以及全局总等待名额和最长等待秒数。请求数/RPM 在进入时计数；模型目录查询、上传和下载只计 RPM。统计与等待队列在网关重启后清零，密钥与限额持久保存。
- 密钥共享已有作品下载权限；不提供用户作品隔离或计费。

客户端 Base URL：`https://api.example.com/v1`，请求头 `Authorization: Bearer <分发密钥>`。接口和参数沿用原本地 API。MP4 下载也必须携带密钥，相对作品地址以公网域名为基准。

原本地可信集成（无 Authorization 或 `Bearer local`）保持原有访问方式；本地显式传入分发密钥时执行同一套限额。公网由 Caddy 强制覆盖 `X-Workbench-Public: 1`，必须使用有效分发密钥，不能使用 `Bearer local`。此标记依赖受控反向代理，本机 API 只监听 loopback，禁止直接改成公网监听。

## 唯一配置与服务

- 权威密钥库：`workspace/data/scheduler/access-keys.json`，权限 600。通过控制台编辑。
- 旧 `workspace/data/public-api/api.keys` 仅在权威库不存在的首次启动导入。保留原密钥兼容；修改旧文件不会改变正在运行的配置，删除/停用的密钥不会重启复活。
- 原统一服务：`ai-workbench-gateway.service`，UI 13000 / API 18982 / 控制端口 18990。
- 唯一公网附加服务：`ai-workbench-public-tunnel.service`，环境文件 `~/.config/ai-workbench/public-tunnel.env`。模板为 `platforms/public-api/tunnel.env.example`。
- 当前生产构建为 `.next-h3-reference`，通过网关用户服务 drop-in `h3-reference.conf` 设置 `WORKBENCH_NEXT_DIST`（覆盖已有 `access-keys.conf` 的旧构建目录）；构建命令在 `platforms/workbench` 执行 `WORKBENCH_NEXT_DIST=.next-h3-reference npm run build`。
- 独立公网 guard 服务、18985 端口和其启动代码已移除。

管理接口 `/api/access-keys` 仅存在于本机 UI 端口，校验本机 Host 与同源请求；不通过公网开放。控制台没有公网登录入口。

## 公网服务器和隧道

服务器 `YOUR_SERVER_IP`，Debian；域名 `api.example.com`。服务器 `/opt/ai-public-api/compose.yaml` 和 `Caddyfile`，Caddy 使用 host 网络、内存上限 256 MiB，自动管理 Let's Encrypt 证书。Compose 的 `GODEBUG=http2client=0` 解决此服务器 ACME 出站 HTTP/2 超时。

Caddy 配置源为 `platforms/public-api/Caddyfile.example`（复制为 `Caddyfile.<域名>` 并替换域名，该文件不入库）。控制台显示的接入地址在构建时由 `NEXT_PUBLIC_WORKBENCH_PUBLIC_API` 指定，例如 `https://api.example.com/v1`。仅转发模型目录、聊天、图片、视频接口及合法 MP4 下载，其余路径 404。上传最大 32 MiB，长请求上游等待 1900 秒，流式响应即时转发。客户端超时应覆盖排队和生成时间，生成请求不要自动重试。

本机隧道使用专用 `api-tunnel` 用户、`workspace/data/public-api/runtime_ed25519` 和已核验的 `known_hosts`。服务器只允许远程转发监听 `127.0.0.1:28984`，禁止密码和 shell 会话。SSH 管理身份为同目录 `tunnel_ed25519`。私钥不得提交到仓库。

安全组开放 80/443 与现有管理 SSH 端口；28984 不开放公网。本机没有公网 IP，通过主动 SSH 连接维持隧道，systemd 断线自动重连；正在执行的 HTTP 请求不能跨断线恢复。

服务器 sshd 通过 `/etc/ssh/sshd_config.d/10-client-alive.conf` 设置 `ClientAliveInterval 30` 与 `ClientAliveCountMax 3`。客户端进程消失或链路被静默丢弃时，服务端约 90 秒后回收该会话并释放 `127.0.0.1:28984`；否则残留会话会一直占住转发端口，本机单元虽反复重启也无法重新绑定，公网接口持续不可用（2026-10-15 曾连续失败 83 次）。不要删除该文件；修改后先 `sshd -t` 校验再 `systemctl reload ssh`。

排查隧道时按顺序确认：本机 `systemctl --user status ai-workbench-public-tunnel.service`、`journalctl --user -u ai-workbench-public-tunnel.service -n 30`，服务器 `ss -ltnp | grep 28984` 与 `ps -eo pid,user,args | grep api-tunnel`。若 28984 被无对应客户端的 `sshd-session: api-tunnel` 占用，结束该残留会话即可，本机单元会在下一次重试时恢复。

安装或更新隧道单元：

```bash
cp platforms/services/ai-workbench-public-tunnel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ai-workbench-public-tunnel.service
```

停止公网只需 `systemctl --user disable --now ai-workbench-public-tunnel.service`，本地原 API 照常使用。

## 验证

在 `platforms/workbench` 执行 `node --test tests/*.test.mjs`。密钥测试覆盖持久化、一次性迁移、独立/全局限额、撤销、断开占用与管理接口来源校验。

公网：无密钥/错误密钥/`Bearer local` 返回 401；正确密钥模型目录 200；管理与状态路径 404。控制台的创建、停用、删除应即时影响本地和公网同一密钥。

## 多人共用与所有引擎的有界排队

`share` 执行并发 1、等待名额 8 时，两个人同时提交请求会一个执行、其余等待。所有生成请求（聊天、Qwen-Image、FLUX、H3、语音）进入同一个 GPU 队列，只排一次：LLM 不超过所选并发及 KV 容量，TTS 最多 3 路，图像/视频独占，切换模型先等待原任务结束。

队列按引擎合批：优先复用当前引擎；达到批次/时间/老化阈值后让其他引擎执行。同一引擎内，持有租约最少的密钥先拿到下一个空位，一个密钥批量提交不会挤掉其他密钥；满额密钥不会堵住其他有空余名额的密钥。一个共享密钥无法识别两个人的身份，因此不保证两人各占一半；需要独立额度或撤销权限时，应分别分发密钥。默认小批次 2、批次上限 4、时间预算 120 秒、等待老化 300 秒，正在执行的任务不抢占；具体规则见 [统一引擎调度](MODEL_SCHEDULING.md#统一引擎调度策略)。合批减少交替积压造成的冷切换，不能消除冷启动。

等待期间断开会立即移除请求；模型正在为它加载时先完成加载，不执行无接收者的新生成。生成已开始则继续保留 GPU 租约和密钥名额直到后端完成。停用/删除密钥会立即拒绝该密钥的等待请求；提高并发后立即放行，降低限额不终止已在执行的任务。

队列满分别返回 `API_KEY_QUEUE_FULL` 或 `GLOBAL_QUEUE_FULL`（429）；等待超过 `queueWaitSeconds` 返回 `ADMISSION_QUEUE_WAIT_TIMEOUT`（503，未提交引擎；持久媒体任务最多等待 1800 秒）。队列有界，不能消除持续超过算力的负载；客户端超时需覆盖排队、模型切换和生成，尤其视频可能较长。仍不要对生成请求自动重试，以免重复排队；客户端断开并不表示已开始的后端任务被取消。

生成请求为识别引擎会先读取 JSON；单请求最多 32 MiB，活动和排队生成正文合计预留最多 64 MiB，未知长度按 32 MiB 预留。超过预算返回 `ADMISSION_BODY_BUDGET_EXCEEDED`（429）；等待名额充足时，大参考图也可能触发此预算。
