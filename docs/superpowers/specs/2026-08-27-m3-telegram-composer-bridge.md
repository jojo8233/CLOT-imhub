# M3-3 Telegram 原生 Composer typed bridge

日期：2026-08-27
状态：代码已实现；真实 Telegram 账号联调与 message outbox/shadow 对账仍待后续验收

## 1. 范围

本阶段把 Electron 外层 `TranslationDock` 接到 telegram-tt 当前可见的原生 Composer，
并移除 fork 内的 `ImHubComposer` 重复翻译输入区。外壳是唯一翻译 UI；Telegram 原生
Composer 继续是草稿、回复引用、附件、限流和实际发送的事实来源。

本阶段不实现消息 upsert/edit/delete outbox、ACK 重试或 TDLib/fork shadow 对账。这些
仍属于 M3-4/M3-5，不能因为 Composer 已可控就写成 Telegram 存档闭环已经完成。

## 2. 授权后的状态握手

guest 页面可能早于五分钟 account-control grant 建立就完成渲染。主进程会丢弃授权前的
会话和 Composer 事件，因此 host 在控制状态变为 `ready` 后发送
`bridge.request-state`。telegram-tt 收到后以当前 revision 重发 `context.changed` 和
`composer.state`；它不重发 `bridge.ready/account.identity`，避免 ready 状态互相触发形成
握手循环。

`bridge.request-state` 只在已经通过主进程 grant、partition、宿主 webContents 和 Telegram
self user id 校验后才会进入 guest。它不携带 JWT、grant 或账号 UUID。

## 3. 会话 revision

telegram-tt 只登记当前消息列表对应的 Composer：

- `platformConversationId` 使用规范 Telegram `chatId`，以便与 canonical message id 的 chat
  部分保持一致。
- 私聊和群组当前都以 `chatId` 作为 `contactExternalId`，展示名取 Telegram 当前 chat title。
- chat 或 forum topic 改变都会卸载旧登记并递增 `contextRevision`；topic 不另造会话 id，
  但旧 topic revision 的命令不能进入新 topic。
- 没有活跃 Composer 时发送 `context.changed { context: null }`。

guest 在执行每个 set/get/send 命令前同时校验 revision、chat id 和当前 Composer 对象。录音
停止等异步步骤结束后、真正进入原生发送前还会再校验一次，避免切换期间的旧命令继续发送。

## 4. 草稿与可发送状态

`composer.set-draft` 使用原生 rich editor 的 `replaceValue`，`composer.get-draft` 从同一个
editor 读取员工当前看到并可能修改过的最终文本。telegram-tt 在草稿或原生门禁变化时发送
`composer.state`；编辑消息、scheduled list、账号冻结或原生文本禁发时 `canSend=false`。

外层发送仍先 get draft，不把 TranslationDock 缓存的译文当作最终发送内容。切换账号、chat
或 topic 后，迟到的 get/set/send 结果会被 context 校验丢弃。

## 5. 稳定发送 attempt 与最终结果

一次逻辑发送在外壳内生成稳定 `attemptId`，并与当时读取到的最终原生草稿保存在 renderer
内存。telegram-tt 对同一 attempt 只启动一次原生 `handleSend`：重复命令加入同一 pending
attempt，完成后直接重放缓存结果，不再次点击发送。

原生发送参数内部携带非敏感的 `imHubAttemptId`。GramJS 创建本地回显时把它随
`newMessage/newScheduledMessage` update 返回 renderer，从而精确绑定本地临时 id；该字段不
进入 MTProto 请求。结果按下列事实收敛：

- `updateMessageSendSucceeded` / scheduled succeeded：把最终 MTProto id 规范化为
  `<chatId>:<serverMessageId>`；同一次附件组全部成功后回 `ok=true`。
- send failed update：回脱敏的明确失败；Telegram 原始错误正文不进入 bridge。
- 附件组部分成功：回 `partial_send_failed`，不能把部分投递谎报成完整成功。
- host 等待八秒仍无结果：外壳标记“结果未知”，保留 attempt。重试直接用同一 attempt 查询
  guest 缓存，不依赖已经被原生发送流程清空的输入框，也不会生成第二次发送。

attempt 缓存当前只在 telegram-tt 页面内存中保留，最多保留最近 100 个已完成结果。页面崩溃
后的恢复与持久化 outbox 是后续阶段边界。

## 6. UI 与兼容边界

telegram-tt 不再挂载或保留 `ImHubComposer` 及其 SCSS；没有新增 fork 内产品文案。
TranslationDock 继续位于 Electron 外壳中。typed bridge 仍调用既有 Composer 的
`handleSend`/`sendMessage` 链，普通点击发送不携带 attempt 字段，回复、附件、静默、定时、
付费确认和上游发送参数的原行为不变。

## 7. 自动验证与未验收项

自动检查覆盖 host 状态请求解析、命令错误码、旧 revision、最终草稿读取、稳定 attempt
复用、输入框已清空后的结果查询和 store 隔离。提交前要求：

- im-hub：`pnpm typecheck`、相关 desktop 测试、全量 `pnpm test`、desktop build。
- telegram-tt：`npm run check:ts`；按 fork 规则不新增测试文件。

以下仍必须用真实账号验收：私聊、群组、频道、forum topic 切换；回复、附件、静默和定时
发送；网络超时后的相同 attempt 查询；多账号 partition 隔离。未经这些验证，Issue #11
和 Telegram 完整闭环都不应关闭。
