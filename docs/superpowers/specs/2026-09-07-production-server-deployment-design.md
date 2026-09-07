# im-hub 公司生产服务器部署设计

日期：2026-09-07
状态：设计已确认，待编写实施计划

## 1. 背景与目标

im-hub 已具备公司内部账号、RBAC、客户档案库、关键词告警、Telegram 服务端适配器、Signal
原生客户端桥接、WhatsApp Web 外壳和三家翻译服务商接入代码。当前缺口不是再搭一套开发环境，
而是把这些能力放到一个可持续运行、可恢复、可审计的公司生产入口中，并让 macOS/Windows
内部安装包连接同一个固定服务端。

本设计的目标是：

1. 以 `https://imhub.jojo2333.net` 作为唯一公司生产 API origin，并由同一 origin 派生 WSS；
2. 在一台现有 Vultr 服务器上用 Docker Compose 部署 Caddy、im-hub、PostgreSQL 16 和 Redis 7；
3. 不开放注册，只通过一次性安全引导创建首个 owner，再由 owner 管理员工；
4. 同时配置 DeepL、Claude、OpenAI，允许每位员工保存默认服务商并在单次翻译时临时切换；
5. 用明确的安全、备份、回滚、监控和逐步放量边界支持约 80 名员工及首期最多 50 个并发
   Telegram 服务端会话；
6. 保持 WhatsApp Web 与 Signal 原生会话在员工电脑，避免把它们错误迁移为服务端账号；
7. 全过程不把生产秘密、二维码、验证码、2FA、平台会话或客户正文放进 Git、镜像和日志。

## 2. 已确认决策

- 只服务公司内部员工，不对客户或公众开放注册。
- 使用单机 Docker Compose；首期不拆分 Telegram worker，也不采用托管数据库。
- 公网入口为 Cloudflare + Caddy；证书首次签发期间使用 DNS-only，成功后开启 Cloudflare 代理，
  SSL/TLS 模式使用 `Full (strict)`。
- 员工可从任意网络访问，不要求 VPN，也不使用 Cloudflare Access 的浏览器挑战作为 Electron
  鉴权手段。真正的业务边界仍是 im-hub 登录、JWT、RBAC 和短时 native control grant。
- 生产数据库全新建立，只执行 migration，绝不运行开发 `seed.ts`。
- DeepL 复用公司已有密钥；Claude、OpenAI 和 Telegram `API_ID/API_HASH` 使用生产专用新配置。
- 三家翻译服务商都启用；员工既能保存个人默认值，也能为单次翻译临时选择。
- 被选服务商失败时允许自动降级，并在结果旁显示实际完成翻译的服务商。
- 使用现有 Vultr Automatic Backups，并在服务器本机保存数据库日/周备份；首期不购买异地对象存储。
- Telegram 服务端账号按 10、25、50 分阶段放量；Signal 不做自动会话清理；WhatsApp 固定使用 Web 版。
- macOS 与 Windows 各自在自己的安装包中验收，不建设自动跳转或操作系统通知。

## 3. 非目标

本次明确不做：

- 把开发数据库、seed 用户或本机平台会话迁移到生产；
- 把 WhatsApp Web DOM 消息集中回传为服务端历史，或启用保留的 WhatsApp Cloud API 员工入口；
- 把 Signal 原生 profile 上传到服务器，或建设 Signal 自动清理；
- 首期承诺超过 50 个同时在线的 Telegram TDLib 会话；
- 建设多节点编排、Kubernetes、托管 PostgreSQL 或独立 Telegram 集群；
- 购买异地对象存储、代码签名证书或自动更新服务；
- 把 Cloudflare 地址、桌面固定 origin 或健康检查当作鉴权凭据；
- 在服务器上直接编辑生产源码或从未固定的分支自动拉取并运行。

## 4. 总体部署架构

生产运行面由一个专用 Compose 项目组成：

```text
员工桌面端
    │ HTTPS / WSS
    ▼
Cloudflare（代理开启后为唯一 Web 来源）
    │
    ▼
Caddy :80/:443
    │ edge 内网
    ▼
im-hub server（Fastify + BullMQ worker + Telegram TDLib）
    │ data 内网
    ├── PostgreSQL 16
    └── Redis 7
```

只有 Caddy 映射宿主机 80/443。im-hub 的 4000、PostgreSQL 的 5432、Redis 的 6379 均不映射到
公网；PostgreSQL 和 Redis 只加入 data 网络，Caddy 不加入 data 网络。应用与数据服务使用持久化
卷，Caddy 证书和 Telegram TDLib 会话也使用独立持久化卷。

Redis 显式开启 AOF 持久化，避免仅声明数据卷却没有可恢复的队列数据文件。PostgreSQL 和 Redis
健康检查分别使用不回显凭据的本地命令；应用崩溃由 restart policy 拉起，单纯 readiness 失败则先
停止接流并保留诊断现场，不能依赖 Docker 把 `unhealthy` 容器自动重启。

应用镜像从一个明确 Git commit 通过多阶段构建产生并标记 commit SHA。服务器不以 `git pull &&
pnpm dev` 方式运行生产代码。运行镜像使用与仓库约束一致的 Node.js 22，并选择能满足
`prebuilt-tdlib`、`argon2` 等原生依赖的 glibc 基础镜像，不使用未经验证的 Alpine 应用镜像。

首期 Fastify、BullMQ worker 和 Telegram TDLib 沿用当前单进程入口。容器配置健康检查、
`restart: unless-stopped` 和日志大小/数量上限。该边界适合首期，但不是无限扩容承诺；达到资源阈值后
应把 Telegram 连接和/或队列 worker 拆为独立进程或节点，而不是继续在同一进程无上限增加账号。

## 5. 域名、TLS 与网络边界

1. 上线前确认域名 A 记录直连服务器且 80/443 可达，Cloudflare 暂设 DNS-only；
2. Caddy 为精确主机名签发并自动续期公开证书，仅将该主机反向代理到应用；
3. HTTPS 和 WSS 冒烟通过后开启 Cloudflare 代理，切换并验证 `Full (strict)`；
4. Caddy 设置合理的请求体上限、安全响应头和访问日志轮转，不在日志中记录 Authorization、正文、
   query 凭据或上游敏感响应；
5. 主机防火墙仅保留 SSH、HTTP、HTTPS。Cloudflare 代理稳定后，Web 入站限制为 Cloudflare 官方
   地址范围，并以可审计的更新流程维护地址清单；
6. Caddy 只在请求确实来自可信 Cloudflare 地址时接收并规范化客户端地址头，应用只信任 Caddy，
   不能让公网请求伪造 `X-Forwarded-For` 绕过限速；
7. SSH 先创建非 root 的部署管理员、复制并验证现有公钥登录，再关闭密码登录和 root 远程登录。
   每一步都先验证新通路，避免把管理员锁在服务器外。

桌面生产包的 `IM_HUB_SERVER_URL` 固定为精确 HTTPS origin，不含路径、凭据、查询参数或 fragment。
相同值进入 GitHub Environment 的非敏感配置变量；它可从客户端二进制提取，因此绝不能携带 token。

## 6. 鉴权、首个 owner 与限速

现有 Argon2id 密码、12 小时 JWT、`session_version`、逐请求加载角色/成员关系、WebSocket 鉴权首帧
和五分钟 native control grant 继续作为业务鉴权基础。部署不能用 Caddy 或 Cloudflare 登录页替代这些
边界。

生产新增一次性 owner 引导命令：

- 仅在数据库用户数为零时运行，并在事务/锁内再次检查；
- email 作为命令参数或交互输入，临时密码只能通过无回显的交互式标准输入输入两次，不能出现在
  shell 参数、环境变量、聊天、文件或日志中；
- 创建唯一 `owner`，设置 `must_change_password=true` 和短期有效的临时密码；
- 重复执行或数据库已有任意用户时明确拒绝，不能生成第二个 owner；
- 首次登录只能进入现有初始密码修改流程，成功后提升 `session_version` 并使临时凭据失效；
- 不发送邀请邮件，后续员工由 owner 使用现有组织管理能力创建并分发临时凭据。

生产新增 Redis 支持的登录限速。至少同时覆盖规范化 email 与可信客户端 IP，响应统一，不能借差异
枚举用户；密码和明文 email 不写入限速日志。登录、初始改密、常规改密和其他高风险鉴权入口采用
各自较紧的上限，普通已鉴权 API 采用较宽上限。限速依赖故障时应明确记录非敏感告警，不能因错误的
代理信任配置把所有员工永久识别成一个来源，也不能无界放开登录攻击。

## 7. 三家翻译服务商与员工选择

### 7.1 配置和可用性

服务端继续持有 `DEEPL_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`，客户端永远得不到密钥。
启动时只注册配置完整的 provider，并提供一个已鉴权的能力接口，返回可用 provider 名称、员工默认值
和公司默认值，不返回密钥、模型请求细节或上游错误正文。生产预期三家均可用；某家缺失时 UI 将其
标记为“暂不可用”，其他服务仍可工作。

公司默认和后台无 actor 的翻译任务继续以 DeepL 为首选。固定备用优先级为：

```text
DeepL → Claude → OpenAI
```

### 7.2 个人默认与单次覆盖

新增 migration 保存每位用户的首选 provider，默认继承公司默认 DeepL；使用受约束的 provider
联合值，不能保存任意字符串。新增已鉴权的读取/修改个人翻译偏好接口，用户只能修改自己，owner
不能借此代改或取得他人的 API 配置。

员工触发的气泡翻译、批量可见消息翻译、语言检测、发送预览和受控 composer 翻译都按以下顺序
解析首选项：

1. 本次请求显式选择且当前可用的 provider；
2. 当前用户保存的默认 provider；
3. 公司默认 DeepL。

单次覆盖不写回个人默认。native control 路线必须从已验证 grant 取得真实 user id，不能信任页面或
请求体自报的 user id。没有员工 actor 的后台入站翻译继续使用公司默认，避免同一条中央消息因多人
偏好重复生成不可预测的版本。

### 7.3 降级与结果说明

TranslationGateway 先尝试解析后的首选 provider，再按公司备用优先级尝试其余已注册 provider，并
复用现有按 provider 区分的缓存键。API 返回“请求的 provider、实际 provider、是否降级”的非敏感
元数据；桌面端在发生降级时显示应用内短提示。缓存命中也必须诚实标明缓存所属 provider。

现有 `message_translations` 只允许同一消息/目标语言保存一个结果，不能承载真实的用户选择。新增
migration 将持久化唯一键扩展为“消息、目标语言、provider”，保留现有数据。后台 DeepL 译文、员工
按 Claude/OpenAI 发起的译文可并存；读取时优先选择本次/个人 provider 对应结果，实际降级到其他
provider 时按实际 provider 保存，不能用后来一次翻译静默覆盖另一家结果。

三家都失败时才显示翻译失败。服务端日志只记录 provider、错误类别、HTTP 状态和关联 id 等诊断
字段，不记录 API key、Authorization、完整上游响应或客户正文。发送给第三方翻译服务商的数据只
包含本次翻译必需的文本与语言参数，不包含平台凭据、客户档案或员工权限数据。

## 8. 数据、持久化与备份

- 生产 PostgreSQL 使用随机生成的独立密码；Redis 使用随机密码并仅限 data 网络访问；JWT 使用
  独立高强度随机密钥。三者不复用开发值。
- 首次部署对空库运行所有 migration，不运行 `seed.ts`。migration 必须保持可重复检测和向前执行，
  已提交 migration 不改写。
- PostgreSQL、Redis、TDLib、Caddy 使用独立持久化卷。容器重建不能清除数据库、队列、证书或
  Telegram 登录态。
- 每日生成一次压缩 PostgreSQL 逻辑备份，保留最近 7 份日备份和 4 份周备份；文件及目录仅 root/
  备份进程可读，备份命令和日志不暴露数据库密码或业务正文。
- 上线前执行一次“备份 → 独立临时库恢复 → migration/关键表计数校验”的恢复演练。校验只读取
  结构、计数和非敏感状态，不输出消息正文、客户身份或账号凭据。
- Vultr Automatic Backups 作为整机与 TDLib 会话兜底。由于首期没有独立对象存储，本机数据库备份
  不算异地副本；整机损坏时恢复能力取决于 Vultr 备份，这是已接受的首期风险。
- Signal 原生 profile 与 WhatsApp Web partition 保持在各员工电脑，不上传、扫描或备份到服务器。

## 9. 生产秘密和部署输入

仓库只记录变量名及说明，不记录真实值。生产秘密统一位于服务器 `/etc/im-hub/` 下的 root 受限
配置，文件权限为 `600`，不复制进 build context 或镜像层。Compose 运行时注入秘密；诊断命令只能
报告“已配置/未配置”，不能回显值、长度、前后缀或指纹。

部署程序在服务器本地生成 PostgreSQL、Redis、JWT 等随机秘密。DeepL 旧密钥、Claude/OpenAI 新
密钥、Telegram 新 `API_ID/API_HASH` 由管理员在自己的 SSH 会话中使用无回显交互式工具录入。
Codex 执行和日志不读取这些值。密钥轮换时先写新受限配置、验证新容器健康，再撤销旧密钥；不能
直接编辑正在使用的容器文件系统。

首期部署需要管理员在安全渠道自行准备：三家翻译服务商的生产凭据、Telegram 生产应用凭据、
Cloudflare DNS/SSL 设置权限，以及首个 owner email。具体值均不提交到仓库。

## 10. 健康检查、发布与回滚

应用新增最小健康接口：存活检查只说明进程存活；就绪检查验证 PostgreSQL、Redis 和必要初始化状态，
但不返回版本、连接串、账号数、队列内容或异常堆栈。Docker 记录存活/就绪状态，Caddy 配置主动
健康检查并在 readiness 失败时停止把新请求转发给应用；进程退出才由 restart policy 自动拉起。
上游翻译服务与 Telegram 单账号故障不应让整个 HTTP 服务被错误重启，其状态通过独立非敏感诊断和
应用内提示呈现。

每次发布流程为：

1. 在隔离工作树完成测试与评审，提交并固定 Git SHA；
2. 服务器构建/取得该 SHA 的不可变镜像；
3. 运行数据库备份并验证文件可读；
4. 运行 migration；
5. 启动新容器并通过本机、Caddy、Cloudflare 三层健康检查；
6. 完成 owner、权限、翻译和一个 Telegram 账号冒烟后再放量；
7. 保留上一版镜像和发布清单。

应用失败可切回上一版镜像；数据库 migration 不做盲目自动 down。若新代码已写入不可向后兼容的
数据，则停止回退并按发布前备份走显式恢复决策。发布脚本不能用 `docker compose down -v`，也不能
删除数据卷作为“重试”。

## 11. Telegram、Signal 与 WhatsApp 放量边界

当前服务器资源适合先验证而不是直接承诺全部平台账号同时在线。Telegram `credentials_ref` 会让
已有账号在服务端启动时自动重连，因此账号登记本身就是容量动作。生产采用人工运营上限：

1. 最多 10 个 Telegram 账号，连续运行至少 24 小时；
2. 最多 25 个，继续运行至少 48 小时；
3. 最多 50 个，完成 7 天观察后再评估。

任一阶段出现内存持续超过 80%、OOM、应用/TDLib 反复重启或消息明显延迟，就停止新增账号并收集
非敏感资源指标。后续方案优先拆 Telegram worker/节点，不通过关闭鉴权、日志或持久化换取容量。

Signal 员工入口继续使用各自电脑上的原生客户端桥接，会话清理由管理员人工执行。WhatsApp 只用
每账号独立 partition 的官方 Web 页面，保留 Cloud API 后端代码但关闭员工入口和生产开关。两者
不计入服务器 TDLib 并发上限。

## 12. 失败处理与可观测性

- PostgreSQL 或 Redis 未就绪：应用就绪检查失败，Caddy 不把该实例当健康服务；不得自动重建卷。
- 翻译单家失败：按已确认顺序降级并显示实际 provider；全部失败才显示可重试错误。
- 公司服务端、JWT 或 control grant 失效：Signal/WhatsApp 官方界面保持可用，但 im-hub 翻译和受控
  发送 fail-closed，只显示应用内提示。
- Telegram 单账号失败：更新该账号状态并提示有权限的员工，不拖垮其他账号或整个服务。
- Cloudflare/Caddy 失败：保留 SSH 管理通路，从源站本机检查健康；不得临时公开数据库端口排障。
- 磁盘、内存、容器重启和备份失败均进入非敏感运维日志。首期没有外部告警服务时由管理员按放量
  阶段每日检查；在扩大到更多长期在线账号前必须补外部可用性和资源告警。

## 13. 验收标准

### 13.1 自动化

实施至少覆盖：

- 生产配置拒绝开发占位秘密、非法 origin 和开启但缺配置的能力；
- owner bootstrap 只允许空库执行、密码不走 argv、创建强制改密 owner，重复执行拒绝；
- 登录/改密限速区分可信 IP 与账号且不允许伪造代理头绕过；
- provider 能力接口不泄露密钥；个人默认值只能读写自己且只接受联合值；
- 单次 provider 覆盖不改变默认值；native grant 正确绑定用户偏好；
- DeepL、Claude、OpenAI 各自成功、按顺序降级、实际 provider/降级提示和三家失败路径；
- 健康接口的存活/就绪行为及无敏感响应；
- production Compose 不发布应用、PostgreSQL 或 Redis 端口，且数据卷、健康检查和日志限制存在；
- 现有 RBAC、WebSocket 首帧鉴权、账户控制授权、客户档案库、关键词告警、三平台回归保持通过。

提交前运行 `pnpm typecheck`、相关定向测试、完整 `pnpm test` 和桌面 production build。涉及 macOS/
Windows 打包时继续执行 M6 设计要求的来源证明和产物检查。

### 13.2 生产冒烟

按顺序确认：

1. HTTPS、WSS、证书链及 Cloudflare `Full (strict)` 正常；
2. 首个 owner 临时密码登录后只能先改密，旧临时凭据和旧 session 失效；
3. owner 创建员工，owner/manager/auditor/agent 的现有 RBAC 边界不变；
4. DeepL、Claude、OpenAI 分别成功，个人默认、单次切换和故障降级提示正确；
5. 客户档案库、关键词告警与短摘录正常；
6. 一个 Telegram 账号正常连接、收发和重启重连；
7. Signal 原生客户端与 WhatsApp Web 分别在员工设备连接，服务端授权失败时只关闭 im-hub 控制；
8. macOS/Windows 内部包都连接固定生产 origin；
9. 数据库备份可恢复到临时库，容器重建不丢持久化数据；
10. 第一阶段仅放入最多 10 个 Telegram 账号并开始 24 小时观察。

任一关键项失败都停止员工放量，不以临时关闭 TLS、RBAC、限速、首次改密或日志脱敏来绕过验收。
