# M4-1 客户档案人工维护与最小审计设计

日期：2026-09-02
状态：已实现并合并；人工维护真实验收通过

> 2026-09-03 更正：本文保留 M4-1 当时“最小审计”的历史设计与实施 checkpoint，不代表当前
> 产品仍提供审计能力。用户随后确认取消审计功能并授权删除既有审计元数据；M4-2 的向前 migration
> 删除了审计表、写入路径和角色预留，当前能力以人工维护、RBAC 检索的客户档案库为准。

## 1. 目标与背景

Telegram、Signal 与 WhatsApp 已在同一原生外壳中完成可见翻译、草稿写入和纯文字发送验收。
下一阶段进入 M4 业务层，先把右侧已经存在但仍为占位状态的“客户档案”做成可用的人工维护闭环。

本切片只解决一件完整的事：员工打开任一已同步为 im-hub 内部会话的原生会话后，可以读取、编辑并
保存该会话的客户档案；系统同时留下不含档案正文的最小审计事实。它不修改三个平台的翻译、草稿、
发送、消息 ID 或原生渲染逻辑，也不需要新增真实平台消息。

## 2. 范围

### 2.1 本次实现

- 一张与 `conversations.id` 一对一的 `customer_profiles` 表；
- 六个现有 UI 已定义的人工字段：姓名、年龄/居住地、职业/退休状况、家庭/婚姻状况、兴趣、其他；
- 带可见范围校验的档案读取和保存 API；
- 乐观并发控制，阻止两个员工用旧页面互相覆盖；
- 每次成功保存时，在同一数据库事务内写入不含字段值的最小审计记录；
- 右侧 `CustomerPanel` 的加载、查看、编辑、取消、保存、冲突与失败状态；
- RBAC、数据库、API、前端状态、类型检查、全量测试和 desktop production build 验证；
- 同步更新 `docs/RUNBOOK.md` 中客户档案的现状与限制。

### 2.2 明确不做

- 不从聊天正文自动提取档案；
- 不让模型直接覆盖人工资料；
- 不实现关键词告警、客户档案库列表、管理后台或审计日志查询页；
- 不合并跨平台联系人；同一真实客户在不同账号或平台下仍是不同内部会话档案；
- 不把 WhatsApp Web 当前可见 DOM 消息冒充中央存档；
- 不修改 Telegram、Signal 或 WhatsApp 的平台消息 ID、composer 或 send attempt；
- 不读取或输出 `.env`、平台 profile/session、账号标识、消息正文、消息键、媒体引用、token、
  二维码、验证码或密钥；
- 不重复三平台真实发送验收。

## 3. 方案选择

采用“人工档案 + 最小审计”的垂直切片。2026-09-02 产品范围进一步收敛为永久人工维护，
不再规划模型自动提取。

原因如下：

1. 右侧面板和原生当前会话同步已经存在，可以用最小新增获得端到端业务价值；
2. 人工资料是档案唯一权威来源，不分析聊天正文，避免推断结果污染员工确认过的事实；
3. 档案属于客户数据，任何可写版本都应从第一天开始留下审计事实；
4. 把关键词告警、管理后台和审计查询拆开，能保持每个 PR 的权限边界和验收范围清晰；
5. M7 安装包、更新和许可证交付仍是上线门槛，但不应在业务字段与权限语义尚未稳定时提前固化。

## 4. 领域模型

### 4.1 共享类型

`packages/shared` 新增客户档案类型，作为 server 与 desktop 的唯一字段清单：

```ts
export const CUSTOMER_PROFILE_FIELDS = [
  'name',
  'ageLocation',
  'occupation',
  'family',
  'interests',
  'other',
] as const

export type CustomerProfileField = typeof CUSTOMER_PROFILE_FIELDS[number]

export interface CustomerProfile {
  conversationId: string
  name: string | null
  ageLocation: string | null
  occupation: string | null
  family: string | null
  interests: string | null
  other: string | null
  revision: number
  updatedAt: string | null
}
```

不存在数据库行时，读取 API 返回六个字段均为 `null`、`revision=0`、`updatedAt=null` 的空档案。
这样 renderer 不需要用 `404` 区分“会话不可见”和“档案尚未填写”。

### 4.2 `customer_profiles`

新增 migration `0013_customer_profiles.ts`：

| 列 | 类型 | 约束与用途 |
|---|---|---|
| `conversation_id` | uuid | 主键，引用 `conversations.id`，会话删除时级联删除 |
| `name` | text nullable | 姓名 |
| `age_location` | text nullable | 年龄、城市、国家或时区等人工备注 |
| `occupation` | text nullable | 职业、行业或退休状态 |
| `family` | text nullable | 家庭或婚姻状况 |
| `interests` | text nullable | 兴趣与反复提到的话题 |
| `other` | text nullable | 其他人工备注 |
| `revision` | integer | 从 1 开始，每次成功保存加 1，必须为正数 |
| `updated_by_user_id` | uuid nullable | 引用 `users.id`；用户以后被删除时设为 null |
| `created_at` | timestamptz | 首次保存时间 |
| `updated_at` | timestamptz | 最近成功保存时间 |

空白字符串在服务端 trim 后规范成 `null`。姓名最多 200 个 Unicode code point，其余每字段最多
2,000 个；服务端使用共享的 code-point 计数辅助函数校验，数据库用 `char_length` check constraint
兜底，避免 JavaScript UTF-16 `string.length` 与 PostgreSQL 字符计数对 emoji 等内容得出不同结论。
数据库不保存 HTML，renderer 只按纯文字显示。

### 4.3 `audit_logs`

同一 migration 增加最小审计表，为后续 M4 审计查询复用：

| 列 | 类型 | 约束与用途 |
|---|---|---|
| `id` | uuid | 主键 |
| `actor_user_id` | uuid nullable | 实际操作者；用户以后被删除时设为 null |
| `account_id` | uuid | 用于后续按账号和 RBAC 过滤，账号删除时级联删除 |
| `conversation_id` | uuid | 本次变更目标，会话删除时级联删除 |
| `action` | text | 本切片固定为 `customer_profile.updated` |
| `changed_fields` | jsonb | 去重并按共享字段顺序排列的字段名数组 |
| `created_at` | timestamptz | 服务端写入时间 |

审计行不保存旧值、新值、请求正文、平台联系人标识或消息内容。成功请求如果没有实际字段变化，返回
当前档案且不增加 revision、不写审计行，避免把重复保存制造成虚假操作记录。

这张表在本切片只记录档案写入，不等同于完整审计能力；尤其不会顺带声称当时的 auditor
读取审计预留已经覆盖所有读取。审计日志查询和敏感读取审计曾属于后续构想，但已被
2026-09-03 的产品决策取消。

## 5. API 与权限边界

### 5.1 读取

```text
GET /api/conversations/:id/customer-profile
```

- 必须有用户 JWT；
- 只能通过 `req.scoped` 确认内部会话位于当前用户可见范围；
- owner 可读全局，auditor 可只读全局，manager 只读其当前带领团队，agent 只读本人账号；
- 会话不存在或不可见统一返回 `404`，防止枚举；
- 可见但从未填写返回空档案，而不是 `404`。

### 5.2 保存

```text
PUT /api/conversations/:id/customer-profile
```

请求体包含完整六字段和 `expectedRevision`。完整替换适合当前固定表单，也让 `changed_fields` 与并发语义
明确；不接受额外键。

- auditor 固定返回 `403`；
- 其他角色仍必须通过 `req.scoped` 的会话范围校验，不可见统一返回 `404`；
- `expectedRevision` 必须等于当前 revision；首建必须为 0；
- revision 不匹配返回 `409` 和当前 revision，不回显服务器端档案正文；renderer 随后重新读取；
- 同一事务内完成范围复核、插入/更新档案和写入审计；任何一步失败都回滚；
- 业务路由不直接 import 全局 `db`，所有读取和写入经 `ScopedDb` 的聚焦方法完成。

### 5.3 CORS 与错误

现有 CORS 已显式允许 `PUT`，新增路由不得另开宽泛 origin。用户可见错误使用中文、保持非敏感：

- `400`：档案内容或 revision 无效；
- `401`：登录失效；
- `403`：只读角色不能修改；
- `404`：会话不存在或不可见；
- `409`：档案已被其他人更新；
- `500`：保存失败，请稍后重试。

服务端日志不得打印请求体或字段值。

## 6. 桌面端交互

`CustomerPanel` 继续以 `activeConversationId` 为唯一内部会话主键。原生 guest 的
`platformConversationId` 只用于既有 context sync，不能直接拿来读写档案。

### 6.1 状态流

1. 当前内部会话为空时，显示“请先在原生客户端打开一个会话”；
2. context sync 得到 `conversationId` 后读取档案；
3. 切平台、账号或会话时取消旧读取请求，并丢弃迟到响应；prop 已切换但 reducer 尚未完成 effect
   清理的首帧必须隐藏旧 snapshot，不能把旧客户资料短暂显示在新会话下；
4. 读取成功后显示档案；未填写字段显示“尚未填写”；
5. 可写角色点击“手动补充”后进入六字段内联表单；auditor 只看到只读资料；
6. “取消”恢复最近一次服务器快照；“保存”提交完整字段和 snapshot revision；
7. 保存 attempt 同时绑定内部 conversation id 和单调 request id，并在发请求前同步占用互斥；保存中
   禁止重复提交，迟到的成功、失败或冲突结果不得改变新 attempt；成功后用响应替换 snapshot 和草稿；
8. `409` 时重新读取最新服务器 snapshot：保留用户相对旧 snapshot 实际改过的字段，把未改字段
   rebase 为服务器最新值，并逐字段展示“服务器最新”供对照；随后以新 revision 保存，不能静默
   强制覆盖其他员工对无关字段的更新；
9. 网络或服务端失败保留当前编辑草稿并允许重试，不把失败草稿写入其他会话；

### 6.2 人工资料是唯一来源

档案只写人工资料，不分析消息正文，不调用模型，也不预建 suggestion 表。界面只提供“手动补充”，
不保留禁用的“重新提取”占位入口。

### 6.3 现有互动统计

上方“互动情况”继续使用当前已加载消息快照，不与档案保存耦合。WhatsApp Web DOM 补丁路线没有中央
DOM 归档时，互动统计仍可能为空；本切片不把 DOM 正文上传来填充统计。

## 7. 代码边界

预计修改或新增：

- `packages/shared/src/customer-profile.ts` 与 `packages/shared/src/index.ts`；
- `packages/server/src/db/migrations/0013_customer_profiles.ts`；
- `packages/server/src/db/types.ts`；
- `packages/server/src/rbac/scoped-db.ts`；
- `packages/server/src/api/routes/conversations.ts` 及相邻测试；
- `packages/desktop/src/renderer/api/client.ts`；
- `packages/desktop/src/renderer/components/CustomerPanel.tsx` 及相邻测试或抽出的纯状态模块；
- `docs/RUNBOOK.md`。

不修改同级 `telegram-tt` 仓库、Signal Desktop 补丁、WhatsApp preload、翻译 coordinator、composer、
send attempt 或 native message bridge。

## 8. 测试策略

### 8.1 TDD 顺序

1. 先增加共享字段与规范化的失败测试；
2. 再增加数据库/API 失败测试，覆盖首建、更新、无变化、revision 冲突与事务回滚；
3. 增加 RBAC 矩阵：owner、auditor、同团队 manager、非团队 manager、本人 agent、其他 agent；
4. 验证不可见会话为 `404`，auditor 写为 `403`，审计行不含字段值；
5. 增加桌面纯状态或组件测试，覆盖切会话迟到响应、取消、保存、冲突重载和失败保留草稿；
6. 实现最小代码让测试通过。

修 bug 时遵守红绿循环；测试只使用合成档案文字、合成 UUID 和隔离测试库。

### 8.2 完成门槛

- 客户档案相关定向测试通过；
- `pnpm typecheck` 通过；
- `pnpm test` 全量通过，数据库测试只连接既有隔离测试库；
- `pnpm --filter @im-hub/desktop build` 通过；
- `git diff` 不包含 `.env`、平台 session/profile、构建产物或无关改动；
- 不进行新的 Telegram、Signal 或 WhatsApp 真实发送；
- 更新 RUNBOOK 和阶段 checkpoint，明确自动提取已取消，不能把告警或完整审计后台写成已完成。

## 9. 发布与回滚

- migration 只新增表，不重写历史 migration，不扫描或复制消息正文；
- 档案表随会话/账号级联删除，避免形成不可达客户数据；
- API 与 UI 可在没有任何档案行时正常工作；
- 若 UI 需要回滚，可停止调用新 API，新增表不会影响三平台原生链路；
- migration 的 `down` 先删除 `audit_logs`，再删除 `customer_profiles`，仅用于尚未承载真实档案的开发环境；
- 进入真实使用后不通过回滚 migration 删除客户档案，改用向前修复。

## 10. 后续切片

建议顺序：

1. M4-2 审计日志只读查询与 auditor 使用界面；
2. M4-3 关键词规则、命中事件与管理员通知；
3. M4-4 团队和管理后台补齐；
4. M7 安装包、上游更新、GPL/AGPL 源码交付、部署和正式发布。

## 11. 实现 checkpoint（2026-09-02）

M4-1 已按本设计完成，范围保持为内部会话上的人工档案闭环与最小审计，没有修改 Telegram、Signal
或 WhatsApp 的 guest、翻译、composer、send attempt、平台消息 ID 或原生消息渲染。

实现提交：

- `fd1d2a4`：共享客户档案契约、字段顺序、Unicode 规范化和空快照；
- `11212f6`：migration `0013_customer_profiles.ts`、scope-safe 仓储、乐观锁与原子最小审计；
- `c7161cd`：受 RBAC 约束的 GET/PUT API、严格输入校验和非敏感错误；
- `d35f15a`：桌面 typed API 与纯编辑状态机；
- `24f8fcd`：右侧内联档案面板、只读角色、冲突保稿和失败重试；
- `5541a28`：冲突字段 rebase/对照、保存请求身份和切会话首帧隔离；
- `fcba05e`：保存 attempt 同步互斥，阻止同一渲染闭包的重复请求。

2026-09-02 的新鲜验证证据：

- 客户档案定向回归：6 个测试文件、47 个测试通过、0 失败；
- 全量类型检查：`pnpm typecheck` 退出码 0；
- 全量回归：78 个测试文件、652 个测试通过、1 个既有 todo、0 失败；
- desktop production build：main、preload、renderer 三段均构建成功；
- 数据库测试只连接固定的隔离 `_test` 库；没有读取 `.env`，没有进行真实平台发送。
- 独立代码复评已核对冲突 rebase、保存 ABA、同步双击、`409` 和切会话 cleanup，结论为 Ready。

本 checkpoint 不包含档案正文或测试字段值，也不包含平台 profile/session、账号标识、消息正文、
消息键、媒体引用、token、二维码、验证码或密钥。完整审计查询、关键词告警、管理后台、安装包交付
和生产发布仍属于后续工作。

## 12. 人工档案产品收敛 checkpoint（2026-09-02）

- 客户档案永久保持人工维护；自动提取、提取建议、模型摘要和后台提取任务从产品范围删除；
- 桌面端删除未实现的“重新提取”按钮，只保留可写角色的“手动补充”以及编辑态的取消/保存；
- 既有六字段契约、乐观锁、RBAC、最小审计和内部 `conversationId` 绑定保持不变；
- 后续 M4 顺序调整为审计查询、关键词告警、团队与管理后台。

## 13. M4-2 产品更正（2026-09-03）

M4-1 上述实现记录保持为历史事实：当时确实创建并写入过不含正文的最小审计数据。随后用户明确
决定只保留方便检索的客户档案库，不保留审计功能或既有审计元数据。因此 M4-2 新增向前 migration
删除 `audit_logs`，并移除保存事务中的审计写入、数据库类型和角色预留；该删除不可恢复，回滚只会
恢复空表结构。

当前客户档案仍保留六字段、内部 `conversationId` 绑定、RBAC、乐观锁和人工维护语义；新增独立
客户档案库，以 `POST /api/customer-profiles/search` 在可见范围内搜索档案字段、会话显示名和账号
显示名。`auditor` 继续作为全局只读兼容角色，但不触发或查看审计记录。关键词告警、团队管理和
管理后台仍是独立后续切片。
