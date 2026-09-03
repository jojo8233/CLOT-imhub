# M4-3 公司内部关键词告警设计

日期：2026-09-03
状态：设计已确认，实施计划已编写，待实现

## 1. 决策摘要

M4-3 建设只在公司内部使用的关键词告警闭环。系统对进入中央 `messages` 表的新客户入站文字及后续
正文编辑做字面量匹配，可靠地产生告警，通过桌面应用内 WebSocket 提示、告警列表和个人确认状态完成
闭环。不提供公开接口、外部 webhook、邮件、企业微信、操作系统通知或声音。

本阶段只支持全公司字面量规则。规则由 `owner` 独占维护；`manager`、`auditor` 和 `agent` 不查看或
修改规则。`owner`、`manager` 和 `agent` 分别确认自己的告警，互不清除其他人的状态；`auditor` 可查看
全公司告警，但不生成个人确认任务，也不显示未确认徽标。

## 2. 目标与非目标

### 2.1 目标

- owner 创建、编辑、启停和软删除全公司字面量规则；
- 仅匹配启用规则生效后的新客户入站消息和有效正文编辑；
- 用 Unicode 规范化、不区分大小写的 Aho-Corasick 自动机批量匹配规则；
- 消息落库与待扫描任务原子提交，服务重启或瞬时故障后继续处理；
- 同一 `message + rule` 最多产生一条告警；
- 命中时固定接收人，并为有确认权限的接收人保存彼此独立的确认状态；
- 所有读取继续经过当前 RBAC scope 复核，角色或归属变化不能泄露已失去权限的数据；
- 桌面提供未确认徽标、应用内非阻塞提示、告警列表、筛选、分页、短摘录和逐条确认；
- 明确展示命中后发生的消息编辑或删除，不保存长期旧正文副本。

### 2.2 非目标

- 不支持正则规则、近似匹配、分词、模型分类或情绪分析；
- 不回扫规则创建、编辑或重新启用前的历史消息；
- 不匹配员工出站消息；
- 不提供团队级、账号级或个人级规则；
- 不提供 agent 申请/owner 审批告警权限；
- 不提供公开 API、第三方订阅、邮件或企业微信 webhook；
- 不调用 macOS 或 Windows 系统通知，不播放声音，不做应用关闭后的推送；
- 不实现点击告警后自动跳转到平台原生会话或具体消息；
- 不把 WhatsApp Web DOM 气泡回传冒充稳定消息协议；
- 不修改 Telegram、Signal 或 WhatsApp 的消息身份算法、发送流程、翻译流程或原生渲染。

## 3. 平台与消息边界

匹配入口只有中央 `messages` 表。当前可覆盖：

- Telegram 适配器或已接入 `/api/native/events` 的原生消息；
- Signal 适配器或 Signal Desktop 原生 bridge 回传；
- 配置并启用后的 WhatsApp Business Platform Cloud API Webhook 纯文字消息。

WhatsApp `web_shell` 虽能在窄 preload 内读取当前可见 DOM 气泡以完成翻译、草稿与发送确认，但当前
不会把 DOM 正文上报 `/api/native/events`，因此不进入本阶段告警。为 WhatsApp Web 增加持久消息
outbox 属于后续 M6 独立切片，不能在 M4-3 中顺手扩大范围。

只要某个平台消息已经通过现有归一化边界进入中央库，告警层就不再区分它来自适配器、原生 bridge
还是 Cloud API。去重仍由 `(account_id, platform_message_id)` 和现有消息 revision 语义负责。

## 4. 规则模型与匹配语义

### 4.1 规则字段

`keyword_rules` 保存：

- `id`；
- `pattern`：owner 输入并用于界面展示的字面量；
- `normalized_pattern`：服务端生成的匹配值；
- `severity`：`normal | important | urgent`，界面映射为“普通 / 重要 / 紧急”；
- `enabled`；
- `revision`：从 1 开始的乐观锁版本；
- `effective_at`：本次创建、编辑或重新启用开始生效的时间；
- `created_by_user_id`、`updated_by_user_id`；
- `created_at`、`updated_at`、`deleted_at`。

活动记录以 `normalized_pattern` 建立部分唯一索引。规范化后重复的未删除规则返回 `409`，不能靠界面
去重。删除使用 `deleted_at` 软删除，以便已有告警继续保留准确的规则关联。

### 4.2 字面量规范化

规则与消息正文使用同一纯函数：

1. 规则先去除首尾空白；
2. 使用 Unicode `NFKC` 规范化；
3. 使用与 locale 无关的小写转换；
4. 以规范化后的 code point 序列执行子串匹配。

空规则、包含 C0/C1 控制字符的规则和超过 100 个 Unicode code point 的规则由严格 schema 拒绝。首版不提供
大小写开关、整词开关或正则 flags；中文及其他不以空格分词的语言也按子串语义工作。

### 4.3 命中与编辑

- 一条消息命中多个规则时，每条规则各生成一个告警；
- 同一关键词在同一正文出现多次仍只生成一个告警；
- 唯一约束固定为 `(message_id, rule_id)`；
- 后续编辑首次命中可创建告警，已经命中过的规则不重复创建；
- 命中后的再次编辑不会撤销告警；告警保存首次命中的消息 revision，查询时与当前 revision 比较并
  显示“命中后已编辑”；
- 消息软删除后告警显示“原消息已删除”，不展示正文摘录；
- 账号、会话或消息被实际级联删除时，关联任务、告警和接收状态一并删除。

新建、编辑或重新启用规则会更新 `effective_at`。扫描任务只考虑 `effective_at <= job.created_at` 的
当前启用规则，因此新规则不会追溯命中此前任务；规则禁用或删除会立即阻止尚未处理任务继续使用它。
已有告警保存命中时的关键词和等级快照，不因规则后续编辑改变含义。

## 5. 持久扫描处理链

### 5.1 原子任务

`keyword_alert_scan_jobs` 保存：

- `id`、`message_id`、`message_revision`；
- 本次新消息或编辑的 `body_snapshot`；
- `created_at`、`available_at`；
- `attempt_count`、`lease_owner`、`lease_expires_at`；
- 非敏感 `last_error_code`。

`(message_id, message_revision)` 唯一。现有消息仓储在确认一条非空客户入站消息是首次插入或有效正文
更新时，于同一个 PostgreSQL 事务中插入任务。重复平台事件、同 revision 重放、出站消息和没有正文
变化的更新不会增加任务；migration 不为旧消息补任务。

任务正文只是为了保证快速连续编辑时每个已接受版本都能可靠匹配。成功处理后整行立即删除，不能复制
到告警表、日志或错误文本。持续失败的任务会继续在内部任务表保留正文直到恢复成功；这是“不静默漏
告警”优先于自动丢弃失败任务的明确取舍。产品 API 不提供读取任务正文的能力。

### 5.2 领取、匹配与重试

单个处理器按 `created_at, id` 每批领取最多 20 个任务，使用 `FOR UPDATE SKIP LOCKED` 和 60 秒租约，
避免重复阻塞并允许崩溃恢复。每批从数据库读取当前启用、未删除且已对相应任务生效的规则，构建一次
纯 TypeScript Aho-Corasick 自动机，不增加原生依赖。即使正文达到现有 native API 的上限，也扫描完整
正文，不用截断制造漏报；单处理器和小批量负责限制瞬时 CPU 与内存占用。

命中处理在数据库事务中完成：幂等插入告警、计算接收人、插入接收状态并删除扫描任务。提交成功后
才发送 WebSocket；实时发送失败不回滚持久数据，客户端稍后通过列表与计数恢复。

瞬时错误从 1 秒开始指数退避，最长 5 分钟。连续失败 10 次后停止自动领取，任务仍保留并进入可见的
degraded 状态；owner 规则页只显示异常任务数量与“重试”操作。重试把 attempt 归零并立即重新调度，
不在 UI 或日志暴露关键词、正文、账号标识或用户标识。

## 6. 告警、接收人和确认模型

### 6.1 告警事实

`keyword_alerts` 保存：

- `id`、`message_id`、`rule_id`；
- `pattern_snapshot`、`severity_snapshot`；
- `matched_message_revision`、`created_at`。

告警不保存完整正文或长期摘录。列表所需短摘录从当前 `messages.body` 即时生成，最长 160 个 Unicode
code point；当前正文仍包含关键词时截取命中附近，否则截取当前正文开头并显示编辑标记。

### 6.2 命中时接收人快照

接收人从当前未禁用用户中计算并去重：

- 所有 `owner`；
- 所有 `auditor`，仅用于只读告警流；
- 作为该账号团队 lead 的 `manager`；
- 该账号的 owner 用户，其角色为 `agent` 时获得本人账号告警。

`keyword_alert_recipients` 保存 `(alert_id, user_id)`、`requires_ack`、`acknowledged_at` 和
`created_at`。`owner`、`manager`、`agent` 的 `requires_ack=true`；`auditor` 为 false。因此 auditor
能实时查看全公司告警，但没有无法清零的个人未确认数量。

角色、团队或账号归属变化不会增删历史接收人行。但读取告警时必须同时满足“当前用户有接收人行”和
“关联账号仍在当前 `req.scoped` 范围内”。这可防止已失去权限的旧接收人继续读取消息，同时保证新加入
人员不会自动继承旧告警。

### 6.3 独立确认

确认只更新当前用户自己的接收人行。`owner`、`manager` 和 `agent` 可确认当前仍可见且
`requires_ack=true` 的告警；重复确认幂等返回成功。`auditor` 的确认请求固定返回 `403`。确认一条告警
不会改变其他用户的列表、徽标或确认时间，也不修改全局告警事实。

## 7. 服务端 API 与安全边界

### 7.1 owner-only 规则接口

- `GET /api/keyword-rules`
- `POST /api/keyword-rules`
- `PATCH /api/keyword-rules/:id`
- `DELETE /api/keyword-rules/:id`
- `POST /api/keyword-alert-scans/retry`

所有接口都在服务端按每请求实时 actor 校验 `owner`。其他角色既不能写，也不通过该接口读取完整规则
目录。创建只接受 `pattern`、`severity`、`enabled`；编辑只接受 `baseRevision` 以及至少一个可变字段。
启停也走同一 revision 乐观锁。请求使用 strict schema；错误只返回固定中文消息，不回显 pattern。

### 7.2 当前用户告警接口

- `POST /api/keyword-alerts/search`：按 `pending | acknowledged | all`、等级、平台、账号和
  scope-bound cursor 分页；
- `GET /api/keyword-alerts/unacknowledged-count`：只统计当前用户可见且需要确认的接收人行；
- `PATCH /api/keyword-alerts/:id/acknowledge`：幂等确认当前用户自己的行。

搜索条件放在 POST JSON 中。列表只返回内部告警/消息/会话/账号 UUID、必要显示名、关键词与等级快照、
当前正文短摘录、编辑/删除标记、命中时间和当前用户确认状态。不得返回平台 external id、raw、媒体引用、
完整历史正文或其他接收人的状态。

所有告警业务读取由 `ScopedDb` 提供专用仓储：查询从 `accounts` 开始施加 `applyAccountScope`，再 join
消息、告警和当前用户接收行。路由不能直接 import 全局 `db`。游标绑定当前用户、过滤器和 scope，不能
跨用户或跨筛选复用。

### 7.3 WebSocket 事件

共享协议新增精确事件：

```ts
interface WsKeywordAlertEvent {
  type: 'keyword_alert'
  alertId: string
  severity: 'normal' | 'important' | 'urgent'
  requiresAcknowledgement: boolean
  createdAt: string
}
```

事件不含关键词、正文、摘录、账号/会话显示名或平台 external id。客户端收到后只更新计数、显示通用
应用内提示并按需重新拉取受权限约束的列表。

## 8. 桌面交互

功能中心现有“关键词警报”入口接入新的 `keywordAlerts` view，并显示当前用户的未确认数量徽标。
`auditor` 不请求或显示该徽标。

`owner`、`manager` 和 `agent` 默认显示自己的“未确认”列表，可切换“已确认”或“全部”；`auditor`
默认且只能使用“全部”时间流。所有角色都可按等级、平台和账号筛选。列表使用稳定 keyset cursor 分页，
显示：

- 普通、重要或紧急等级；
- 命中关键词；
- 平台、账号和会话显示名；
- 命中时间；
- 当前正文的有界短摘录；
- “命中后已编辑”或“原消息已删除”状态。

`owner`、`manager` 和 `agent` 可逐条确认；`auditor` 只读。首版不做批量确认、不做取消确认，也不自动
跳转原生平台会话。

owner 在同一页面额外看到“规则管理”页签，支持新增、编辑、等级、启停和删除，并显示异常扫描任务
数量与重试入口。其他角色不渲染该页签。

收到 WebSocket 告警时，桌面显示不含正文的非阻塞应用内提示、刷新徽标，并在告警页当前打开时刷新
列表。所有状态只保存在 renderer 内存；不使用 Electron 主进程系统通知，不在本地磁盘保存告警正文。
筛选、刷新、分页和实时更新必须使用 AbortController、请求 generation 和 reducer 规则，阻止迟到响应
覆盖新状态。

## 9. 错误、恢复与可观测性

- 数据库任务保证消息提交后不会因服务进程退出而静默丢失扫描；
- 过期租约自动恢复，重复领取由唯一约束与幂等 upsert 收敛；
- WebSocket 发送失败不改变持久接收状态；重新登录后以 HTTP 计数和列表恢复；
- 规则输入错误、重复规则和 revision 冲突分别返回稳定的 `400`、`409`，不回显输入；
- 告警列表加载失败、确认失败和规则保存失败在对应页面显示可重试错误，不把旧列表伪装成最新结果；
- 扫描持续失败必须在 owner 页面显式提示，不能只写日志；
- 日志只记录固定事件码、批次计数、重试次数和错误类别，不记录关键词、正文、摘录、账号/会话/用户
  标识、平台消息键、token、二维码、验证码或任何平台 profile/session 信息。

## 10. 数据迁移与发布

新增向前 migration 创建四张表、检查约束、外键、唯一约束和查询索引。不得改写已提交 migration，也
不得在 migration 中扫描现有 `messages` 或生成历史告警。

后台处理器在 migration 完成后启动。规则为空时消息入口仍只增加一个可快速清理的扫描任务；处理器
发现无生效规则后直接删除任务。若需要回滚桌面入口，可停止规则与告警 API，但保留表内未完成任务，
避免把回滚误当成成功处理。

当前 a55 只是开发验收包，不是正式安装包。M4-3 不改变 Signal/Telegram/WhatsApp 包装、签名或许可证
交付流程；正式跨 macOS/Windows 打包仍属于 M7。

## 11. 测试与完成门槛

### 11.1 纯领域测试

- NFKC、大小写、code point 上限、控制字符和规范化重复；
- Aho-Corasick 单规则、多规则、重叠关键词、同词多次出现和空规则集；
- 短摘录 code point 边界、编辑后不再包含关键词和删除消息状态；
- 桌面 reducer 的迟到响应、筛选、分页、实时刷新和个人确认。

### 11.2 数据库与服务测试

- migration up/down 只作用于隔离测试 schema；
- 仅新入站消息和有效编辑与消息事务一起创建扫描任务；
- 出站、重复事件、无变化更新和 migration 历史消息不创建任务；
- 任务租约、过期恢复、退避、手动重试及成功后正文快照删除；
- 同一 `message + rule` 幂等，编辑首次命中和命中后编辑均符合语义；
- owner/auditor 全局、manager lead-team、agent self-account 接收矩阵；
- 禁用用户、无团队账号、重复身份去重和角色/团队变化后的当前 scope 二次校验；
- 每人独立确认，auditor `403`，其他用户状态不受影响；
- scope-bound 分页、筛选、计数和响应字段白名单；
- WebSocket 只发送给命中时接收人，且 payload 不含正文或关键词。

数据库测试只能使用 `testDatabaseUrl()` 派生的固定 `_test` 库，不读取或打印 `.env`。

### 11.3 桌面与完整验证

- 功能中心入口、角色可见页签和徽标；
- 未确认/已确认/全部、auditor 只读时间流、等级/平台/账号筛选、空态、加载、错误和加载更多；
- 应用内提示、无系统通知调用、确认失败保留当前状态；
- owner 规则 CRUD、启停、重复冲突和扫描异常提示；
- `pnpm typecheck`；
- 相关 Vitest；
- `pnpm test` 全量回归；
- `pnpm --filter @im-hub/desktop build`。

真实平台验收不自动执行。若后续确需验收，由用户另行明确授权，只使用非敏感测试词和一条可控入站
消息；不得借机重做 Telegram、Signal、WhatsApp 发送或生命周期矩阵。

## 12. 实施边界

实现按以下独立层次拆分：

1. shared 规则、告警、搜索和 WebSocket 契约；
2. migration、数据库类型和纯字面量匹配器；
3. 消息事务中的持久扫描任务与后台处理器；
4. 接收人快照、ScopedDb 告警仓储及 owner-only 规则仓储；
5. 严格 API、计数、个人确认和实时推送；
6. desktop API、状态机、功能中心徽标、告警页和 owner 规则页；
7. 文档、全量验证和可选的受控人工验收。

所有实现采用红—绿 TDD 和聚焦提交。不得在本切片中修改平台 guest/preload、消息 ID、composer、发送
attempt、翻译协调器、WhatsApp DOM 读取范围或原生平台渲染。
