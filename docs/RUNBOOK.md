# im-hub 运行手册

写给第一次接触这个项目的人：从零环境到能在本机看到"不同角色看到不同账号"这条核心产品承诺生效为止。

---

## 1. 前置依赖

- **Node.js 22+**（`engines` 字段要求；本机验证用的是 v22.22.0）
- **pnpm**（本机验证用的是 10.x；没有的话 `corepack enable` 或 `npm i -g pnpm`）
- **PostgreSQL 16**
- **Redis**（BullMQ 翻译队列、翻译结果缓存都依赖它）

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

`seed.ts` 是幂等的：会先清空 `users`/`teams`/`team_members`/`accounts`/`conversations`/`messages`/`message_translations` 这几张表再重建，重复跑不会因为唯一约束报错，也不会被残留的测试数据影响。

**注意**：`pnpm test` 会往真实数据库里写测试数据并做 truncate（`server.test.ts`、`repo.test.ts` 都连真库），跑完一轮测试后种子数据会被清空，只剩测试用的 `repo-test@example.com`。**如果你跑过测试之后想继续用演示账号，重新跑一次 `pnpm --filter @im-hub/server seed` 就行**——这是预期行为，不是 bug。

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

```bash
pnpm dev:desktop
```

客户端有登录页（`components/LoginPage.tsx`），用第 4 节的任一演示账号登录即可；登录态经 Electron `safeStorage` 加密存盘，下次启动自动恢复。以 `agent@example.com` 登录看到的是 seed 建的那 1 个"TG 组内号"账号。桌面端连的服务端地址默认是 `http://localhost:4000`（见 `packages/desktop/src/preload/index.ts`，可用环境变量 `IM_HUB_SERVER_URL` 覆盖）。

---

## 3. 日常命令

| 做什么 | 命令 |
|---|---|
| 起服务端（watch 模式） | `pnpm dev:server` |
| 起桌面客户端 | `pnpm dev:desktop` |
| 跑全部测试 | `pnpm test`（或 `pnpm test:watch` 跑 watch 模式） |
| 跑类型检查 | `pnpm typecheck` |
| 跑 migration | `pnpm db:migrate` |
| 灌/重灌演示数据 | `pnpm --filter @im-hub/server seed` |

以上除 `typecheck` 外都要连数据库或 Redis，运行前记得 `set -a; source .env; set +a`。

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
2. **删除或修改默认账号密码**：`dev-password` 是所有 seed 账号共用的明文密码，上线前要么删掉这 5 个演示账号，要么强制它们首次登录改密码。**不要把 seed 脚本直接跑在生产库上**——它会先清空 `users`/`teams`/`accounts` 等表，对生产数据是破坏性操作。
3. **客户端硬编码登录换成真登录页**：`packages/desktop/src/renderer/App.tsx` 里 `api.login('agent@example.com', 'dev-password')` 是 P0 阶段为了跳过登录 UI 打的桩，上线前必须换成真正的登录表单（邮箱+密码输入，走同一个 `/api/auth/login` 接口）。

---

## 7. 已知限制

P0 验收范围内已确认、但**属于设计内已知限制、不是 bug**的地方：

- **平台覆盖**：P0 只接了 **Telegram** 一个平台。Signal / Zoom / WhatsApp 排在 P1–P3，`packages/shared/src/platform.ts` 里 `PLATFORMS` 常量已经预留了这几个值，但目前没有对应的 adapter 实现。
- **`senderDisplayName` 恒为 `null`**：`NormalizedMessage.senderDisplayName` 这个字段在归一化层定义了，但 Telegram adapter 目前没有回填联系人的展示名，所有消息的这个字段都是 `null`。
- **翻译失败时 UI 会一直显示"翻译中…"**：如果配置的翻译引擎全部失败（比如三个 key 都没填、或者都失效了），`translate-job` 会记录失败但客户端没有对应的"翻译失败"状态展示，前端会停在乐观的"翻译中…"文案，不会主动提示用户翻译已经放弃。
- **WebSocket 断线不自动重连**：`/ws` 连接一旦断开（网络抖动、服务端重启），客户端不会自动重连，需要用户手动刷新/重启客户端才能恢复实时推送。
- **审计能力名不副实**：`resolveScope` 给 auditor 角色算出 `requiresAudit: true`，但 `packages/server/src/rbac/scope.ts` 里明确写了 TODO——这个字段目前没有任何调用方消费，系统并不真的在记录审计日志，只是预留了这个信号位。
