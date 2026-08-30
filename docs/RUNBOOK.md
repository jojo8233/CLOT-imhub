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

验证 Signal 入站 bridge 时，先启动服务端，再打开同窗口开发包；只需由另一个 Signal 联系人向
当前已登录账号发送一条新的纯文字消息，不要重复三平台切换或文字/图片/贴纸发送矩阵。当前 bridge 只处理 Signal
自身已持久化的入站非空文字，媒体、贴纸、回应、编辑和删除尚未接入。事件先按实际 Signal ACI
写入专用 IndexedDB，再以同一 `eventId` 严格顺序重试到服务端 ACK；pending 和 dead-letter
分别最多 1000 项，永久拒绝必须经明确的重试或清理操作处理。核验数据库时只查询新增行数和
`platform_message_id` 重复数，不要读取正文、`raw`、账号 ACI 或 profile。自动化已覆盖 outbox
对象重建后的同键重放；2026-08-30 也已用仅对 Signal 生效的隔离 503 地址完成真实未 ACK 消息
跨 Signal 进程退出/重开的续收证据。后续除非改动这条链路，不要重复该故障矩阵，也不能用启动时
pending=0 替代回归证据。

若要单独验证后台 `signal-cli` 回退，再确认 `java -version` / `signal-cli --version`，按
`.env.example` 配置 `SIGNAL_CLI_BINARY` 和 `SIGNAL_DATA_DIR` 并重启服务端。用户可见 UI 不会
再生成 CLI 二维码。

WhatsApp 首检点不需要服务端凭据：owner 创建 WhatsApp 账号后，会话区域直接加载官方
`web.whatsapp.com`，二维码在官方页面内扫描。每个账号使用独立 Electron partition。当前只
验证页面内登录、多开和文字收发；没有 im-hub 翻译、消息回传或中央归档。若页面没有出现，
先检查网络和页面错误提示，不要清理其他平台或其他账号的 partition。登录后若长时间停在
启动进度页，检查控制台是否出现 `aquire-persistent-storage-denied`；宿主只应允许精确
WhatsApp 主框架的 `persistent-storage`，不要为了绕过该错误放宽其他 guest 权限。若官方
页面已经完整但 im-hub 显示自己的“等了 20 秒”遮罩，检查 shell-only 就绪判定是否错误依赖
`webview.isLoading()`；WhatsApp 登录后该标志可能长期为 `true`，应按已附着的精确 origin
显示页面，同时继续用 `did-fail-load` 处理真实主框架错误。

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

服务端、migration、seed 和数据库测试需要先加载 `.env`；纯桌面构建、桌面开发和
`typecheck` 不需要加载服务端密钥。

---

## 4. 默认账号表

`pnpm --filter @im-hub/server seed` 建出的账号，密码统一是 **`dev-password`**：

| 邮箱 | 角色 | 可见范围 | 说明 |
|---|---|---|---|
| `owner@example.com` | owner | 全部账号（2 个） | 老板，无限制 |
| `auditor@example.com` | auditor | 全部账号（2 个），只读 | 风控/审计，`resolveScope` 里 `requiresAudit: true`，但 P0 还没有实际的审计日志落地（见第 6 节已知限制） |
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

### 5.2 翻译引擎：DeepL / OpenAI / Anthropic（三选一即可，P0 有自动降级）

三选一就够用；配多个的话系统会按 `TranslationGateway` 里的降级顺序（`deepl -> claude -> openai`，见 `packages/server/src/index.ts`）自动 failover。

- **DeepL**（有免费额度，最省事）：注册 https://www.deepl.com/pro-api ，选 Free 计划，拿到 key 填 `DEEPL_API_KEY`。免费版走 `DEEPL_ENDPOINT=https://api-free.deepl.com/v2/translate`（`.env.example` 默认已经是这个）；如果升级成付费账号，要把 endpoint 换成 `https://api.deepl.com/v2/translate`。
- **OpenAI**：https://platform.openai.com/api-keys 建一个 key，填 `OPENAI_API_KEY`。
- **Anthropic (Claude)**：https://console.anthropic.com/settings/keys 建一个 key，填 `ANTHROPIC_API_KEY`。

**填完 key 之后，`DEFAULT_TRANSLATION_PROVIDER` 必须指向你实际填了 key 的那个引擎**，否则系统会尝试调用一个没配 key 的 provider 然后翻译失败。比如你只填了 `ANTHROPIC_API_KEY`，就要把：

```
DEFAULT_TRANSLATION_PROVIDER=claude
```

`DEFAULT_TRANSLATION_PROVIDER` 只接受三个值：`deepl` / `openai` / `claude`（见 `config.ts` 的 zod schema）。

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

- [ ] 填好至少一个引擎的 key，且 `DEFAULT_TRANSLATION_PROVIDER` 指向它
- [ ] 重启 `pnpm dev:server`
- [ ] 收到一条外语消息后，观察 BullMQ worker 日志里有没有报错
- [ ] 确认 `message_translations` 表里出现了对应记录（`select * from message_translations order by created_at desc limit 5;`）
- [ ] 客户端界面上"翻译中…"变成实际译文
- [ ] 故意填一个错误的 key 测一下降级：确认失败后系统按 `deepl -> claude -> openai` 顺序换下一个引擎重试，而不是直接报错卡死

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
  同一物理窗口承载、冷启动恢复、跨平台标签切换和原生文字/图片/贴纸发送；入站纯文字 bridge
  已完成代码、自动化验证和一条真实消息的唯一落库证据；未 ACK 事件的 IndexedDB outbox、
  dead-letter 运维、故障提示和真实跨进程续收证据也已完成。WhatsApp 只接入官方 Web
  的 owner-only 隔离壳。Signal 尚无入站媒体、编辑/删除/回应或翻译，WhatsApp 尚无统一 bridge；
  两者都不能当成完整接入。Signal 正式安装包、上游更新和 WhatsApp 完整桥接仍待后续，Zoom
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
- **审计能力名不副实**：`resolveScope` 给 auditor 角色算出 `requiresAudit: true`，但 `packages/server/src/rbac/scope.ts` 里明确写了 TODO——这个字段目前没有任何调用方消费，系统并不真的在记录审计日志，只是预留了这个信号位。
