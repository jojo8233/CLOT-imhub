# M3-4 Telegram 持久事件 outbox 与可靠回传

日期：2026-08-27
状态：代码、自动验证与修复后回复闭环已完成；真实账号故障矩阵仍受双账号阻塞，语音按用户决定跳过

## 1. 范围

telegram-tt 在中央消息更新路径生成 `message.upsert`、`message.deleted` 和
`message.id-remapped`，先写入账号 partition 内的 IndexedDB，再经 typed bridge 交给
Electron 主进程和 im-hub 服务端。只有收到 `event.ack` 后才从 pending outbox 删除；刷新、
进程退出或 ACK 丢失不会改变 `eventId`。

本阶段不让 guest 读取 im-hub 账号 UUID、用户 JWT、control grant 或服务端地址。guest
只用当前 Telegram self user id 隔离队列；主进程仍按 webview partition 绑定真正的 im-hub
账号并逐次验证短时 grant。

## 2. 中央事件来源

- `newMessage` 在全局状态合并完成后生成 upsert；本地发送回显使用
  `<chatId>:temp:telegram-tt:<instanceId>:<localId>`。`instanceId` 是每次页面实例启动时生成的
  128-bit 随机十六进制值，隔离 telegram-tt 模块重载后会从头计数的 local id；服务端仍解析旧的
  四段 temp 键，以便已有 IndexedDB pending 记录可以继续补传。
- `updateMessageSendSucceeded` 先生成 local-to-server remap，再生成最终消息 upsert；最终键为
  `<chatId>:<serverMessageId>`。
- `UpdateEditMessage` 与 `UpdateEditChannelMessage` 把 MTProto `pts` 带到 renderer，作为
  `editVersion`。同一消息只依赖单调递增，不要求版本连续，因而同一秒内连续编辑仍可排序。
- `deleteMessages` 在删除全局状态前生成 delete。普通私聊/群组没有显式 chat id 时，先从
  common message box 解析实际 chat；频道更新直接使用 update 携带的 chat id。
- scheduled、ephemeral 与 quick-reply 消息不进入长期消息 outbox。定时消息实际发出后会以
  普通 `newMessage` 进入；未发送的计划项不伪装成已投递消息。

消息快照包含正文、方向、发送者与会话显示名、同会话回复键、发送/编辑时间，以及图片、
视频、音频、语音、文件和贴纸的必要远端引用。它不包含 token、session、二维码、验证码、
2FA、control grant 或 Telegram 原始错误正文。

## 3. 持久队列

pending 与 dead-letter 使用独立 IndexedDB store。每条记录绑定 Telegram self user id，
Electron 的 `persist:native-<accountId>` partition 再提供物理隔离。退出或删除账号时，现有
主进程清理语义会清除对应 partition 的 storage 与 cache。

`eventId` 是账号 id 与事件语义键的 SHA-256 截断值：

- upsert：规范消息键 + edit version；没有 version 的已编辑历史快照使用 `editedAt`，初始快照
  使用 `base`
- delete：规范消息键
- remap：旧规范键 + 新规范键

相同平台事实在刷新、重放和 ACK 丢失后得到相同 `eventId`。同账号只有一个发送循环和一个
in-flight 事件，按首次入队顺序发送；事件间最少间隔 100ms。发送前先把 attempt 次数与下次
重试时间写回 IndexedDB，避免崩溃把退避状态回滚。发送泵自身也保持单一异步协程；IndexedDB
等待期间到达的新调度只登记下一次延迟，不能并发读取和发送同一个队首事件。

## 4. ACK、退避与容量

- `accepted=true`：删除 pending 记录。
- `accepted=false, retryable=true`：保留原记录和 event id，按 1s 起、最大 60s 的指数退避重试。
- 10s 未收到 ACK：按 ACK 丢失处理，保留记录并重试。
- `accepted=false, retryable=false`：移入 dead-letter，后续事件继续发送，不让一条永久失败
  阻塞整个账号。
- pending 和 dead-letter 各自上限为 1000。pending 满时新事件进入 dead-letter 并标记
  `outbox_capacity`；dead-letter 满时保留既有证据并上报 `dead_letter_capacity`，不静默清理
  已有失败记录。永久拒绝事件若因 dead-letter 已满而无法迁移，会保留在 pending 并暂停有序
  队列重试；这是一种明确的容量故障，不能通过丢弃事件来伪装恢复。

Bridge v3 另外提供两个不含消息正文的账号绑定运维命令：

- `outbox.retry-dead-letters` 按原始顺序把当前 Telegram identity 的 dead-letter 移回 pending，
  不超过 pending 容量。两个 IndexedDB database 之间无法做原子事务，因此实现顺序是先写 pending
  再删 dead-letter；异常退出最多留下可幂等收敛的重复证据，不能先删后写造成永久丢失。
- `outbox.discard-dead-letters` 只清除当前 identity 的 dead-letter，并把此前因
  `dead_letter_capacity` 暂停的队首唤醒。这是不可恢复的人工放弃动作，桌面端必须显示数量和明确
  警告并由用户再次确认；不能后台自动触发。

服务端现有幂等落库继续处理重复 upsert/delete/remap；409、429、5xx 和网络失败由 renderer
映射为 retryable ACK，结构、权限或规范键的永久拒绝进入 dead-letter。

## 5. 可观察性

Bridge v3 新增不含消息正文的 `outbox.status`，guest 用它报告：

- `pendingCount`
- `deadLetterCount`
- `isSending`
- `lastErrorCode`

外壳按账号保存指标，并在 TranslationDock 显示积压、永久失败或 IndexedDB 不可用提示。
存在 dead-letter 时提供“重试”和需确认的“清除记录”动作；命令只发给当前 im-hub 账号已登记的
guest。该提示不把原生 Composer 标成断开，也不阻塞后续 Telegram 发送和其他 outbox 事件。

## 6. 验证与剩余边界

截至 2026-08-28 的验证结果：

- im-hub：`pnpm typecheck` 通过；全量 `pnpm test` 为 34 个文件、332 个测试通过、1 个既有 todo；
  desktop build 通过；
  `git diff --check` 通过。
- telegram-tt：`npm run check:ts` 通过；当前 outbox、bridge、消息 reporter、空接收重连、既有
  WebSocket 和网络恢复图片降级共 6 个聚焦文件、13 个测试通过；`git diff --check` 通过。服务端
  native route 既有测试也在派生 `_test` 数据库通过。
- 两个不进入 Telegram 的永久拒绝哨兵首次暴露并发 pump 会重复发送队首、覆盖 ACK timer 的
  竞态；串行化发送泵后，每个事件只发送和 ACK 一次，队列从 pending 收敛到 dead-letter，等待
  超过 10 秒不再误报 `ack_timeout`。探针记录随后精确清理，partition 恢复为空。
- 真实普通群删除探针确认旧删除 RPC 已在 Telegram 平台侧异步成功；未及时回传的根因是
  GramJS `MTProtoSender._recvLoop` 在连接 `recv()` 返回空数据后访问 `body.length`，未捕获异常
  终止 worker 并显示 `waiting for network`。telegram-tt
  `675df80d8d4b287bd1afc2dfe544b70d796581f0` 把空数据纳入既有 reconnect 路径并增加单元回归。
- 完整冷启动后旧 `EDIT-10` 删除 update 经 `/api/native/events` 200 到达，数据库从
  `1 live / 0 deleted` 收敛为 `0 live / 1 deleted`。同一安全群中的一条删除专用新标记只确认
  一次“对所有人删除”后也从 Telegram 消失，outbox 为 `pending=0, dead=0`；但新标记没有中央
  数据库行，因此它只作为平台删除恢复证据，不伪装成新消息的完整 bridge 落库验收。
- 后续无外发诊断确认 guest 的缓存 identity 仍可让主进程进入 ready，但网络层持续收到
  `SESSION_REVOKED`。telegram-tt `ed09836f6b73544aa2d16d8645afa138827f0cbc` 让撤销/停用会话发布
  broken connection，再由现有 sign-out 与 `account.signed-out` 撤权；只有主连接初始化期间的
  `AUTH_KEY_UNREGISTERED` 保持跳过。
- 普通 outgoing 快照、final delete reporter 和服务端 native 落库自动测试均通过，本轮没有复现
  删除专用新标记的代码缺陷。已 ACK outbox 和服务端缺少 eventId 审计使历史 0 行无法唯一归因，
  该结果保持为不确定观察，不通过再次外发补证据。
- 安全目标发现确认当前普通群不是当前账号创建，已加载状态没有频道，且列表尚未完整加载；没有
  可证明为自建并可清理的频道/群。本轮没有执行频道编辑/删除或媒体外发，也没有创建新频道。

重新登录后的 2026-08-28 续验补充：

- 页面刷新保持登录、列表和 im-hub 连接；强制终止 Electron 主进程后冷启动也保持登录并恢复列表
  与 bridge，均未出现 pending、dead-letter、授权失败或持续转圈。
- 本地 ACK 丢失探针只对第一份成功 ACK 做丢弃，不进入 Telegram；同一稳定 eventId 第二次投递得到
  duplicate accepted，开发数据库最终只有一条消息和一个会话。探针行随后按固定 id 清理为 0。
- 用户选定只有本人、由本人控制的私密频道后，单次文本发送、同一行编辑、对所有人删除均经 bridge
  和数据库收敛；图片和文件分别生成非空远端媒体引用，随后由用户删除。语音按用户决定跳过，不能
  写成已验收。
- 真实 partition 的容量探针先写入 1000 条只含虚构规范键的 dead-letter，再加入一个只会被服务端
  422 永久拒绝且不会进入 Telegram 的事件。状态依次覆盖 `dead_letter_capacity`、明确清理后队首
  唤醒、`permanent_rejection` 和再次清理后的 `pending=0/dead=0`；开发数据库合成消息和会话均为 0。
- Wi-Fi 断开约 10–15 秒再恢复后，Telegram 列表和 im-hub 均自动恢复。恢复时一个失效 Blob 的装饰
  性图片取色触发开发版全局弹窗；telegram-tt `a279a6e` 对明确的图片解码错误降级到主题色，其他
  Worker 错误仍传播，并有单元回归。
- 数据库虽登记两个 Telegram 账号，但只有一个已绑定的真实 Telegram identity；在没有第二个真实
  登录身份时不能伪造“双账号同时积压”验收。
- 第一次真实回复标记在 Telegram 侧获得最终消息 id、成功状态和回复预览，remap/final upsert 也都
  得到 HTTP 200；但页面重启后复用的 local id 命中了旧的已删除 temp 行，导致最终 base upsert 被
  幂等层判成重复。该次数据库行仍是旧正文、旧时间和 deleted 状态，不能作为回复验收证据。
  telegram-tt 临时键现加入页面实例命名空间，shared/parser 保留旧键兼容。用户确认后的第二次真实
  回复已从两个隔离 worktree 冷启动验证：Telegram 中 final/reply preview 唯一，数据库 exact body、
  非空 reply key、唯一平台键、live 与出站方向均为 1，桌面壳没有 pending/dead/retry/rejected 提示。
  第一次错误行仍原样保留，没有用覆盖旧数据的方式制造通过结果。

本次用户重新登录后的会话已完成修复后回复复验；语音本轮明确跳过，双账号同时积压的 partition
隔离仍受缺少第二个登录 identity 阻塞。收尾日志另出现两次来源未定的 `SESSION_REVOKED` 字符串：
主 sender 的真实 RPC 会进入 broken 链，而非主 DC 文件 sender 超时也会构造同名普通 Error；当前
日志缺少类型/堆栈，所以下次不得预设登录健康或直接判定会话撤销，应先只读区分来源。快速连续编辑、
local/final remap、普通群删除、私密频道文本/编辑/删除、图片、文件、刷新、进程终止、ACK 丢失、
断网恢复和 dead-letter 容量恢复已有上述分级证据。
在这些证据写入 Issue #12 前，不关闭 Issue，也不宣称 M3-4 完整验收。

M3-5 仍负责 TDLib 与 telegram-tt 的 shadow reconciliation、历史缺口扫描，以及客户端未观察到
平台 update 时的主动修复；持久 outbox 只保证已经观察并成功写入 IndexedDB 的事件可靠补传。
