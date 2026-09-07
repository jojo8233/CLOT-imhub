# im-hub 运行手册

写给第一次接触这个项目的人：从零环境到能在本机看到"不同角色看到不同账号"这条核心产品承诺生效为止。

---

## 1. 前置依赖

- **Node.js 22+**（`engines` 字段要求；本机验证用的是 v22.22.0）
- **pnpm**（本机验证用的是 10.x；没有的话 `corepack enable` 或 `npm i -g pnpm`）
- **PostgreSQL 16**
- **Redis**（BullMQ 翻译队列、翻译结果缓存都依赖它）
- **Signal Desktop 8.25.0**（M5 当前用户可见入口；必须从官方 `.app` 生成独立的 im-hub
  开发包，不能原地修改日常使用的 Signal）。`signal-cli 0.14.7 + Java 25` 只在验证后台
  回退适配器时需要，不再负责桌面扫码、会话、图片或贴纸。

本机（macOS）用 **Homebrew** 把 PostgreSQL 和 Redis 起成后台服务，**不走 Docker**：

```bash
brew install postgresql@16 redis
brew services start postgresql@16
brew services start redis
```

> 仓库根目录的 `docker-compose.yml` 是给**部署/CI 场景**准备的（一键起 `postgres:16-alpine` + `redis:7-alpine`），本机开发不需要它，两条路径二选一即可。如果你更喜欢用 Docker，跳过上面的 `brew services`，改成 `docker compose up -d`，端口和账号密码与下面的 `.env` 是对齐的。

psql 如果不在 `PATH` 里（Homebrew 装的 postgresql@16 默认不 link 到全局），全路径通常是：

```
/opt/homebrew/opt/postgresql@16/bin/psql
```

---

## 2. 首次启动的完整步骤

### 2.1 建库建角色

```bash
PSQL=/opt/homebrew/opt/postgresql@16/bin/psql   # 如果 psql 已在 PATH 里，直接用 psql

$PSQL -U "$(whoami)" -d postgres -c "CREATE ROLE imhub WITH LOGIN SUPERUSER PASSWORD 'imhub_dev';"
$PSQL -U "$(whoami)" -d postgres -c "CREATE DATABASE imhub OWNER imhub;"
```

（如果这两条报"已存在"，说明库和角色已经建好了，跳过即可——本机验证时它们已经是建好的状态。）

用户名/密码/库名要和 `.env` 里的 `DATABASE_URL` 对上：`postgres://imhub:imhub_dev@localhost:5432/imhub`。

### 2.2 安装依赖

```bash
cd im-hub
pnpm install
```

### 2.3 配置环境变量

仓库根目录已经有一份 `.env`（`JWT_SECRET` 已经是随机值，不是占位符，可以直接用）。如果你是从 `.env.example` 重新生成：

```bash
cp .env.example .env
# JWT_SECRET 必须换成真随机值，config.ts 会拒绝 .env.example 里的占位值：
openssl rand -base64 32
```

**重要：这个项目没有内置 dotenv 加载器**——`config.ts` 直接读 `process.env`，不会自动读 `.env` 文件。所有涉及数据库/Redis 的命令（`migrate`、`seed`、`dev:server`、`test`）跑之前，都要先把 `.env` 的内容导入当前 shell：

```bash
set -a
source .env
set +a
```

（或者装 `direnv`/用 `dotenv-cli` 包一层，仓库目前没有内置这套，需要你自己在本机习惯里加一步。）

### 2.4 跑 migration

```bash
set -a; source .env; set +a
pnpm db:migrate
```

预期输出类似：

```
Success: 0001_init
```

（本机验证时 migration 已经跑过，`kysely_migration` 表里能看到 `0001_init` 这条记录；重复跑 migration 是安全的，kysely 的 migrator 只会执行未跑过的文件。）

### 2.5 跑 seed，灌演示数据

```bash
set -a; source .env; set +a
pnpm --filter @im-hub/server seed
```

预期输出：

```
已初始化（密码统一 dev-password）：
  owner@example.com     owner    应看到 2 个账号
  manager@example.com   manager  应看到 1 个（仅组内）
  agent@example.com     agent    应看到 1 个（仅自己的）
  outsider@example.com  agent    应看到 1 个（仅自己的）
  auditor@example.com   auditor  应看到 2 个（全局只读）
```

`seed.ts` 是保留已有主键的幂等 upsert：重复运行不会因为唯一约束报错，也不会更换
已经存在的 `accounts.id`。账号 id 与平台会话目录绑定，开发时不要用 truncate/重建
seed 代替 upsert，否则已登录会话会变成孤儿。

**注意**：数据库测试会从开发库 URL 派生 `<开发库名>_test`，并清理这个测试库。
运行前必须确认测试库存在且 URL 确实指向隔离测试库；绝不能把测试指向开发库或
生产库。正常配置下，`pnpm test` 不会清理开发库里的演示账号。

### 2.6 起服务端，验证能登录

```bash
set -a; source .env; set +a
pnpm dev:server
```

看到类似日志说明起来了：

```
Server listening at http://127.0.0.1:4000
```

另开一个终端验证登录 + 权限边界：

```bash
curl -s -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@example.com","password":"dev-password"}'
```

应该拿到一个 `{"token": "...", "user": {...}}`。

### 2.7 起桌面客户端

如果要打开 Telegram 原生界面，先在另一个终端启动补丁版网页客户端：

```bash
cd ../telegram-tt
npm run dev
```

```bash
pnpm dev:desktop
```

客户端有登录页（`components/LoginPage.tsx`），用第 4 节的任一演示账号登录即可；登录态经 Electron `safeStorage` 加密存盘，下次启动自动恢复。以 `agent@example.com` 登录看到的是 seed 建的那 1 个"TG 组内号"账号。桌面端连的服务端地址默认是 `http://localhost:4000`（见 `packages/desktop/src/preload/index.ts`，可用环境变量 `IM_HUB_SERVER_URL` 覆盖）。

若桌面外壳先于服务端启动，bootstrap 会显示“正在自动重连”，并按 1/2/4/8 秒退避（此后保持
8 秒）重新拉取会话、账号和会话列表；同一时刻只有一个重试。服务端恢复后不需要退出客户端。
登出、用户切换或页面卸载会取消旧登录态的定时器，成功后退避归零。若持续失败，再检查 4000
监听与 CORS；不要用反复重启平台客户端代替服务端诊断。

Signal Desktop 首检点先准备独立开发包：

```bash
pnpm --filter @im-hub/desktop prepare:signal -- \
  --source /Applications/Signal.app \
  --output /private/tmp/Signal-imhub.app

open -na /private/tmp/Signal-imhub.app
```

准备脚本当前只接受 Signal Desktop 8.25.0；上游版本变化导致补丁锚点不匹配时会明确失败，
必须重新审阅补丁，不能跳过版本检查。脚本生成新的 `.app`，重新打包 `app.asar`、同步
完整性 hash 并做本机开发签名，不覆盖 source。该包以 Signal Desktop 的 Electron 43
作为基座，在同一物理窗口中加载 im-hub 外壳与 Signal `WebContentsView`。Signal 验收不要
使用 `pnpm dev:desktop`；该命令仍是 Electron 33 的 Telegram/WhatsApp 普通开发壳。进入
会话后在手机 Signal 的
“设置 → 已关联设备 → 关联新设备”扫描原生窗口二维码。当前原型只允许一个 Signal Desktop
原生账号；不要读取、复制、提交或在日志中打印 profile 内容、二维码链接、
验证码与账号凭据。

以账号 owner 登录 im-hub 后，在顶栏切到 Signal，点“+”并选择“创建并打开”。该请求会把
账号登记为 `connection_mode=native_desktop`，由 Signal 基座进程托管同窗口 view；服务端不会
调用 signal-cli，也不会把原生 profile 伪装成 `credentials_ref`。后台 signal-cli 账号继续
保留 `connection_mode=adapter`，两条路线重启、重关联和删除时均按该字段隔离。

仅在续接已经关联且 profile 已由隔离开发包自身固定的本机 checkpoint 时，可把旧开发包作为
不透明 profile 配置来源；脚本不会解析或打印资料位置：

```bash
pnpm --filter @im-hub/desktop prepare:signal -- \
  --source /Applications/Signal.app \
  --output /private/tmp/Signal-imhub-next.app \
  --profile-source /private/tmp/Signal-imhub-previous.app
```

首次运行新签名测试包时，macOS 可能询问读取 `Signal Safe Storage`；仅在确认路径是本次生成的
本机测试包后授权。该模式仍只允许一个 Signal 账号，不能作为多账号发布配置。

验证 Signal 入站 bridge 时，先启动服务端，再打开同窗口开发包；文字与持久 outbox 已有真实
证据，不要重复三平台切换、原生发送矩阵或未 ACK 故障矩阵。图片/贴纸续验只需由另一个 Signal
联系人向当前已登录账号各发送一条新的图片和贴纸。当前 bridge 处理 Signal 自身已持久化的
入站文字、图片和贴纸；图片/贴纸只回传结构化元数据和稳定引用，不复制本机文件、路径、密钥或
二进制。视频、音频和文件尚未接入；含不支持附件的消息会整条拒绝并显示
非致命提示，不会落成只有 caption 的半条消息，也不会阻断下一条支持的消息。事件先按实际 Signal ACI
写入专用 IndexedDB，再以同一 `eventId` 严格顺序重试到服务端 ACK；pending 和 dead-letter
分别最多 1000 项，永久拒绝必须经明确的重试或清理操作处理。核验数据库时只查询新增行数和
`platform_message_id` 重复数，并按 `media_refs.kind` 聚合图片/贴纸数量；不要读取正文、具体
媒体引用、`raw`、账号 ACI 或 profile。自动化已覆盖 outbox
对象重建后的同键重放；2026-08-30 也已用仅对 Signal 生效的隔离 503 地址完成真实未 ACK 消息
跨 Signal 进程退出/重开的续收证据。后续除非改动这条链路，不要重复该故障矩阵，也不能用启动时
pending=0 替代回归证据。

2026-08-30 a18 已完成一次入站图片与贴纸真实续验：补发前原生 Signal 聚合为 3 行、图片 0、
贴纸 0，补发后为 5 行、图片 1、贴纸 1；超过 10 秒 ACK 窗口后计数不变，非规范键、重复键组、
不稳定媒体引用及禁止媒体字段均为 0。核验只读聚合，未读取正文、联系人、ACI、具体消息键或
媒体引用。除非修改图片/贴纸归一化、outbox 或 ACK 链路，不要重复该真实矩阵。

Signal 入站编辑、为所有人删除和普通回应已经通过真实续验；除非修改对应归一化、outbox 或 ACK
链路，不要重复。a23 已完成当前会话同步、`composer.get-draft` / `composer.set-draft` 和可见原生
草稿写入的真实续验；除非修改会话、可见编辑器或草稿持久化边界，不要重复。

a24 在上述边界上增加翻译坞纯文字自动发送。它只在可见 CompositionInput 与 ConversationModel
草稿完全相同，且没有附件、编辑、引用或 view-once 状态时开放。正文 fingerprint、首次
`contextRevision` 与 `attemptId` 在 Signal guest 的持久账本中绑定；命令超时或结果丢失时再次点击
必须沿用同一 attempt，不能重新翻译或生成新 attempt。只有 Signal 自身完成 outgoing 消息和 send
job 持久化、并确认最终平台消息 ID 后，外壳才能显示成功并 ACK 清理账本；输入框清空、submit
被调用或没有立即报错都不算成功。切会话、用户改稿和旧 revision 必须拒绝。账本不保存正文。

当前 a24 已完成唯一一条无敏感纯文字续验：接收端精确收到一条，最终 ID 主链成功，但 ACK 前的
已确认 attempt 状态回放让翻译坞误显示“操作失败”。消息没有失败或重复。a25 已把该短暂状态显式
标记，并在 ACK 后的无 attempt 状态到达时清理；相关自动化、构建和签名均通过。按单条上限不要
再发消息复验。a26 在 a25 基础上另补外壳 bootstrap 自动重连，不修改 Signal 发送协议；当前修正版
为 `/private/tmp/Signal-imhub-integrated-a26.app`。仍不得读取或打印联系人 ACI、本地
ConversationModel id、草稿正文、最终消息键、profile 或 token，也不要重做其他矩阵。

若要单独验证后台 `signal-cli` 回退，再确认 `java -version` / `signal-cli --version`，按
`.env.example` 配置 `SIGNAL_CLI_BINARY` 和 `SIGNAL_DATA_DIR` 并重启服务端。用户可见 UI 不会
再生成 CLI 二维码。

WhatsApp 员工添加入口现在只提供 Web 版，不显示、探测或进入 Cloud API 授权。有权创建账号的员工
创建后固定登记为
`connection_mode=web_shell`，会话区域加载精确 `https://web.whatsapp.com`，二维码仍在页面内
扫描，每个账号使用独立 Electron partition。页面登录后，窄 preload 从 WhatsApp 本地状态取得
当前账号标识；服务端只允许 owner 首次绑定，后续身份不一致会撤销短时 control grant。账号标识、
正文和 DOM message id 都不得写日志。DOM 控制器只在 context-isolated preload 内使用窄 bridge；
原始 bridge、JWT、grant、`ipcRenderer`、Node 和外壳 API 不暴露给 WhatsApp 页面脚本。

control grant 就绪后，preload 用多组 `role` / `data-testid` / `.message-in` / `.message-out` 锚点扫描
当前最多 300 个可见纯文字气泡，通过现有 im-hub 翻译网关按“中文译英文、其他语言译中文”插入
译文。打开会话时会处理已存在的可见消息；滚动加载、收到新消息或正文变化会由
`MutationObserver` 继续处理。单条失败显示“翻译暂不可用 · 点击重试”，不能静默丢失。正文只在
页面内存和翻译请求中存在，WhatsApp Web attempt 账本不保存正文。

固定翻译坞会把译文写进当前 WhatsApp contenteditable；写入前后都复核当前会话。发送前先在该
partition 的独立 IndexedDB 保存 `attemptId`、首次 context revision、正文 SHA-256 和会话键，再
点击页面原生发送按钮。只有观察到一条正文匹配、发送前不存在且带真实 `data-id` 的新出站 DOM
消息后才报告成功；超时、结果丢失或进程重启后的 pending attempt 都禁止自动再点一次。成功由
外壳 ACK 后删除账本记录。当前兼容层只提供可见纯文字双语和翻译坞发送，不把 DOM 消息回传为
中央归档，也不进入客户档案关联或关键词告警，不承诺媒体、回应、删除或 WhatsApp 页面选择器的
长期稳定性。历史 `connection_mode=adapter` 账号保留原值，但页面身份绑定与补丁 bridge 按
`web_shell` 同等处理；不要为了启用补丁批量改写或删除账号。

若页面没有出现，先检查网络和页面错误提示，不要清理其他平台或其他账号的 partition。登录后若长时间停在
启动进度页，检查控制台是否出现 `aquire-persistent-storage-denied`；宿主只应允许精确
WhatsApp 主框架的 `persistent-storage`，不要为了绕过该错误放宽其他 guest 权限。若官方
页面已经完整但 im-hub 显示自己的“等了 20 秒”遮罩，检查页面附着判定是否错误依赖
`webview.isLoading()`；WhatsApp 登录后该标志可能长期为 `true`，应按已附着的精确 origin
显示页面，同时由 preload 继续核对身份、会话与 composer，并用 `did-fail-load` 处理真实主框架错误。

WhatsApp Business Platform `cloud_api` 的联合类型、数据库值、migration、Meta onboarding、Webhook、
Graph client、加密 secret store 和自动化测试作为兼容后端继续保留，默认
`WHATSAPP_CLOUD_ENABLED=false`。它不属于当前员工产品：添加账号页没有 Cloud 选项，也不调用 Cloud
配置接口。已有 `cloud_api` 账号不改写、不删除，owner 仍可在管理中心转移或删除，但会话区域只显示
“旧 Cloud 账号（当前产品不支持连接）”，不会挂载 WhatsApp webview 或 Cloud 会话工作区。

不要为当前 M6 内部包配置或试开 Cloud API。未来若公司重新批准该路线，必须另开设计与真实 Meta
验收；不能把保留的代码和自动化写成已交付能力，也不能把 WhatsApp Web DOM id 当作 Cloud `wamid`。

### 2.8 WhatsApp Web 内部无签名安装包

M6 内部包固定 `appId=org.imhub.desktop`、product name `im-hub`，手动覆盖安装且没有自动更新。
macOS 产物为 DMG，Windows 产物为当前用户安装、可选择目录的 NSIS EXE；两者名称和应用内都明确
标记 `internal-unsigned`。构建期必须固定一个无凭据、无路径的公司 HTTPS origin，并由同一配置派生
WSS；内部包缺少或收到非法地址时直接失败，绝不回退 localhost。员工电脑不需要安装 Node、
PostgreSQL、Redis 或翻译服务。

只能通过 `package:internal:mac` / `package:internal:win` 生成可分发候选。脚本先为当前 `out/` 文件、
版本和固定来源生成哈希证明，`electron-builder` 的 `beforePack` 钩子再次校验；直接打包、开发构建
残留、来源不一致或文件被改动都会失败；脚本退出时删除该一次性证明，不能供后续直接打包复用。
安装包先在唯一暂存目录生成，只有精确匹配当前版本/平台/
架构的安装包、manifest 和许可证清单全部成功后才一起移入 `release/`；失败时不保留本版本的孤立
安装包。许可证清单只枚举桌面依赖，去除本机绝对路径，并必须包含 Electron、React/ReactDOM、
QR 与 Zustand，不得混入 Fastify、Kysely、BullMQ 或 Redis 客户端等服务端依赖。

保留域名只用于验证打包链路，生成物不可分发：

```bash
IM_HUB_SERVER_URL=https://imhub.example.test pnpm --filter @im-hub/desktop package:internal:mac
```

生成真实内部包时，操作员先从批准的本地部署环境加载实际 `IM_HUB_SERVER_URL`，不要 `echo`、复制到
命令历史、文档或工单；随后运行同一 `package:internal:mac` 命令。GitHub Environment
`internal-test` 必须配置名为 `IM_HUB_SERVER_URL` 的配置变量，值不进入仓库或本文档。Windows 工作流
只为同仓 PR 或合并后的手动触发构建，artifact 精确保留 7 天。每个平台产物必须同时带对应 manifest
和 `internal-unsigned-third-party-licenses.json` 许可证清单，否则不得分发。

当前 macOS 冒烟构建只证明无签名 DMG 可以生成且包内 renderer 没有服务端 localhost 回退；macOS
安装/只读检查与 Windows 安装/单条受控发送均尚未执行，不能提前记录为通过。Signal Windows 宿主
仍属于 M5，不进入本 M6 验收。

回滚时停止分发新包并覆盖安装上一内部版本，不删除 `userData`、账号 partition 或平台 profile。
卸载、换机、离职或账号转移前，先完成应用内对应清理任务，并在 WhatsApp 官方“已关联设备”中人工
解除目标设备；不能把卸载或删除本地目录记作官方解除完成。

---

## 3. 日常命令

| 做什么 | 命令 |
|---|---|
| 起服务端（watch 模式） | `pnpm dev:server` |
| 起桌面客户端 | `pnpm dev:desktop`（原生界面的前置进程见 2.7） |
| 跑全部测试 | `pnpm test`（或 `pnpm test:watch` 跑 watch 模式） |
| 跑类型检查 | `pnpm typecheck` |
| 跑 migration | `pnpm db:migrate` |
| 灌/重灌演示数据 | `pnpm --filter @im-hub/server seed` |
| 构建 macOS 内部包 | `pnpm --filter @im-hub/desktop package:internal:mac`（先安全加载实际 `IM_HUB_SERVER_URL`） |
| 构建 Windows 内部包 | GitHub `Windows internal package` 工作流（`internal-test` Environment） |

服务端、migration、seed 和数据库测试需要先加载 `.env`；纯桌面构建、桌面开发和
`typecheck` 不需要加载服务端密钥。

---

## 4. 默认账号表

`pnpm --filter @im-hub/server seed` 建出的账号，密码统一是 **`dev-password`**：

| 邮箱 | 角色 | 可见范围 | 说明 |
|---|---|---|---|
| `owner@example.com` | owner | 全部账号（2 个） | 老板，无限制 |
| `auditor@example.com` | auditor | 全部账号（2 个），只读 | 全局只读兼容角色；可检索和查看全部可见档案，档案写入固定返回 `403` |
| `manager@example.com` | manager | 仅自己**带队**（`is_lead=true`）的组内账号（1 个） | 只是组员（`is_lead=false`）不算带队，看不到组内账号——这是刻意设计，见 `rbac/scope.ts` 的注释 |
| `agent@example.com` | agent | 仅自己名下的账号（1 个） | 属于"默认组"，manager 能看到他 |
| `outsider@example.com` | agent | 仅自己名下的账号（1 个），和 agent 的不是同一个 | 不属于任何组，用来证明 agent 之间互相看不到、manager 也看不到组外人 |

组结构：`默认组` 下有 `manager@example.com`（组长）和 `agent@example.com`（组员）；`outsider@example.com` 不属于任何组。

---

## 5. 还需要用户提供的凭据

P0 代码已经全部就绪并测试通过，但**真实的 Telegram 收发消息**和**真实的机器翻译**需要外部凭据，仓库里没有、也不应该有人代填。

### 5.1 Telegram：`TELEGRAM_API_ID` / `TELEGRAM_API_HASH`

1. 用你自己的 Telegram 账号登录 https://my.telegram.org
2. 进入 "API development tools"，创建一个 application（随便填 App title / Short name，Platform 选 Desktop）
3. 拿到 `api_id`（纯数字）和 `api_hash`（32 位十六进制字符串）
4. 填到 `.env`：
   ```
   TELEGRAM_API_ID=你的api_id
   TELEGRAM_API_HASH=你的api_hash
   ```

### 5.2 翻译引擎：DeepL / OpenAI / Anthropic（至少配置一个）

三选一就能运行；多配几个可在首选引擎临时失败时自动降级。服务端会先尝试
本次请求的引擎，然后按 `deepl -> claude -> openai` 的固定后备顺序尝试其余已配置引擎。

- **DeepL**（有免费额度，最省事）：注册 https://www.deepl.com/pro-api ，选 Free 计划，拿到 key 填 `DEEPL_API_KEY`。免费版走 `DEEPL_ENDPOINT=https://api-free.deepl.com/v2/translate`（`.env.example` 默认已经是这个）；如果升级成付费账号，要把 endpoint 换成 `https://api.deepl.com/v2/translate`。
- **OpenAI**：https://platform.openai.com/api-keys 建一个 key，填 `OPENAI_API_KEY`。
- **Anthropic (Claude)**：https://console.anthropic.com/settings/keys 建一个 key，填 `ANTHROPIC_API_KEY`。

`DEFAULT_TRANSLATION_PROVIDER` 是公司默认值，只接受 `deepl` / `claude` / `openai`。建议它指向
已填 key 的引擎；比如只配了 `ANTHROPIC_API_KEY`，就设为：

```
DEFAULT_TRANSLATION_PROVIDER=claude
```

引擎选择与降级行为：

- 员工可在桌面应用的「翻译设置」中保存自己的默认引擎；设置保存在公司服务端，不会写入本机 `localStorage`。
- 回复语言旁的「本次翻译」只覆盖当前操作，不会改动个人默认。未配 key 的引擎显示为不可用。
- 翻译结果会标明实际使用的 DeepL / Claude / OpenAI。如果首选引擎失败而发生降级，应用内会显示简短降级提示，不显示上游错误原文。
- `DEEPL_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 只能存在服务端 `.env`；不得注入 renderer、Telegram/Signal/WhatsApp 客户端或 webview。

### 5.3 拿到凭据之后怎么验证真实链路

Telegram：

- [ ] 填好 `TELEGRAM_API_ID`/`TELEGRAM_API_HASH`，重启 `pnpm dev:server`
- [ ] 在客户端登录，点顶栏「+」→ 选 Telegram → 填个名称 → 「创建并扫码」
- [ ] 用手机上的 Telegram（设置 → 设备 → 关联桌面设备）扫弹出的二维码
- [ ] 开了二次验证的号会再弹一次密码输入，填完即可

> 登录不再走服务端终端。`IM_HUB_LOGIN_ACCOUNT` 这个环境变量从 P1 起已废弃——
> 适配器不再调 tdl 的 `login()`（它会从 stdin 读手机号，没有 TTY 时永久挂起），
> 改成自己驱动鉴权状态机，二维码经 WebSocket 推给发起人。
- [ ] 账号状态从 `pending_auth` 变成 `connected`（可以 `select status from accounts;` 确认）
- [ ] 若「重新关联」一直停在“正在生成二维码”，先确认服务端已包含初始 authorization
      state 补读修复，再重启服务端、刷新一次 im-hub 宿主并重新关联一次。不要通过删除账号、
      清理 TDLib 数据目录或清理 native partition 来刷新二维码。
- [ ] 找一个真实 Telegram 联系人发一条消息给这个号，确认消息出现在 `messages` 表里、且能在客户端会话列表里看到
- [ ] 在客户端里回一条消息，确认对方 Telegram 能收到

翻译：

- [ ] 填好至少一个引擎的 key，并让 `DEFAULT_TRANSLATION_PROVIDER` 优先指向已配置引擎
- [ ] 重启 `pnpm dev:server`
- [ ] 打开「翻译设置」，确认只有已配 key 的引擎可选；保存个人默认后重新登录仍能读取
- [ ] 在回复语言旁改一次「本次翻译」，确认请求使用新选择，但个人默认不变
- [ ] 收到一条外语消息后，观察 BullMQ worker 日志里有没有报错
- [ ] 确认 `message_translations` 表里出现了对应记录（`select * from message_translations order by created_at desc limit 5;`）
- [ ] 客户端界面上"翻译中…"变成实际译文
- [ ] Signal 收到英文文字时，同一原生气泡显示英文原文和中文译文；收到中文文字时显示中文原文和英文译文
- [x] Signal 当前会话中本账号发出的纯文字也显示中英双语；重开或切入会话后最近 200 条历史纯文字出站可回填
- [ ] 编辑入站文字后旧译文立即消失，只有新 revision 的译文可以重新出现；重开 Signal 后由中央快照恢复
- [ ] WhatsApp `web_shell` 登录后，当前可见的既有及新纯文字气泡按中英文方向显示译文；滚动加载后也会补译，选择器失效必须出现可见错误
- [ ] WhatsApp 翻译坞只在新出站 DOM `data-id` 确认后显示成功；制造结果未知时相同 attempt 不得重复点击发送
- [ ] WhatsApp 旧 `cloud_api` 账号只显示不可连接占位，仍可由 owner 在管理中心转移或删除；当前员工添加入口不得出现 Cloud 授权
- [ ] 用测试 key 制造首选引擎失败：确认系统改用后备引擎，界面显示实际 provider 和简短降级提示，且不显示上游错误原文

### 5.4 客户档案库（M4-1/M4-2）

右侧“客户档案”已经接通人工读取、编辑和保存。档案始终绑定 im-hub 内部
`conversations.id`，不会把 Telegram、Signal 或 WhatsApp 的平台会话标识当成内部主键，也不会
自动合并跨平台或跨账号联系人。

- owner 可读取和维护全局可见会话；manager 只能维护其当前带领团队内的会话；agent 只能维护
  本人账号下的会话；auditor 可读取全局可见档案，但界面与 API 都固定只读；
- 保存携带当前 `revision` 和本地单调请求编号，同一时刻只允许一个保存。遇到其他员工先保存时
  返回冲突，界面保留用户实际改过的字段、把未改字段合并为服务器最新值，并逐字段展示最新快照，
  避免完整表单重存时静默覆盖他人的无关修改；
- 功能中心“客户档案库”使用 `POST /api/customer-profiles/search`，关键词只放在 JSON 请求体，不进入
  URL；可搜索六个人工字段、会话显示名和账号显示名，并支持平台/账号筛选与稳定游标分页；
- 档案库查询矩阵与右栏一致：owner 全局、manager 当前带队团队、agent 本人账号、auditor 全局只读；
  筛选不可见账号只返回空页，不返回可用于枚举账号的存在性信息；
- 客户档案只支持人工维护；产品已取消自动提取、提取建议和“重新提取”入口。公司内部关键词告警
  已按 5.5 节实现；公司内部组织与管理中心已按 5.6 节实现并通过自动化验证；
- “翻译历史”页面已从功能中心删除；当前消息译文仍在会话气泡内显示，`message_translations` 仍用于
  当前译文缓存与恢复，但系统不提供翻译版本历史页；
- WhatsApp Web 的可见 DOM 正文不会因本功能上传或形成中央消息归档；本功能没有修改三平台翻译、
  composer、发送 attempt 或平台消息 ID，也不需要新的真实平台发送验收。

部署包含 M4-2 的版本前按顺序执行数据库 migration：`0013_customer_profiles.ts` 建立档案表，
`0014_customer_profile_library.ts` 删除已经取消的 `audit_logs` 及其既有记录，并增加档案库分页索引。
审计删除不可恢复；`0014` 的 down 只会重建空表结构，不能当作数据恢复。客户档案表开始承载真实资料后
同样不要通过 down migration 删除，应使用向前修复。

### 5.5 公司内部关键词告警（M4-3）

当前告警只供公司内部使用：全公司字面量规则仅由 `owner` 创建、编辑、启停和软删除。处理入口是
中央 `messages` 表中新落库的非空客户入站文字及后续有效正文编辑；不扫描部署前历史，不匹配员工
出站消息。WhatsApp Web 的可见 DOM 气泡不形成中央消息，因此不参加告警；配置并启用后的 WhatsApp
Business Platform Cloud API Webhook 入站文字走统一消息仓储，会参加告警。

接收人与确认按命中时快照生成：所有 `owner`、账号所属团队的 lead `manager`、账号 owner 为
`agent` 时的本人都需要分别确认，各人的确认互不影响；`auditor` 有全局只读告警流，但不需要确认，
桌面也不请求或显示其未确认徽标。当前通知只通过 WebSocket 驱动 Electron renderer 内的通用提示、
列表刷新和徽标，macOS 与 Windows 行为一致；没有操作系统通知、声音或点击后跳转平台会话。

当前用户告警接口共三个：

- `POST /api/keyword-alerts/search`
- `GET /api/keyword-alerts/unacknowledged-count`
- `PATCH /api/keyword-alerts/:id/acknowledge`

仅 `owner` 可使用的规则与异常扫描接口共五个：

- `GET /api/keyword-rules`
- `POST /api/keyword-rules`
- `PATCH /api/keyword-rules/:id`
- `DELETE /api/keyword-rules/:id`
- `POST /api/keyword-alert-scans/retry`

部署包含 M4-3 的版本时，在服务端启动前运行 `pnpm db:migrate`。`0015_keyword_alerts.ts` 创建
`keyword_rules`、`keyword_alert_scan_jobs`、`keyword_alerts`、`keyword_alert_recipients` 四张表；
它不会读取既有消息，也不会生成历史扫描任务。持续失败的扫描任务会在 `owner` 规则页显示数量，
由上述 retry 接口重新调度；不要通过删除任务表或 down migration 冒充成功处理。

首版没有正则、邮件、企业微信 webhook、公开订阅、agent 申请/owner 审批告警权限。迁移与自动化
验证也不能替代真实平台消息验收；真实验收必须另行授权，并遵守不记录正文、规则、业务标识或平台
会话资料的约束。

### 5.6 公司内部组织与管理中心（M4-4）

M4-4 只供公司内部使用，不提供公网注册、邀请或客户入口。只有唯一启用的 `owner` 能看见并使用
“管理中心”；`manager`、`auditor`、`agent` 的管理 API 固定返回 `403`。员工、团队和平台账号页签
支持首次强制改密、即时撤权、团队生命周期、账号归属和 owner 原子转让；所有业务读取仍沿用原有
RBAC 范围。

组织管理依赖中心服务端和 PostgreSQL。部署时必须使用以下顺序，不能直接打开写开关：

1. 在旧服务端仍运行时加载目标环境变量，执行只读体检：

   ```bash
   set -a; source .env; set +a
   pnpm --filter @im-hub/server preflight
   ```

   “组织结构”必须通过；失败输出只有问题代码与数量，由管理员先人工修正 owner、主管、成员或账号
   归属，不能让脚本自动猜测负责人。
2. 备份数据库后执行 `pnpm db:migrate`，确认 `0016_organization_admin` 已应用。不要在真实组织数据上
   运行 down migration。
3. 部署新服务端，并保持 `.env` 中 `ORGANIZATION_ADMIN_WRITES_ENABLED=false`。此时普通聊天、档案和
   告警不受影响，owner 只能核对管理中心的员工、团队、账号及清理状态列表；修改接口返回
   `ADMIN_WRITES_DISABLED`。
4. 升级 macOS 和 Windows 客户端。新版客户端必须支持 `session_revoked`、安装实例登记、挂载同步和
   按账号分区清理；仍在线且未升级的 Telegram/WhatsApp 本地账号设备会默认阻断转移，
   只有 owner 阅读影响后明确覆盖，才会改为逐项人工清理待办。离线设备不阻断服务端转移，
   但其清理待办仍保留至设备再次同步。
5. 让仍在使用的每台新版客户端至少完成一次公司登录和平台账号挂载同步。运维只核对安装实例、挂载
   与待办数量，不导出设备凭证、平台标识、session/profile 路径或聊天正文。例如可在服务器本机执行
   以下只读聚合：

   ```sql
   select count(*) as active_installations
   from desktop_installations where revoked_at is null;
   select count(*) as known_account_mounts from account_device_mounts;
   select mode, state, count(*)
   from desktop_cleanup_tasks group by mode, state order by mode, state;
   ```
6. owner 在管理中心核对员工、团队、唯一主管、账号负责人和设备清理状态；完成 macOS/Windows 人工
   验收清单后，才把 `ORGANIZATION_ADMIN_WRITES_ENABLED=true` 并重启服务端。
7. 所有员工重新登录一次。缺少 `sessionVersion` 的旧 JWT 会失效；不要通过恢复旧 token 绕过重新
   登录。

账号转移后，Telegram 与 WhatsApp Web 仅在新版客户端声明分区清理能力时自动清理已知旧挂载；离线、
退役或旧版设备保留人工待办。单账号转移、员工停用、owner 转让、团队换主管和归档都遵循相同规则：
默认阻断在线旧版客户端，只有 owner 在摘要前明确选择才改为人工待办。Signal 始终不自动删除共享 profile：公司必须在 Signal 官方“已关联
设备”中人工解除，然后由 owner 在各自管理界面按旧安装实例逐项确认，不能一次关闭同账号的全部待办。
确认只关闭所选待办，不代表 im-hub 擦除了 profile。
已完成的清理任务保留 30 天后由后续设备同步清除。

回滚时先把 `ORGANIZATION_ADMIN_WRITES_ENABLED=false` 并重启服务端；这只阻止新的组织修改，不会反转
已经提交的停用、角色、团队、账号归属或 owner 转让。已提交状态必须用新的向前管理操作修正；待清理
任务不能靠删除或强制完成冒充设备已清理。Signal 的 `manual_required` 只有在官方解除后才能确认。

本检查点只完成自动化验证，尚未在真实 macOS/Windows 发布包上执行本节人工验收，也未对开发库或
生产库运行 `0016`；启用写操作前必须补齐这些步骤。

### 5.7 生产服务器应用就绪流程

本节只覆盖应用本身的生产门禁；容器、Caddy、Cloudflare、防火墙、备份和服务器发布仍按后续
production container/runtime 计划执行。生产环境不能运行开发 `seed`，也不能用演示账号或
`dev-password` 代替首个管理员初始化。

生产配置必须从服务器上的受限环境文件加载。操作和排障时只核对以下变量名是否存在，不要用
`echo`、`env`、`printenv`、shell tracing 或错误日志输出它们的值：

- `APP_ENV`、`PUBLIC_ORIGIN`、`TRUSTED_PROXY_CIDRS`
- `DATABASE_URL`、`REDIS_URL`、`JWT_SECRET`
- `DEEPL_API_KEY`、`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`
- `TELEGRAM_API_ID`、`TELEGRAM_API_HASH`
- `DEFAULT_TRANSLATION_PROVIDER`、`ORGANIZATION_ADMIN_WRITES_ENABLED`
- `WHATSAPP_CLOUD_ENABLED`

固定策略是 `APP_ENV=production`、精确 HTTPS `PUBLIC_ORIGIN`、三家翻译 provider 都可用、Telegram
凭据成对存在、组织管理写入开启，以及内部 WhatsApp Web 版本关闭 Cloud API。应用只信任直接
Caddy 容器的精确 `/32` CIDR；不能改成 `trustProxy: true`、数字 hop count 或任意网段。桌面包的
`IM_HUB_SERVER_URL` 与 `PUBLIC_ORIGIN` 使用同一个精确 origin。

macOS/Windows 独立安装包不会用 `file://` 页面直接请求生产 API，也不要求服务端信任字面量
`Origin: null`。打包入口会在 `127.0.0.1` 随机端口启动仅提供内置静态文件的临时页面服务，按
`IM_HUB_SERVER_URL` 生成精确 `connect-src` CSP，并保持 Electron `webSecurity` 开启；窗口关闭时
同步关闭该临时服务。Signal 同窗宿主复用同一静态页面服务边界。
随机端口会让 Chromium Web Storage 的 origin 随启动变化，因此当前未持久化的面板布局可能恢复为
默认值；登录态仍只经 `safeStorage` bridge 持久化，不依赖 `localStorage`。布局跨启动持久化后续应
复用受控主进程存储 bridge，不能为保留 Web Storage 而重新允许 `Origin: null`。

首次部署按以下顺序执行：

1. 加载生产环境文件后运行 migration：

   ```bash
   set -a; source /etc/im-hub/app.env; set +a
   pnpm db:migrate
   ```

2. 运行只读生产预检：

   ```bash
   pnpm --filter @im-hub/server preflight:production
   ```

   输出只包含固定检查名及 `ok`/`missing`。任一项为 `missing` 时退出码非零；脚本不会打印连接串、
   密钥、上游响应或数据库错误正文，也不会写 schema、用户或账号数据。
3. 仅当 `users` 表为空时，在交互式 TTY 中创建首个 owner：

   ```bash
   pnpm --filter @im-hub/server bootstrap-owner
   ```

   email、显示名称和临时密码都不能作为命令行参数。密码输入两次且终端不回显；创建后 24 小时
   到期，并强制 owner 首次登录先修改密码。命令在事务与 advisory lock 内重新检查空库，并发或
   重复执行只允许一个成功。已有任何用户时必须停下核对，不能改跑 `seed`。
4. 启动 production 服务。入口会自动再次执行同一预检，未通过时在创建平台适配器前退出。
5. Caddy/容器就绪检查使用 `GET /health/live` 和 `GET /health/ready`。前者只证明进程存活；后者仅在
   PostgreSQL、Redis 和应用初始化全部完成后返回 200。响应不包含版本、账号数、连接信息或错误正文。

登录、首次改密和常规改密都受 15 分钟 Redis 限流保护；登录同时按可信客户端 IP 与
“IP + 规范化邮箱的 SHA-256”计数，IPv6 按 `/64` 聚合。限流 Redis 故障时鉴权入口返回不含内部
错误的 503，不会无界放行。不要在排障时临时放宽代理信任或绕过限流。

### 5.8 生产容器配置初始化与单项轮换

生产容器定义位于 `deploy/compose.prod.yml`。只有 Caddy 发布 80/443；应用、PostgreSQL 和 Redis
不发布宿主端口。所有服务固定为 `linux/amd64`，与已确认的 Ubuntu x86_64 生产主机一致。提交前可用
合成示例验证 Compose 网络、持久卷、Redis AOF、固定代理 CIDR 和 Caddy 语法，验证器不会把渲染后
的环境值写到标准输出：

```bash
node deploy/scripts/validate-runtime.mjs --examples
pnpm exec vitest run deploy/scripts/validate-runtime.test.ts
```

首次部署时，管理员必须在自己的交互式 SSH 终端运行：

```bash
cd /opt/im-hub/current
sudo bash deploy/scripts/init-production-config.sh
```

脚本通过无回显提示读取三家翻译服务商和 Telegram 配置，在服务器本地生成独立 PostgreSQL、Redis
和 JWT 随机值，并原子创建 `/etc/im-hub/app.env`、`postgres.env`、`redis.env`。目录权限为 700，
文件为 root 所有且权限 600。任一目标文件已存在时脚本会拒绝覆盖；不能通过删除现有配置来重复
“初始化”，应先判断是轮换还是灾难恢复。

允许单项轮换的名称只有 `DEEPL_API_KEY`、`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、
`TELEGRAM_API_ID` 和 `TELEGRAM_API_HASH`：

```bash
sudo bash deploy/scripts/rotate-production-secret.sh OPENAI_API_KEY
```

新值仍通过无回显提示读取，不进入 argv。脚本保留 mode-600 临时回滚副本，只重建 app 容器并在
60 秒内等待 `/health/ready`；失败时恢复旧配置并再次启动旧配置。命令只输出变量名和结果，不能用
shell tracing、`env`、`printenv` 或容器 inspect 输出环境值来排障。

### 5.9 PostgreSQL 日/周备份与恢复演练

`deploy/scripts/backup-postgres.sh` 只允许 root 使用固定目录 `/var/backups/im-hub`。它通过 Compose
容器本地连接执行 custom-format `pg_dump`，先写 mode-600 临时文件，再用 `pg_restore --list`
验证并原子改名。日备份精确保留 7 份；每周日同时复制一份周备份并精确保留 4 份。清理只匹配
`imhub-YYYYMMDDTHHMMSSZ.dump`，不会删除手工文件或其他目录：

```bash
cd /opt/im-hub/current
sudo bash deploy/scripts/backup-postgres.sh
```

首次启用定时器前，选择刚生成的受管备份执行一次恢复演练：

```bash
sudo bash deploy/scripts/restore-postgres-smoke.sh \
  /var/backups/im-hub/daily/imhub-YYYYMMDDTHHMMSSZ.dump
```

恢复目标固定为 `imhub_restore_smoke`，脚本拒绝其他数据库名及备份根目录以外的文件。它验证 migration、
users 和 accounts 的非敏感计数后，无论成功或失败都删除该临时库。不要打开、解压、复制或输出 dump
内容；演练通过后才能安装并启用 `deploy/systemd/im-hub-backup.service` 与 `.timer`。备份失败不能通过
删除 PostgreSQL volume 或运行 migration down 重试。

### 5.10 精确 SHA 发布与应用回滚

服务器上的每个 release checkout 必须位于 SHA 命名目录，HEAD 与准备发布的 40 位小写 Git SHA
完全一致且工作树干净。发布脚本按“构建镜像 → 启动并等待数据服务 → migration 前备份 → migration
→ app/Caddy → readiness → production preflight → 原子记录 current/previous”的顺序执行：

```bash
cd /opt/im-hub/releases/0123456789abcdef0123456789abcdef01234567
sudo bash deploy/scripts/deploy-release.sh 0123456789abcdef0123456789abcdef01234567
```

镜像固定标记为 `im-hub-server:<SHA>`，状态只写入 root 受限的 `/var/lib/im-hub/releases/current` 和
`previous`。脚本拒绝分支名、缩写 SHA、非当前 checkout、脏工作树和缺失备份程序；不得用 `latest`
代替精确 SHA。

只有明确记录在 `previous` 的镜像可以回滚：

```bash
sudo bash deploy/scripts/rollback-release.sh fedcba0987654321fedcba0987654321fedcba09
```

回滚只重建 app 容器并要求 readiness，不运行 migration down，也不删除或重建任何 volume。目标镜像
不能就绪时脚本会尝试恢复当前镜像并保持 release 状态不变。数据库 schema 不随镜像回退；如果旧代码
不能读取新 schema，应停止回滚，根据 migration 兼容性和发布前备份做显式恢复决策。

---

## 6. 上线前必做

这些是本次验收时明确留意到的、**P0 阶段刻意简化、上线前必须处理**的事项：

1. **换 `JWT_SECRET`**：`.env` 里当前的值是本机开发用的随机值，上线前要单独生成一份不进代码仓库/不共享的生产密钥（`openssl rand -base64 32`），并且和开发环境的完全不同。
2. **删除或修改默认账号密码**：`dev-password` 是所有 seed 账号共用的明文密码，
   上线前要么删掉这 5 个演示账号，要么强制它们首次登录改密码。**不要把 seed
   脚本直接跑在生产库上**——当前 seed 虽然是保留主键的 upsert，不会清空已有数据，
   但会把演示账号和已知密码写入目标库。
3. **补丁版客户端分发**：开发期 Telegram 从同级 `telegram-tt` 源码仓库启动，尚未
   纳入桌面安装包、自动更新及 GPL 源码交付流程。上线前必须完成这条供应链。
4. **完成剩余 M3 一致性门槛**：M3-1 已加入 TDLib/fork 统一 Telegram 消息键、Bridge v2
   与 `0005` 迁移；M3-2 已移除 guest JWT，加入五分钟 control grant、Telegram self id
   绑定及退出/删除分区清理；M3-3 已接通 chat/topic context、原生 Composer 和稳定发送
   attempt；M3-4 已实现 IndexedDB message outbox、ACK/退避、dead-letter、运行指标，以及按当前
   账号重试/明确清理 dead-letter 的恢复操作。刷新、进程终止、ACK 丢失、断网恢复、私密频道文本/
   编辑/删除、图片、文件和满容量恢复已有分级证据；第一次真实回复暴露并修复了页面重启后 local id
   复用造成的 temp remap 碰撞，第二次真实回复已完成冷启动平台与数据库闭环。两个真实账号的
   partition 隔离也已通过现有真实消息的确定性 base upsert 重放覆盖：服务端停机时两边同时各为
   `pending=1/dead=0`，恢复后各自收敛为 `0/0`，中央库无新增副本。语音按用户决定跳过；上线前仍要
   取得正式 7 天观察与 canary 证据。M3-5 已增加 `tdlib` / `telegram-tt` 来源观测账本、
   语义指纹和带静默窗口的对账报告；双真实账号的 base/delete/edit/media/reply、受限 coverage、
   当前快照主动读取、逐账号 shadow-only 开关和精确回滚通道均已实现并完成当前开发态证据。
   生产 7 天 active 观察与分级 canary 尚未执行；这些完成前仍不能作为生产闭环。

---

## 7. 已知限制

P0 验收范围内已确认、但**属于设计内已知限制、不是 bug**的地方：

- **多条接入路线并存**：Telegram 的 TDLib 适配器与 Signal 的 signal-cli 适配器
  仍作为后台归档/回退链路；用户可见的会话界面只保留原生入口，Telegram webview
  已进入开发态。M5/M6 现按优先级并行：Signal Desktop 8.25.0 已完成独立真实关联、
  同一物理窗口承载、冷启动恢复、跨平台标签切换和原生文字/图片/贴纸发送；入站文字 bridge
  已完成代码、自动化验证和一条真实消息的唯一落库证据；未 ACK 事件的 IndexedDB outbox、
  dead-letter 运维、故障提示和真实跨进程续收证据也已完成。WhatsApp 当前员工入口仅为
  `web_shell`，已按用户确认的
  TranGPT 式模式加入 owner-only 身份绑定、可见纯文字 DOM 双语、当前会话/草稿桥接和发送 attempt
  账本；它仍不是稳定消息协议，也没有中央 DOM 消息归档，不向客户档案或关键词告警供数。独立
  `cloud_api` 的服务端、schema 和测试仍保留但默认关闭；员工界面不提供创建/授权入口，旧 Cloud
  账号只可管理且不可进入会话。
  Signal 图片/贴纸结构化元数据的真实唯一落库已通过；附件二进制、其他
  入站媒体尚未接入；Signal 编辑/删除/回应真实续验已完成，当前会话与可见原生草稿翻译写入也已
  通过真实客户端续验。纯文字自动发送的真实单条送达与最终 ID 主链已通过；a24 的成功态 UI 竞态
  已在 a25 修复并自动化验证，但按单条上限未再次真实发送；WhatsApp Cloud API 不属于当前员工
  产品，不能因后端代码存在而写成已接入。WhatsApp Web 的内部无签名打包已实现，macOS/Windows
  人工验收仍待执行；Signal 正式安装包与 Windows 宿主继续属于 M5，Zoom
  延后到 M8。
  M3-3/M3-4 已接通 Telegram context/composer 与持久消息 outbox，
  约定范围的真实故障矩阵已完成；shadow 对账和安装包分发仍未完成，不能当成已上线能力。
- **Composer 与消息回传已完成约定范围真实验收，生产闭环仍有后续门槛**：telegram-tt 已发
  `bridge.ready/account.identity`、
  `context.changed`、`composer.state` 和 command result；TranslationDock 可驱动原生 rich editor
  与发送 attempt。telegram-tt 也会把 upsert/edit/delete/remap 先写 IndexedDB，再按 ACK
  可靠回传，并可按当前账号重试或经确认清除 dead-letter。断网、刷新、Electron 强制终止、ACK
  丢失、私密频道文本/编辑/删除、图片和文件已有证据；第一次真实回复已定位为 telegram-tt 页面
  重启后 local id 复用造成的 temp remap 碰撞，新 temp 键加入页面实例命名空间后，第二次真实回复
  已从冷启动完成 final/reply preview、唯一落库和 outbox 无积压/错误提示闭环。语音按用户决定
  跳过；服务端把中央库缺失的 delete/remap 生命周期重放作为幂等 no-op 接受，避免历史孤儿事件
  永久阻塞账号 outbox。两个真实账号已用各自真实消息完成同时积压、恢复收敛和数据库无副本增长
  的 partition 验收；完整生产闭环仍受后续 fixture/shadow 对账与安装包分发约束。
  收尾出现的裸 `SESSION_REVOKED` 已定位为非主 DC 文件 sender 超时复用主会话错误文案，且普通
  Error 没有进入只识别 `RPCError` 的清理/重试分支。telegram-tt `77788bd` 使用独立内部超时类型，
  重试耗尽后收敛为 `USER_CANCELED`，真实主连接 broken 语义保持不变；修复后只读冷启动与旧 60 秒
  窗口验证通过。旧媒体 exported sender 返回 `AUTH_KEY_UNREGISTERED` 时原先没有进入相同恢复集合，
  会被开发态全局 error handler 显示成周期弹窗；telegram-tt `cc28648` 现在会有界清理并重新借用
  sender，真正主连接的失效处理仍不变。主 DC 渐进媒体分片的 60 秒取消信号还可能经 method
  response 漏到窗口级错误处理，形成 `USER_CANCELED undefined` 弹窗；telegram-tt `aebe8e1` 在
  `requestPart` 媒体层精准收敛该取消信号，并以同一忽略集合为窗口全局处理兜底，其他错误继续
  上报。类型检查、12 文件 134 tests 和双账户跨 60 秒/约 8 分钟媒体窗口均通过。
- **双来源 base upsert 已有真实证据，完整 shadow 门槛仍未完成**：TDLib 与 telegram-tt 现在都可能
  向同一账号落消息。M3-1 已统一 `chatId:serverMessageId`、临时命名空间和 `0005` 迁移，服务端
  也按规范键幂等处理。`0007_telegram_shadow_observations` 对两条链路的 upsert/delete/remap
  保存不含正文与 raw 的语义指纹，同源重放不会制造新事实。运行下列只读报告：

  ```bash
  pnpm --filter @im-hub/server shadow-report <account-uuid> 24 120
  ```

  最后两个参数分别是观察小时数和静默秒数。`total` 包含全部账本事实，
  `comparableTotal` 排除客户端专属 temp upsert/remap；报告给出 `matched` / `mismatched` /
  `tdlibOnly` / `telegramTtOnly` / `sourceLocal`、事件类型分组和有上限的 fact key 样本，
  不输出正文或账号平台身份。最终数字消息 id 不能归为 `sourceLocal`。双真实账号上的
  接收/发送最终 base upsert 已 matched，且 outbox 无 pending/dead。TDLib `updateDeleteMessages`
  观测已接线，并忽略 `from_cache=true` 的纯缓存淘汰。真实三条 S2 delete 在发送
  分区 matched，但接收账号的 webview 在删除时尚未创建，因此三条均为 TDLib-only；事后
  打开只能加载最终状态，不伪造历史 delete。宿主现会在恢复会话后预挂载当前 owner
  的全部已支持账号，隐藏 pane 继续使用独立 partition/control grant/outbox 接收 update。
  单个 S3 shadow 专用探针已在接收 pane 保持隐藏时验证发送/接收的 base 与 delete
  全部 matched，两个 outbox 均为 `0/0`。TDLib 编辑现从 `updateMessageContent` 后的完整
  消息快照取得正文和 `edit_date`；shadow 编辑事实统一使用两 SDK 都有的 `editedAt`，
  telegram-tt 的 `pts` 只保留作消息/翻译单调排序，不进入跨来源指纹。自动回归已通过，
  单个 S4 真实探针已按“发送一次、编辑同一条一次”完成：两账号各一条中央消息，base/edit
  均 matched，正式 120 秒报告无 mismatch 或同源冲突；接收侧三个 TDLib-only delete 仍是
  S2 预挂载修复前的已解释历史缺口。用户切换两账号核对输入坞后均无 pending/dead-letter
  非零提示，两个 outbox 为 `0/0`。TDLib 归一化现也覆盖基础图片/视频/音频/语音/文件/
  贴纸及同会话回复；照片/贴纸不引入另一 SDK 缺失的大小，telegram-tt 依据远端 id 自动生成
  的展示文件名不进入指纹，真实文件名仍比较。新口径的 24 小时报告为：发送端
  `total=26 / comparableTotal=12 / matched=11 / telegramTtOnly=1 / sourceLocal=14`，唯一可比
  单边事实是 TDLib 尚为 `pending_auth` 时的 S1 历史发送；接收端
  `total=12 / comparableTotal=12 / matched=9 / tdlibOnly=3`，三项仍是 S2 预挂载前删除缺口。
  两端均为 `mismatched=0 / unstable=0`。此后 S5 组合探针继续取得媒体+回复真实 shadow 证据。
  S5 已只发送一次：回复保留的 S4，附一张图片并使用专用 caption。两账号中央库各一条
  image/caption/reply 最终行；接收端 base 两来源同 hash。发送端两来源均到达但首次 hash
  不同，字段级只读诊断唯一命中 telegram-tt 的 `sentAt` 比 TDLib 早 3 秒：前者定格开始上传
  的本地时间，后者是平台接受媒体后的服务端时间。shadow 现只对出向媒体排除该上传耗时，
  入向媒体和文本仍严格比较时间，`editedAt` 仍进入 revision/指纹。回归与全量测试已覆盖；
  跨过 120 秒后的旧算法报告中，发送端该 base 是唯一新增 mismatch，接收端该 base matched；
  无同源冲突。既有 base 不改写，作为算法发现证据保留。
  用户随后只把同一条 S5 caption 编辑一次；两账号仍各一条 image+reply 消息，旧 caption
  计数归零，新的 edited-at fact 均为两来源同 hash、无冲突。接收端 telegram-tt 在约 60 秒
  后到达，仍在 120 秒静默窗口内正常收敛。正式报告中，发送端为
  `total=30 / comparableTotal=14 / matched=12 / mismatched=1 / telegramTtOnly=1 /
  sourceLocal=16 / unstable=0`，mismatch 仅是修正前 S5 base，单边仅是 S1 历史缺口；
  接收端为 `total=14 / comparableTotal=14 / matched=11 / tdlibOnly=3 / mismatched=0 /
  unstable=0`，三个单边仍是 S2 历史 delete。用户随后逐一切换两个账户，输入坞均无
  pending/dead-letter 非零提示，对应两个 outbox `pending=0 / dead=0`。S5 的媒体+回复
  checkpoint 已关闭；之后进入受限历史扫描、主动修复边界和观察周期。
  受限历史 coverage dry-run 现使用：

  ```bash
  pnpm --filter @im-hub/server shadow-coverage \
    <account-uuid> <sent-after-iso> <sent-before-iso> [limit] [conversation-uuid|-] [cursor]
  ```

  该命令只读中央消息与 shadow 账本，不拉 Telegram 历史、不启动额外 TDLib client，也不写
  数据库。账号必填；可选会话 UUID 必须属于该账号；半开时间窗最多 31 天；单页 1～500，
  下一页使用返回的 scope-bound keyset cursor。`preObservation` 表示事件早于该账号最早
  shadow 观测，不是当前缺口；`coverageUnavailable` 表示账号没有可用基线；`sourceLocal`
  表示 temp 生命周期；只有较新的无事实项才是 `missing`。`currentSnapshotFetchable` 只是
  后续可重新读取当前平台快照的候选，不能拿中央库行伪造缺失来源；历史 delete 和已被 edit
  覆盖的 base 不可恢复。双真实账号首次全窗 dry-run 均为 `missing=0`，其余差异与正式报告
  中已解释的 S1/S2/S5 证据完全一致。

  当前快照主动读取走 owner-only API，默认仍是 dry-run；单页上限收紧为 10：

  ```text
  POST /api/accounts/<account-uuid>/telegram-shadow-refresh
  {
    "mode": "refresh_tdlib",
    "confirm": "REFRESH_TDLIB_SHADOW",
    "sentAfter": "<ISO-time>",
    "sentBefore": "<ISO-time>",
    "limit": 10,
    "conversationId": "<optional-conversation-uuid>",
    "cursor": "<optional-cursor-from-dry-run>"
  }
  ```

  执行前必须先用相同请求范围的 `mode=dry_run` 查看候选。服务端只会选
  `telegramTtOnly`/`missing` 且 `currentSnapshotFetchable` 的最终消息，复用当前已连接 TDLib
  client 精确调用 `getMessage`；不会遍历历史或启动第二 session。请求要求 owner、账号
  connected、固定确认串；manager 不能操作下属账号，auditor 不能执行。单次最多 10 条、
  单条 5 秒、同账号禁止并发。响应必须核对 before/after 和
  `requested/found/recorded/unavailable/unsupported/failed`；任何 failed 都不能进入切换证据。
  S1 的首次真实主动读取已从唯一 `telegramTtOnly` 收敛为 matched，中央 24 条消息及其
  edit/delete/media/reply 聚合未变化；S5 旧算法 mismatch 仍保留。观察周期、切换和回滚门槛
  已在下节固定；正式 7 天观察与 canary 证据仍未完成。

### Telegram TDLib 逐账号 shadow-only 灰度与回滚

默认不切换任何账号：

```text
TELEGRAM_TDLIB_SHADOW_ACCOUNT_IDS=
```

只有满足下述门槛后，才把一个内部 Telegram 账号 UUID 加入逗号分隔 allowlist 并重启服务。
不要使用平台外部 id，不要一次加入全部账号。启动日志只报告灰度账号数量，不输出 UUID。灰度
账号的 TDLib 仍保持 connected，并继续记录真实 upsert/edit/delete/remap shadow 事实；但中央
消息投影只由 telegram-tt 更新。清空或移除 UUID 并重启即恢复该账号 TDLib 后续中央入库。

进入 canary 前必须从当前版本发布时刻起连续观察 7 天，至少 2 个账号、累计至少 100 个可比
事实，并自然覆盖 base/edit/delete/media/reply。每次报告等待 120 秒静默窗口，要求：

- `matched/comparable=100%`；`mismatched/tdlibOnly/telegramTtOnly/unstable=0`；
- coverage `missing=0 / coverageUnavailable=0`，TDLib refresh candidate 与 failed 均为 0；
- telegram-tt outbox `dead=0`，没有超过 5 分钟的 pending；
- 账号 connected，webview control grant 有效。

`preObservation`、`sourceLocal` 和观察窗外已解释的历史事实不进分母。放量依次为：单账号
24 小时、最多 10% 账号 72 小时、50% 账号 72 小时、100% 账号 7 天；每级重新计时。任一已
静默单边/不一致、coverage 缺口、dead-letter、超时 pending、control grant 丢失或非 connected
立即回滚 cohort。

回滚步骤：

1. 从 `TELEGRAM_TDLIB_SHADOW_ACCOUNT_IDS` 移除受影响 UUID并重启；先恢复 TDLib 后续中央入库。
2. 固定灰度起止时间，运行正式 shadow report 和全页 coverage；不要发送新探针补历史。
3. 只对报告中最终 canonical 的 `tdlib_only` upsert id 分批调用：

   ```text
   POST /api/accounts/<account-uuid>/telegram-shadow-refresh
   {
     "mode": "rollback_tdlib",
     "confirm": "ROLLBACK_TDLIB_INGEST",
     "platformMessageIds": ["<canonical-chat-id:message-id>"],
     "sentAfter": "<canary-start-ISO>",
     "sentBefore": "<rollback-ISO>",
     "limit": 10
   }
   ```

   请求仍要求 owner、connected Telegram 账号；每批 1～10 个去重后的最终 id，只精确
   `getMessage`，不遍历历史。
4. `unavailable/unsupported/failed` 任一非零立即停止。delete 或被覆盖的历史 edit/base 不可由
   当前快照证明，不得倒填；转人工事件调查。恢复后另开新的 active 观察窗，旧事实保留。
  在此之前不能退出 TDLib，也不能宣称双来源安全。
- **`senderDisplayName` 恒为 `null`**：`NormalizedMessage.senderDisplayName` 这个字段在归一化层定义了，但 Telegram adapter 目前没有回填联系人的展示名，所有消息的这个字段都是 `null`。
- **翻译失败时 UI 会一直显示"翻译中…"**：如果配置的翻译引擎全部失败（比如三个 key 都没填、或者都失效了），`translate-job` 会记录失败但客户端没有对应的"翻译失败"状态展示，前端会停在乐观的"翻译中…"文案，不会主动提示用户翻译已经放弃。
- **WebSocket 断线不自动重连**：`/ws` 连接一旦断开（网络抖动、服务端重启），客户端不会自动重连，需要用户手动刷新/重启客户端才能恢复实时推送。
