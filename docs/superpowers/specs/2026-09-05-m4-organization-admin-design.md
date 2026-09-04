# M4-4 公司内部组织与管理中心设计

日期：2026-09-05
状态：设计已确认，待实施

## 1. 背景与目标

M4-1/M4-2 已交付人工客户档案及可检索档案库，M4-3 已交付公司内部关键词告警。现有数据库也已经
存在 `users`、`teams`、`team_members` 和 `accounts`，RBAC 已按 owner 全局、auditor 全局只读、
manager 所带团队、agent 本人账号运行。但是员工、团队、主管和账号归属仍只能通过 seed 或数据库
人工维护，桌面端没有管理入口，密码重置、即时撤权和唯一 owner 转让也没有完整流程。

M4-4 建立一个只供公司内部使用的组织管理闭环：唯一 owner 在统一管理中心管理员工、团队和平台
账号归属；macOS 与 Windows 客户端共用公司内部中心服务端的同一套权限事实。功能不对公网用户开放，
也不依赖邮件、短信或第三方身份服务。

成功标准：

- owner 可以在桌面端完成员工创建、首次改密、停用/启用、角色调整和密码重置；
- owner 可以创建、归档和恢复团队，指定唯一主管并调整 agent 团队；
- owner 可以安全转移平台账号负责人，并让旧控制授权立即失效；
- 系统始终只有一个启用 owner，并支持带再次验证的原子 owner 转让；
- 组织变更不能破坏现有 RBAC、客户档案、关键词告警或平台消息链路；
- 本地平台会话不能被误当作可在两台电脑间远程复制的数据。

## 2. 已确认的产品边界

### 2.1 本次实现

- 仅 owner 可见、可用的统一“管理中心”，包含员工、团队、平台账号三个页签；
- 员工账号的创建、临时密码、首次强制改密、自助改密、owner 重置、停用和重新启用；
- `agent` 零或一个团队、`manager` 可负责多个团队、启用团队恰好一个主管；
- agent 调组时，成员关系与其名下全部账号在同一事务内迁移；
- 平台账号负责人和团队的强一致校验；
- 唯一 owner 作为例外，可持有任意启用团队或未分组的平台账号；
- 员工停用时，名下账号自动转给唯一 owner 并保留原团队；
- 本地平台账号转移后的授权撤销、设备清理任务和人工清理兜底；
- 带乐观版本的管理写操作、稳定错误码和结果未知后的核对流程；
- 旧 JWT 失效、HTTP/WS 会话版本校验和应用内即时撤权；
- migration、preflight、RUNBOOK、权限矩阵、并发测试、桌面测试和双平台人工验收。

### 2.2 明确不做

- 不开放注册、自助邀请、客户入口或公网管理后台；
- 不接邮件、短信、SSO、LDAP 或第三方身份提供商；
- 不允许 manager、auditor、agent 维护员工、团队或账号归属；
- 不物理删除员工，不删除或重建既有平台账号；
- 不重新引入已经取消的审计日志、审计查询或档案正文审计；
- 不在设备间复制 Telegram、Signal 或 WhatsApp 的本地 session/profile；
- 不自动删除 Signal Desktop 的共享 profile；Signal 账号转移后始终由公司人工解除旧关联设备；
- 不承诺擦除永不再联网的退役电脑；这种情况必须通过平台官方设备列表人工解除；
- 不修改客户档案字段、关键词匹配规则、消息去重键、翻译或发送 attempt；
- 不新增真实平台消息发送验收。

## 3. 方案选择与架构

采用“统一内部管理中心 + 独立组织管理服务”的方案，而不是把管理操作分散到账号状态等已有页面，
也不另建一套管理站点。

### 3.1 组件边界

1. `packages/shared` 定义管理读模型、命令、响应、错误码和新增 WS 事件；
2. `packages/server` 新增组织管理 service/repository、认证状态变更和设备清理仓储；
3. `/api/admin/*` 路由只做 owner 门禁、输入解析和响应映射，不直接 import `db`；
4. 跨表不变量全部由组织管理 service 在数据库事务中维护；
5. 普通业务读取继续只经 `req.scoped`/`ScopedDb`，管理接口不能扩大现有业务路由的可见范围；
6. `packages/desktop` 新增管理中心控制器、页面和 Electron 本地分区清理桥接；
7. 中心服务端和 PostgreSQL 是本功能的必要依赖，但可只部署在公司内网或固定主机，不要求公网开放。

### 3.2 权限边界

`/api/admin/*` 每次请求使用数据库实时加载的 actor。只有 `role='owner'` 且未停用、会话版本匹配的
唯一 owner 可以继续执行。其他角色统一返回 `403`，不得通过不同的 `404`、字段或计数枚举员工、
团队、设备和账号归属。

owner 的“全局可见”不等于任意业务写权限。原生控制、账号删除和平台鉴权等既有 owner-user 校验
继续保留；本切片只通过明确的管理命令改变归属事实。

## 4. 领域模型与不变量

### 4.1 用户

`users` 保留现有主键与密码哈希，并新增：

- `session_version`：会话撤销版本，初始为 1；
- `must_change_password`：是否只能进入首次改密流程；
- `temporary_password_expires_at`：临时密码失效时间；
- `revision`：管理写操作的乐观版本；
- `updated_at`：最近一次管理修改时间。

系统不增加明文密码、临时密码或密码历史字段。`disabled_at` 继续表示停用；员工不物理删除。

任意时刻必须恰好有一个 `role='owner'` 且未停用的用户。普通用户接口不能把 owner 停用、降级或
再创建一个 owner；唯一合法入口是专用 owner 转让事务。

### 4.2 团队与成员

`teams` 新增 `disabled_at`、`revision` 和 `updated_at`。归档只改变组织状态，不删除团队行。

`team_members` 继续表达成员关系：

- `agent` 允许没有团队，或作为非 lead 成员加入一个启用团队；
- `manager` 不作为普通成员，其 membership 必须是 lead，可负责多个启用团队；
- `owner` 和 `auditor` 不出现在 `team_members`；
- 一个启用团队必须恰好有一条 lead membership；
- 同一启用团队不能同时有两个主管。

服务层使用用户行和团队行锁串行化调组、换主管、角色变更与归档。数据库部分唯一索引保证同一团队
至多一个 lead；“至少一个主管”和 agent 角色相关的单团队约束由事务服务与并发测试保证。

### 4.3 平台账号

`accounts.owner_user_id` 仍是一名负责人，`accounts.team_id` 仍是零或一个团队。增加 `revision` 作为
管理写版本，继续使用现有 `native_control_version` 撤销旧 grant。

归属不变量：

- agent 负责的账号必须与该 agent 的团队相同；agent 未分组时账号也必须未分组；
- manager 负责的账号必须属于其当前负责的某个启用团队；没有负责团队的 manager 不能接收账号；
- auditor 不能负责账号；
- 唯一 owner 是例外，可以负责任意启用团队或未分组账号；
- 账号负责人必须是启用用户；
- 归档团队不能接收成员或账号。

任何归属变更都不改变 `accounts.id`，也不删除 conversations、messages、customer_profiles、
keyword_alerts、平台最终消息 id 或服务器端凭证引用。

### 4.4 桌面设备与清理任务

新增三类事实：

- `desktop_installations`：安装实例 id、设备凭证哈希、客户端版本、能力集合、最近在线时间和撤销时间；
- `account_device_mounts`：某安装实例曾挂载的本地型账号、当时负责人和最后上报时间；
- `desktop_cleanup_tasks`：账号转移后的清理义务。自动清理任务绑定指定安装实例；Signal 或尚无已知
  挂载设备的人工清理义务允许 `installation_id` 为空，并记录账号、原因、创建时间、确认时间和状态。

设备随机凭证由 Electron 主进程生成并经 `safeStorage` 保存；服务端只保存不可逆哈希。设备登记和任务
领取必须同时具备有效员工会话与设备凭证。表中不存平台 token、二维码、验证码、2FA 密码、session
内容、profile 文件或聊天正文。清理任务是待完成的运行状态，不是审计记录；完成 30 天后删除，不能
据此提供员工操作历史查询。

## 5. 员工认证与撤权流程

### 5.1 创建与首次登录

owner 创建员工时填写规范化邮箱、显示名、角色以及必要的团队选择。普通创建只允许 `auditor`、
`manager`、`agent`，不能创建 owner。

服务端用密码学安全随机数生成临时密码，建议采用 24 随机字节的 base64url 表示；只把 Argon2 哈希
写入数据库。成功响应是明文唯一展示点，响应不得缓存，服务端不得记录请求体或响应体。临时密码从
签发起 24 小时有效。

员工设置的正式密码按原样校验，不做 trim；长度为 12–128 个字符，允许长密码短语，不增加容易造成
固定套路的字符种类要求。密码哈希继续复用现有 Argon2 实现。

临时密码验证成功后不签发普通工作台 token，而是签发 10 分钟有效、带 `purpose=initial_password`
和当前 `session_version` 的改密凭证。员工提交新密码后，服务端再次核对版本，更新哈希、清除
`must_change_password` 与到期时间、递增会话版本，再签发普通会话。临时凭证过期或 owner 在期间
重置密码时，必须重新开始。

### 5.2 改密、重置、停用和启用

- 员工自助改密必须提交当前密码；成功后递增会话版本并只保留新签发会话；
- owner 重置密码生成新的临时密码，旧密码、临时凭证和全部普通会话立即失效；
- 停用员工先完成依赖解析，再设置 `disabled_at`、递增会话版本并关闭其 WS；
- 停用员工名下全部账号在同一事务中转给唯一 owner，保留原团队并递增账号控制版本与 revision；
- 停用/降级 manager 时，每个所带启用团队必须在同一命令中选择新主管或归档；
- 重新启用时生成新的临时密码并强制首次改密，不恢复旧密码或旧会话。

普通角色变更不是无条件下拉框。若目标角色与现有团队或账号冲突，服务端返回结构化 blockers，要求
owner 先明确处理主管和账号；除已经确认的“停用自动转给 owner”外，不隐式猜测归属。

### 5.3 会话版本

普通 JWT 加入 `sessionVersion`。HTTP 流程先验签，再从数据库加载用户并比较版本、角色和停用状态；
WS 鉴权首帧执行同样校验，不能只验 JWT 签名。

改密、重置、停用、任意角色变更和 owner 转让时，服务端先向该用户发送不含敏感信息的
`session_revoked` 应用事件，再关闭其连接。事件即使丢失，旧 token 也因版本不匹配而不能重连。
desktop 收到撤权或后续 401 时关闭 WS、卸载受控平台 pane、清内存状态和 `safeStorage` 会话并返回
登录页。

## 6. 团队生命周期

### 6.1 创建、更换主管和调组

- 创建启用团队必须同时指定一名已启用 manager；
- 更换主管在一个事务内替换 lead membership，旧主管立即失去团队范围；
- 如果旧主管本人持有该团队账号，这些账号同时转给唯一 owner、保留团队并撤销旧 grant；
- agent 调组时，成员关系和其名下全部账号原子迁移到目标启用团队；
- agent 移为未分组时，其账号也全部变为未分组；
- manager 可以负责多个团队，但每个团队仍只有一个主管。

`loadActor` 继续按每个请求实时读取 lead memberships，并且只读取未归档团队；leadTeamIds 不写入 JWT。

### 6.2 归档与恢复

归档团队时，先把由该团队主管负责的账号转给唯一 owner，再删除该团队的成员关系，把引用该团队的
所有账号设为未分组，并设置 `disabled_at`。普通 agent 仍负责自己的账号，只是员工与账号一起变为
未分组。员工、账号、会话、消息、档案和告警均保留。负责人发生变化的账号执行第 7 节的控制撤销与
清理流程；只有团队字段变化的账号不清理本地平台 session。

恢复团队必须同时指定一名启用 manager。恢复后的团队不自动找回归档前成员；owner 按当前实际组织
重新调入 agent。这样不会根据过期历史关系静默恢复权限。

## 7. 平台账号转移与本机清理

### 7.1 负责人和团队选择

目标负责人必须已启用：

- agent：团队由其当前 membership 自动确定，不能另选；
- manager：必须从其负责的启用团队中明确选择一个；
- owner：可选择任意启用团队或未分组；
- auditor：始终拒绝。

事务更新负责人、团队和 revision，并递增 `native_control_version`。旧负责人签发过的控制 grant 因版本
不匹配立即失效。

### 7.2 各连接模式的行为

- 服务端 adapter：服务端 session 可保持连接，新负责人重新取得控制权限；
- WhatsApp Cloud API：服务端授权可保持，新负责人使用同一中央账号；
- WhatsApp Web 和本地补丁客户端：不能复制本地 session，新负责人必须在自己的电脑重新扫码或
  登录；旧设备按账号执行自动分区清理；
- Signal Desktop：新负责人必须在自己的电脑重新关联；旧设备只立即撤销 im-hub 控制并隐藏 Signal
  视图，不删除共享 profile，清理任务固定标为“需人工处理”，由公司在 Signal 官方“已关联设备”中
  解除。

对支持按账号分区的本地型账号，服务端为所有已知旧挂载设备创建 cleanup task。在线且支持能力协商
的新版客户端收到命令后立即卸载 pane、释放控制并清除对应持久分区，再确认任务。离线设备上的分区
不得再次挂载；该电脑下次连接中心服务并完成任意有效公司登录后，凭设备凭证领取并执行清理。

Signal cleanup task 不进入自动领取/完成流程，而是保持 `manual_required`，直到 owner 在管理中心确认
公司已经从 Signal 官方设备列表解除旧设备。确认只关闭待办，不得声称 im-hub 擦除了 Signal profile。
同一安装实例在旧 cleanup task 完成或被确认前不能重新上报该账号挂载；其他没有该待办的新安装实例
不受影响，仍可由新负责人重新关联。

永不再联网的电脑无法远程擦除。任务保持“待本机清理”，界面提示公司回收设备，并在 Telegram、
Signal 或 WhatsApp 官方设备列表解除旧设备。该限制必须明确展示，不能把“服务端已转移”表述为
“旧电脑已擦除”。

Telegram/WhatsApp Web 在线设备版本过旧或未声明清理能力时，默认拒绝转移并返回
`CLIENT_UPDATE_REQUIRED`。这些设备长期离线、员工已离职或硬件损坏时，owner 可在摘要确认页选择
人工清理模式；服务端完成权限转移，但保留未完成任务和官方解除提示。Signal 不做能力门禁，始终进入
上述人工处理状态。

## 8. 唯一 owner 转让

owner 转让使用独立高风险命令，不复用普通角色更新：

1. 当前 owner 再次输入本人密码；密码只存在于当前请求内存，不记录；
2. 目标必须是已启用员工，且不是当前 owner；
3. 请求必须声明旧 owner 转让后的 `agent`、`manager` 或 `auditor` 角色；
4. 请求必须为所有受影响团队和账号提供显式 resolution；
5. service 锁定两名用户及相关团队、账号，在一个事务中完成全部变更；
6. 单条角色交换或等价的约束安全操作保证提交前后都不会留下两个 owner；
7. 双方 `session_version` 递增，事务提交后双方旧会话全部失效并重新登录。

目标原为 manager 时，其带领团队必须逐个指定新主管或归档；目标成为 owner 后不保留 team membership，
但其原有账号可按 owner 例外保留原团队。旧 owner 成为：

- auditor：名下账号全部转给新 owner，且不保留 membership；
- agent：选择一个启用团队或未分组，名下账号随之规范化；
- manager：显式指定所带团队，并逐个处理被替换主管；名下账号只能留在这些团队，否则转给新 owner。

确认页必须列出角色、团队、账号、会话和本机清理任务的变化数量。任何验证、锁、唯一约束或数据库
步骤失败都回滚全部变更。

## 9. API 契约

共享契约使用 camelCase；数据库字段保持 snake_case。管理查询与命令建议分组如下：

### 9.1 员工

- `POST /api/admin/users/search`
- `POST /api/admin/users`
- `PATCH /api/admin/users/:id`
- `POST /api/admin/users/:id/reset-password`
- `POST /api/admin/users/:id/disable`
- `POST /api/admin/users/:id/enable`
- `POST /api/admin/owner-transfer/preview`
- `POST /api/admin/owner-transfer`

### 9.2 团队

- `POST /api/admin/teams/search`
- `POST /api/admin/teams`
- `PATCH /api/admin/teams/:id`
- `POST /api/admin/teams/:id/change-manager`
- `POST /api/admin/teams/:id/archive`
- `POST /api/admin/teams/:id/restore`
- `POST /api/admin/agents/:id/change-team`

### 9.3 平台账号和设备

- `POST /api/admin/accounts/search`
- `POST /api/admin/accounts/:id/assignment-preview`
- `POST /api/admin/accounts/:id/assign`
- `GET /api/account-creation-context`
- `POST /api/desktop/installations/register`
- `POST /api/desktop/installations/heartbeat`
- `POST /api/desktop/installations/sync-mounts`
- `POST /api/desktop/cleanup-tasks/claim`
- `POST /api/desktop/cleanup-tasks/:id/complete`
- `POST /api/admin/desktop/cleanup-tasks/:id/confirm-manual`

### 9.4 首次改密与自助改密

- `POST /api/auth/login` 在 `mustChangePassword=true` 时只返回首次改密凭证，不返回普通会话；
- `POST /api/auth/initial-password/complete`
- `POST /api/session/password`

员工、团队和账号查询使用 JSON 请求体承载关键词、筛选与游标，避免邮箱、姓名和内部组织信息进入
URL/代理访问日志。分页排序必须稳定，并以 opaque cursor 继续。

所有修改现有资源的命令携带 `baseRevision`；创建命令没有可绑定的既有资源 revision。批量/高风险
命令先提供 preview，execute 请求携带 preview 返回的
短时 `operationToken`。token 绑定当前 owner、输入规范化摘要、相关 revision 与到期时间，防止确认页
加载后数据变化仍执行旧方案。execute 仍在事务内重验全部事实，不能只信 token。

### 9.5 稳定错误语义

- `400`：输入格式不合法；
- `401`：会话缺失、失效或版本不匹配；
- `403`：不是 owner，或当前用户不能执行该类操作；
- `404`：目标不存在；对非 owner 不进入目标解析；
- `409 REVISION_CONFLICT`：乐观版本冲突，并返回最新非敏感快照；
- `409 ORGANIZATION_INVARIANT`：操作会破坏 owner、主管、团队或账号不变量，并返回结构化 blockers；
- `409 CLIENT_UPDATE_REQUIRED`：已知在线设备缺少清理能力；
- `409 DEVICE_CLEANUP_PENDING`：当前安装实例必须先完成或人工确认旧账号清理任务；
- `422 OPERATION_PREVIEW_EXPIRED`：摘要 token 过期或绑定事实已变化；
- `503`：中心服务或数据库暂时不可用。

错误体不返回密码、哈希、设备凭证、平台凭证、session 路径、token、消息正文或客户档案正文。

## 10. 并发与结果未知

- 单行编辑使用 `baseRevision` 条件更新；影响行为 0 时重新读取并返回 `409`；
- 调组、换主管、停用、归档、账号转移和 owner 转让锁定确定顺序的用户、团队、账号行，避免死锁；
- owner 唯一索引、团队 lead 部分唯一索引作为最后一道并发保护；
- 高风险 execute 成功后相关 revision 必然变化；旧 operation token 的重复提交因绑定 revision 失效，
  客户端刷新实际状态，不引入持久化操作日志保存可重放结果；
- 创建员工和重置密码不保存可重放的明文临时密码。网络结果未知时，客户端先刷新状态；如果创建已经
  成功但密码响应丢失，owner 对该员工执行一次新的密码重置，旧临时密码立即失效；
- 客户端不能因为超时盲目重复 owner 转让、停用、归档或账号转移。

## 11. 桌面管理界面

只有当前服务端角色为 owner 时，功能中心显示“管理中心”。其他角色不显示入口；前端隐藏不能替代
服务端 `403`。

### 11.1 员工页签

- 按姓名、邮箱、角色、状态、团队筛选；
- 显示状态、角色、团队和负责账号数量；
- 提供创建、改名、角色调整、停用/启用、重置密码；
- 创建或重置成功后用一次性结果弹窗显示临时密码，提供用户主动触发的复制按钮；
- 弹窗明确写明关闭后无法再次查看，组件卸载时清除内存引用。

### 11.2 团队页签

- 显示主管、成员数、平台账号数和启用/归档状态；
- 提供创建、更换主管、agent 调组、归档和恢复；
- 归档摘要列出将变为未分组的员工和账号数量；
- 恢复时强制重新选择主管，不自动恢复旧成员。

### 11.3 平台账号页签

- 显示平台、连接模式、在线状态、负责人、团队和本机清理状态；
- 提供负责人/团队转移与设备清理说明；
- 不在此页面复用账号删除，不提供聊天数据删除；
- 本地账号明确区分“服务端已转移”“新负责人待关联”“旧设备待清理”。
- Signal 明确显示“需在 Signal 官方已关联设备中人工解除”，不提供或暗示自动 profile 删除。

### 11.4 高风险确认与错误反馈

员工停用、团队归档、账号转移和 owner 转让先显示 preview 摘要，再执行一次原子命令。owner 转让额外
要求当前密码，并展示旧 owner 新角色及全部依赖处理结果。

- 字段错误就地显示并保留输入；
- revision 冲突展示服务器最新状态并要求重新确认；
- 网络超时显示“结果未知，正在核对”，刷新相关列表后再开放操作；
- 本机清理失败不回滚已经提交的服务端权限变更，界面持续显示待处理任务；
- macOS 与 Windows 复用相同 React 页面和 Electron 清理桥接，不使用 OS 通知。

临时密码不写入 zustand、localStorage、sessionStorage、日志或持久化 store。系统剪贴板只有 owner 主动
点击复制时才写入；应用提示公司按内部安全流程传递并及时清除剪贴板。

## 12. Migration、preflight 与发布顺序

新增 `0016_organization_admin` 向前 migration，只增加字段、索引和设备清理表，不删除业务数据。已承载
真实组织数据后不通过 down migration 回滚员工、团队或设备状态，应使用向前修复。

migration 前运行只读 organization preflight，验证：

1. 恰好一个启用 owner；
2. 每个现有启用团队恰好一名 lead，无主管或多主管都中止；
3. agent 没有多个 membership；
4. 账号负责人、团队和 membership 外键均有效。

发现歧义只输出问题类型和数量并中止，不自动选择 owner、主管或负责人；RUNBOOK 给出人工修复步骤，
不得输出密码、token、平台身份或客户数据。

受控发布顺序：

1. 运行 preflight 和数据库 migration；
2. 部署新服务端，但保持组织管理写操作关闭；
3. 升级 macOS/Windows 客户端到支持会话撤权、设备登记和分区清理的版本；
4. 新客户端登记本机已有平台分区，无法登记的设备显示为待确认；
5. owner 在管理中心预览组织状态后启用写操作；
6. 缺少 `sessionVersion` 的旧 JWT 失效，所有员工重新登录一次。

组织管理写开关只控制新管理命令，不关闭普通聊天、档案或告警读取。关闭开关是部署保护，不是权限
边界；服务端仍必须执行 owner 门禁。

## 13. 测试与验收

### 13.1 自动化验证

- isolated database migration/preflight 测试，包括不合规数据中止；
- owner、manager、auditor、agent 的管理 API 权限矩阵；
- 唯一 owner、唯一主管、agent 单团队和账号归属不变量；
- 同一 owner 的两个窗口并发修改、并发调组、并发换主管和并发 owner 转让；
- 临时密码 24 小时到期、首次改密 token、重置、自助改密和重新启用；
- session version 的 HTTP/WS 拒绝以及应用内撤权；
- 停用员工自动转移账号，失败时完整回滚；
- manager 换主管、归档/恢复、agent 调组和账号 revision；
- 各连接模式的账号转移、旧 grant 失效、设备能力门禁和 cleanup task；Signal 固定为人工清理；
- owner 转让的所有目标角色、依赖 resolution、再次验证和事务回滚；
- desktop 一次性密码展示、非 owner 隐藏、冲突保留、结果未知核对和清理状态；
- 敏感字段不进入日志、错误体、持久化 store 或测试快照；
- `pnpm typecheck`、全量 `pnpm test` 和 desktop production build。

数据库测试只连接固定隔离 `_test` 数据库，运行前先确认测试库存在，绝不能指向开发库或生产库。

### 13.2 人工验收

macOS 与 Windows 各执行一次：

1. owner 创建 agent，复制临时密码；
2. agent 首次登录并强制改密；
3. owner 创建团队和唯一主管，把 agent 调入团队；
4. 验证 agent、manager、auditor 的既有 RBAC 范围；
5. 转移 Telegram/WhatsApp Web 测试账号，验证旧 grant 失效、新负责人待关联和旧设备自动清理状态；
6. 转移 Signal 测试账号，验证旧 grant 失效、视图隐藏和官方设备列表人工解除提示；
7. 停用 agent，验证账号转给 owner、旧会话退出；
8. 重新启用并使用新临时密码；
9. 在预备测试用户之间完成一次 owner 原子转让并转回；
10. 模拟离线设备，验证待清理和人工解除提示。

人工验收不读取或记录临时密码、员工正式密码、设备凭证、平台 session、二维码、验证码、2FA 密码、
消息正文、客户档案正文或真实业务标识，也不发送新的真实平台消息。

## 14. 回滚与运行边界

- 管理 UI 可通过写开关关闭，已有 RBAC 和业务读取继续运行；
- 已完成的员工停用、角色变更、团队变更和账号转移不通过关闭开关自动反转；
- 账号转移不删除中央消息或平台凭证，因此服务端权限可用新的向前命令再次调整；
- 自动 cleanup task 失败保持可重试，不以删除任务或强制标记完成冒充本机已经清理；Signal 的
  `manual_required` 只在 owner 确认官方解除后关闭；
- 唯一 owner 转让失败必须完整回滚；提交成功后只能通过新的反向转让恢复；
- 中心服务端或数据库不可用时，管理中心只读地显示连接错误，禁止离线修改组织事实；
- 本地原生/Web 平台客户端即使仍有磁盘 session，也不能获得新的 im-hub 控制 grant；真正退役的离线
  设备仍必须由公司回收或在平台官方设备列表解除。
