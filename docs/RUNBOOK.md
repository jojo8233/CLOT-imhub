# im-hub 运行手册

写给第一次接触这个项目的人：从零环境到能在本机看到"不同角色看到不同账号"这条核心产品承诺生效为止。

---

## 1. 前置依赖

- **Node.js 22+**（`engines` 字段要求；本机验证用的是 v22.22.0）
- **pnpm**（本机验证用的是 10.x；没有的话 `corepack enable` 或 `npm i -g pnpm`）
- **PostgreSQL 16**
- **Redis**（BullMQ 翻译队列、翻译结果缓存都依赖它）
- **signal-cli**（仅在验证现有 Signal 适配器时需要；命令位置可用
  `SIGNAL_CLI_BINARY` 配置）

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
   完成 fixture/shadow 对账。M3-5 已增加 `tdlib` / `telegram-tt` 来源观测账本、
   语义指纹和带静默窗口的对账报告；双真实账号的接收/发送最终 base upsert
   已 matched，TDLib delete 观测代码已完成并待真实删除验收。编辑/媒体/回复观测、
   历史扫描、主动修复与切换门槛仍未完成。
   这些完成前仍不能作为生产闭环。

---

## 7. 已知限制

P0 验收范围内已确认、但**属于设计内已知限制、不是 bug**的地方：

- **两条接入路线并存**：Telegram 的 TDLib 适配器与 Signal 的 signal-cli 适配器
  仍作为后台归档/回退链路；用户可见的会话界面只保留原生入口，Telegram webview
  已进入开发态。Signal 原生路线计划 M5，WhatsApp
  计划 M6，Zoom 延后到 M8。M3-3/M3-4 已接通 Telegram context/composer 与持久消息 outbox，
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
  两端均为 `mismatched=0 / unstable=0`。仍需用一条组合探针取得媒体+回复真实 shadow 证据，
  再完成历史扫描和观察周期。
  在此之前不能退出 TDLib，也不能宣称双来源安全。
- **`senderDisplayName` 恒为 `null`**：`NormalizedMessage.senderDisplayName` 这个字段在归一化层定义了，但 Telegram adapter 目前没有回填联系人的展示名，所有消息的这个字段都是 `null`。
- **翻译失败时 UI 会一直显示"翻译中…"**：如果配置的翻译引擎全部失败（比如三个 key 都没填、或者都失效了），`translate-job` 会记录失败但客户端没有对应的"翻译失败"状态展示，前端会停在乐观的"翻译中…"文案，不会主动提示用户翻译已经放弃。
- **WebSocket 断线不自动重连**：`/ws` 连接一旦断开（网络抖动、服务端重启），客户端不会自动重连，需要用户手动刷新/重启客户端才能恢复实时推送。
- **审计能力名不副实**：`resolveScope` 给 auditor 角色算出 `requiresAudit: true`，但 `packages/server/src/rbac/scope.ts` 里明确写了 TODO——这个字段目前没有任何调用方消费，系统并不真的在记录审计日志，只是预留了这个信号位。
