# M3-4 Telegram 持久事件 outbox 与可靠回传

日期：2026-08-27
状态：代码与自动验证已完成；真实账号故障矩阵仍需完成

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
  `<chatId>:temp:telegram-tt:<localId>`。
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

服务端现有幂等落库继续处理重复 upsert/delete/remap；409、429、5xx 和网络失败由 renderer
映射为 retryable ACK，结构、权限或规范键的永久拒绝进入 dead-letter。

## 5. 可观察性

Bridge v3 新增不含消息正文的 `outbox.status`，guest 用它报告：

- `pendingCount`
- `deadLetterCount`
- `isSending`
- `lastErrorCode`

外壳按账号保存指标，并在 TranslationDock 显示积压、永久失败或 IndexedDB 不可用提示。
该提示不把原生 Composer 标成断开，也不阻塞后续 Telegram 发送和其他 outbox 事件。

## 6. 验证与剩余边界

2026-08-27 自动验证结果：

- im-hub：`pnpm typecheck` 通过；desktop 9 个测试文件、65 个测试通过；全量
  `pnpm test` 为 34 个文件、331 个测试通过、1 个既有 todo；desktop build 通过；
  `git diff --check` 通过。
- telegram-tt：`npm run check:ts` 通过；既有 `src/util/imhub.test.ts` 1 个聚焦测试通过；
  `git diff --check` 通过。依照仓库约定，没有为本补丁新增测试文件。
- 两个不进入 Telegram 的永久拒绝哨兵首次暴露并发 pump 会重复发送队首、覆盖 ACK timer 的
  竞态；串行化发送泵后，每个事件只发送和 ACK 一次，队列从 pending 收敛到 dead-letter，等待
  超过 10 秒不再误报 `ack_timeout`。探针记录随后精确清理，partition 恢复为空。
- 真实普通群删除探针只选择此前 M3 创建且可唯一识别的自己发出的测试消息，并两次确认
  `Delete for everyone`，其中一次在完整重启 Electron 后执行。目标消息仍存在，服务端也没有
  收到 `/api/native/events`；流程期间还出现开发态 worker 的
  `Cannot read properties of undefined (reading 'length')` 和短暂 `waiting for network`。因此删除
  在 Telegram 客户端/平台更新之前被阻断，这不是 `message.deleted` outbox 成功或失败的传输
  证据。
- 安全目标发现确认当前普通群不是当前账号创建，已加载状态没有频道，且列表尚未完整加载；没有
  可证明为自建并可清理的频道/群。本轮没有执行频道编辑/删除或媒体外发，也没有创建新频道。

仍需真实账号故障矩阵：断网后恢复、页面刷新、Electron 进程终止、ACK 丢失、普通与频道删除、
频道编辑、图片/文件/语音，以及两个账号同时积压时的 partition 隔离。快速连续编辑和
local/final remap 已有成功证据；普通群删除已有客户端阻断证据，但尚未产生可供 outbox 验收的
平台 update。
在这些证据写入 Issue #12 前，不关闭 Issue，也不宣称 M3-4 完整验收。

M3-5 仍负责 TDLib 与 telegram-tt 的 shadow reconciliation、历史缺口扫描，以及客户端未观察到
平台 update 时的主动修复；持久 outbox 只保证已经观察并成功写入 IndexedDB 的事件可靠补传。
