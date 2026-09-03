# M4-2 可检索客户档案库与审计功能移除设计

日期：2026-09-03
状态：实现完成，自动化验证通过；真实桌面验收待执行

## 1. 决策摘要

M4-2 不再建设审计日志查询或 auditor 审计界面，改为完成一个受 RBAC 约束、可检索、可直接维护的
客户档案库。用户已明确确认不保留审计功能及既有审计元数据，因此本阶段通过向前 migration 删除
`audit_logs`，停止客户档案保存时的审计写入，并移除只为未来审计预留的 `requiresAudit` 信号。

`auditor` 角色本身保留，避免破坏既有身份与授权体系；它退化为历史命名的全局只读角色，不再表示
系统具备审计留痕能力。

功能中心同时删除尚未接入的“翻译历史”入口。底层 `message_translations`、会话气泡中的双语展示和
发送前回译校对全部保留；当前表只保存消息在目标语言下的当前译文，并不构成翻译版本历史。

## 2. 目标与非目标

### 2.1 目标

- 在功能中心接通“客户档案库”；
- 按当前用户实时 RBAC scope 检索跨会话客户档案；
- 支持普通文字查询、平台与账号筛选、最近更新时间排序和稳定分页；
- 点击搜索结果后查看完整六字段，并复用 M4-1 已验收的人工编辑与乐观锁流程；
- owner、范围内的 manager/agent 可编辑，auditor 全局只读；
- 删除审计表、审计写入、审计类型与 `requiresAudit` 预留；
- 删除“翻译历史”菜单项并同步当前产品文档与 RUNBOOK。

### 2.2 非目标

- 不搜索消息正文、译文、平台联系人外部 ID 或平台消息 ID；
- 不实现正则、模糊纠错、全文搜索引擎或 AI 语义搜索；
- 不实现自动客户档案提取、摘要或建议；
- 不接通功能中心的“全局搜索”；该入口涉及消息与联系人搜索，继续属于独立范围；
- 不从档案库自动打开、切换或控制 Telegram、Signal、WhatsApp 原生客户端；
- 不修改三平台翻译、草稿、发送 attempt、消息 ID 或原生渲染；
- 不移除 `auditor` 角色，不在本阶段改名或迁移既有用户角色；
- 不保留、展示或导出既有审计元数据。

## 3. 角色与权限

客户档案库对所有已登录角色开放，但每个查询都必须经过 `req.scoped`：

| 角色 | 可检索范围 | 详情 | 编辑 |
|---|---|---|---|
| `owner` | 全部账号下的档案 | 可读 | 可写 |
| `auditor` | 全部账号下的档案 | 可读 | 固定只读 |
| `manager` | 当前请求时仍由本人带领的 team | 可读 | 可写 |
| `agent` | 本人拥有账号下的档案 | 可读 | 可写 |

manager 的 `leadTeamIds` 继续每请求从数据库读取，不能缓存进 JWT。前端隐藏编辑入口只是交互优化，
现有档案 PUT 的 auditor `403` 和 scope 内 `404` 仍是服务端安全边界。

## 4. 共享契约与 API

`packages/shared` 增加客户档案库列表契约，server 与 desktop 共同使用。单条结果只包含内部导航所需
的 UUID、显示信息和既有档案字段：

```ts
interface CustomerProfileListItem {
  conversationId: string
  accountId: string
  platform: Platform
  accountDisplayName: string
  conversationDisplayName: string | null
  profile: CustomerProfile
}

interface CustomerProfileListPage {
  items: CustomerProfileListItem[]
  nextCursor: string | null
}
```

响应不得包含 `contact_external_id`、`platform_conversation_id`、平台账号外部 ID、消息正文、译文、
媒体引用或任何平台消息键。

新增只读语义的检索接口。搜索词可能包含客户资料，不能放进容易被访问日志记录的 URL query string，
因此使用 POST JSON body：

```text
POST /api/customer-profiles/search
{
  "q": "<可选普通文字>",
  "platform": "<可选平台>",
  "accountId": "<可选内部账号 UUID>",
  "limit": "<可选 1..100，默认 50>",
  "cursor": "<可选不透明游标>"
}
```

- `q` 可省略；trim 后为空等同未提供，非空最多 100 个 Unicode code point；
- `platform` 与 `accountId` 可省略；账号不在当前 scope 时返回空结果，不泄露账号是否存在；
- 参数格式或游标非法返回 `400`；没有有效登录会话返回 `401`；
- 列表接口本身没有角色级 `403`，四种角色都由相同 scoped 查询收敛；
- 详情和编辑继续复用 `GET/PUT /api/conversations/:id/customer-profile`。

## 5. 搜索语义与分页

### 5.1 可搜索字段

查询为大小写不敏感的普通文字包含匹配，覆盖：

- `customer_profiles.name`；
- `age_location`；
- `occupation`；
- `family`；
- `interests`；
- `other`；
- `conversations.contact_display_name`；
- `accounts.display_name`。

`%`、`_` 和转义字符必须先转义，再使用 `ILIKE ... ESCAPE`，不能让用户输入改变成 SQL 通配符。
本阶段不启用 `pg_trgm`、不增加数据库扩展依赖；先以 scope、可选平台/账号过滤和每页上限控制扫描
范围，后续只有在真实档案规模和查询指标证明需要时再增加专用索引。

全六字段均为空的档案不进入列表。未创建档案的可见会话也不进入列表；用户仍可在当前会话右栏首建。

### 5.2 排序与游标

列表按 `customer_profiles.updated_at DESC, conversation_id DESC` 排序。首请求固定一个 `snapshotAt`，
游标使用版本化 base64url 负载，至少包含：

- 版本；
- `snapshotAt`；
- 上页最后一项的 `updatedAt` 与 `conversationId`；
- 规范化筛选条件的 SHA-256，用于拒绝把旧游标复用到另一组条件。

所有页都限制 `updated_at <= snapshotAt`，使用 `(updated_at, conversation_id)` keyset seek 并读取
`limit + 1` 条判断 `nextCursor`。游标不是授权凭证；即使被构造，查询仍必须重新施加 `req.scoped`。

分页开始后新建或再次修改的档案通过“刷新”进入新快照。若一条尚未加载的档案在当前分页期间被修改，
它可能移出本轮快照并在刷新后出现；界面按 `conversationId` 去重，不声称提供数据库历史快照隔离。

## 6. 服务端结构

`ScopedCustomerProfileRepo` 增加 `list()`，查询必须从：

```text
accounts
  INNER JOIN conversations
  INNER JOIN customer_profiles
```

起步，再调用 `applyAccountScope`。业务路由只能调用 `req.scoped.customerProfiles().list()`，不能 import
全局 `db`。平台、账号、搜索、非空档案、snapshot 与 keyset 条件全部在这条 scoped 查询内完成。

搜索词和档案值都可能是敏感资料：请求日志、错误日志与游标不得包含原始 `q` 或字段正文。数据库错误
只向客户端返回通用中文错误；服务端结构化日志只记录错误对象和不含正文的错误代码。

## 7. 数据库与审计移除

新增向前 migration `0014_customer_profile_library`，不改写已经执行过的 `0013_customer_profiles`：

1. 删除 `audit_logs` 表及其中既有记录；该数据删除已由用户明确批准；
2. 在 `customer_profiles(updated_at, conversation_id)` 上增加用于最近更新 keyset 的索引；
3. `down()` 仅为尚未承载真实数据的开发环境恢复旧表结构与约束，无法恢复已经删除的审计记录；
4. 生产环境回退使用向前修复，不能把 `down()` 当数据恢复方案。

同时删除：

- `AuditLogsTable` 与 `Database.audit_logs`；
- 客户档案保存事务中的 `audit_logs` insert；
- `SaveCustomerProfileResult` 的 `changedFields` 返回字段；内部仍保留差异判断以识别 no-op 保存；
- `ScopeFilter.requiresAudit`、相关 TODO 和测试断言；
- 以审计行为为目标的 M4-1 测试。

客户档案保存仍在事务内锁定可见会话、检查 `expectedRevision`、写入档案及 `updated_by_user_id`；重复
保存不增加 revision，并发冲突仍返回 `409`。移除审计不能弱化这些一致性边界。

## 8. 桌面交互

`FunctionCenter` 增加 `customerProfiles` view 并接通“客户档案库”，删除“翻译历史” entry。页面采用：

- 顶部：标题、结果数提示、搜索框、平台筛选、账号筛选、刷新；
- 主体左侧：按最近更新排序的档案结果，展示姓名或会话名称、平台、账号名称和简短字段摘要；
- 主体右侧：选中项的完整六字段详情，并复用 `CustomerProfileSection` 的读取、编辑、取消、保存、冲突
  rebase 与失败重试逻辑；
- 底部或列表末尾：有下一页时显示“加载更多”。

搜索输入采用短防抖；每次关键词、平台、账号或刷新变化都 abort 旧请求并递增 request generation，迟到
响应不能覆盖新条件。新搜索不自动选中旧结果；同筛选刷新、重试和保存刷新保留当前结果与选择，替换
结果确认选中项已不属于当前结果时才清空详情。保存成功后更新当前结果快照并重新加载第一页，使最近
更新时间顺序与服务端一致。

auditor 的详情复用只读模式，不渲染“手动补充”或保存入口。档案库不会触发 native control grant、
guest context sync 或平台窗口切换。

## 9. 错误与空状态

- 首次加载：显示“正在加载客户档案库…”；
- 没有已填写档案：显示“还没有客户档案，可在会话右侧手动补充”；
- 有档案但筛选无命中：显示“没有匹配的客户档案”；
- 网络失败：显示“连不上服务端，请稍后重试”并保留筛选条件；
- 其他失败：显示“客户档案库加载失败，请稍后重试”；
- `401` 继续走现有全局登出处理；
- 加载更多失败保留已经显示的结果，并允许只重试该页。

用户可见错误、console 与 server log 都不得回显搜索词或档案正文。

## 10. 测试策略

实现遵循 TDD，先写失败测试再写最小实现。

### 10.1 数据库与仓储

- migration 后 `audit_logs` 不存在，档案分页索引存在；
- 档案保存的首建、更新、无变化、并发冲突和事务回滚继续通过；
- owner、auditor、同团队 manager、非团队 manager、本人 agent、其他 agent 的检索范围；
- 六个档案字段、会话显示名称、账号显示名称均可命中；
- 外部联系人 ID、平台会话 ID和消息正文不能命中；
- `%`、`_` 与转义字符按普通文字匹配；
- 全空档案与未创建档案不出现；
- 同时间记录按 conversation UUID 稳定排序；
- limit、snapshot、下一页、跨筛选游标和非法游标边界。

### 10.2 API

- 无 JWT 为 `401`，非法参数与游标为 `400`；
- 四种角色都只能看到 scoped 结果；
- 响应不包含任何平台外部 ID、消息正文、译文或消息键；
- auditor 可读列表和详情，但 PUT 仍为 `403`；
- 搜索错误日志不包含查询词。

### 10.3 桌面

- “客户档案库”可点击，“翻译历史”不存在；
- 搜索防抖、旧请求 abort/迟到丢弃、平台与账号筛选；
- 空库、无匹配、首次失败、加载更多失败与重试；
- 选中详情、切换结果、保存后刷新排序；
- owner/manager/agent 可编辑，auditor 无编辑入口；
- 档案库视图不调用 native control 或平台 guest。

### 10.4 完成门槛

- 客户档案库、客户档案保存与 RBAC 定向测试通过；
- `pnpm typecheck` 通过；
- `pnpm test` 全量通过，数据库测试只连接固定隔离 `_test` 库；
- `pnpm --filter @im-hub/desktop build` 通过；
- `git diff` 不包含 `.env`、平台 profile/session、构建产物或无关改动；
- 不进行 Telegram、Signal 或 WhatsApp 真实发送，不重复三平台翻译与生命周期验收。

## 11. 文档与发布

实现时同步更新：

- `docs/superpowers/specs/2026-08-26-m0-product-scope.md`；
- `docs/superpowers/specs/2026-09-02-m4-customer-profile-design.md`；
- `docs/superpowers/specs/2026-08-24-im-hub-design.md` 的当前状态说明；
- `docs/features/05-权限与团队.md`；
- `docs/features/06-需求缺口.md`；
- `docs/features/README.md`；
- `docs/RUNBOOK.md`。

历史实施计划不改写为“当时从未有过审计”，而是在当前基线与新设计中明确记录：M4-1 曾写最小审计，
2026-09-03 产品决策取消该能力并授权删除已有审计元数据。

如需真实桌面验收，从现有 a54 不透明配置生成下一测试包，不解析或输出平台 profile/session。验收只
检查档案库导航、搜索、筛选、查看、编辑和持久化；服务端新增查询协议后可以按需重启，不重测或真实
发送三平台消息。

## 12. 已确认的产品决策

2026-09-03 用户逐项确认：

1. 不保留审计功能或既有审计元数据；
2. 保留 `auditor` 作为全局只读兼容角色；
3. 采用服务端检索的独立客户档案库；
4. owner 全局可读写，manager 仅带队范围可读写，agent 仅本人范围可读写，auditor 全局只读；
5. 支持六字段、会话名称、账号名称检索及平台/账号筛选；
6. 档案库内可按权限直接编辑，不自动控制原生客户端；
7. 删除“翻译历史”入口，但保留现有翻译数据与会话内双语能力；
8. 按本设计的迁移、错误处理、自动化和桌面构建门槛执行。

## 13. 实现 checkpoint（2026-09-03）

实现提交：

- `ae6e0a5`：共享客户档案库请求、列表项、分页与限制契约；
- `03a501a`：移除审计数据库类型、写入路径、角色预留并新增 `0014` migration；
- `0044d83`：scope-first 搜索、字面量转义、字段白名单、筛选和稳定游标分页；
- `a1a2936`：严格 `POST` 搜索 API 与可取消的桌面 typed client；
- `ad7ac0e`：桌面替换/追加/迟到响应/失败/选择状态机；
- `44b28f3`：可检索主从档案库、编辑保存回调与 TSX 测试接入；
- `bf06608`：功能中心导航接线并删除“翻译历史”入口；
- `f0d209f`：补齐结果数提示和完整空库引导；
- `e1cb738`：保留 PostgreSQL 微秒级排序键，防止稳定游标分页静默漏档案；
- `46b9560`：修复搜索词改回旧值的防抖停滞，并在同筛选刷新/保存后保留有效选择；
- `73b68fe`：统一注明 M4-2 尚未进行真实桌面验收，不提前宣称闭环；
- `1df6628`：同筛选刷新失败时保留已有结果并显示非阻塞错误与重试入口。

新鲜验证证据：

- 更新后的定向回归：16 个测试文件、102 项测试通过、0 失败；
- 全量类型检查：`pnpm typecheck` 退出码 0；
- 全量回归：86 个测试文件、701 项测试通过、0 失败；
- desktop production build：main、preload、renderer 三阶段均构建成功；
- migration `0014` 的独立 schema up/down 测试通过；当前执行环境没有注入 `DATABASE_URL`，为遵守
  不读取 `.env` 和不猜测目标数据库的边界，本 checkpoint 未对开发库实际执行 `pnpm db:migrate`；
- 未生成 a55，未进行真实桌面档案库验收，也未发送或重复验收任何平台消息。

验证和文档中未记录档案值、搜索词、账号标识、消息正文/键、媒体引用、平台 profile/session、token、
二维码、验证码或密钥。真实桌面验收完成前，不把自动化结果表述为人工验收通过。

## 14. 新会话交接 checkpoint（2026-09-03）

GitHub 状态已核对：

- PR [#23](https://github.com/jojo8233/CLOT-imhub/pull/23) 已合并到 `main`，GitHub merge commit 为
  `4995b744ebe769256f61a45ed8cb371c901d7067`；
- Issue [#12](https://github.com/jojo8233/CLOT-imhub/issues/12) 仍为 Open；
- PR #19 当前在 GitHub 显示为已合并；本轮 M4-2 没有对它执行合并或关闭操作；
- 主 checkout 未修改；现有隔离 worktree `/private/tmp/im-hub-m3-outbox` 保留供新会话复核与后续工作。

M4-2 当前边界：代码、自动化、生产构建、两轮审查及 GitHub 合并已经完成；开发数据库 migration 与
真实桌面验收仍未执行。因此新会话不得把 M4-2 表述为已完成人工验收，也不需要重测或真实发送
Telegram、Signal、WhatsApp 消息。

新会话建议从以下顺序继续：

1. 先读取本设计、`docs/RUNBOOK.md`、worktree 的 `AGENTS.md` 和当前 `package.json`；
2. 核对 PR #23 / `origin/main`，并确认工作目录仍是现有隔离 worktree，不修改主 checkout；
3. 如要进行运行态验收，先明确目标开发库后执行 `0014` migration；它会删除已由产品决策取消的
   `audit_logs`，不要猜测数据库连接，也不要读取或输出 `.env`；
4. 如需新测试包，从现有 a54 不透明配置生成 a55，不解析或输出平台 profile/session；
5. 只验收档案库导航、管理员可见范围、关键词检索、平台/账号筛选、详情、编辑保存和“翻译历史”入口
   已移除，不发送平台消息；
6. 人工回报格式：`档案库：可打开；管理员可见范围：正确；关键词检索：命中；平台/账号筛选：正常；详情：正确；编辑保存：成功；翻译历史：无；错误提示：无`。

继续遵守敏感数据边界：不读取、打印或提交 `.env`、平台 profile/session、数据库档案正文、账号标识、
消息正文/键、媒体引用、token、二维码、验证码或密钥。
