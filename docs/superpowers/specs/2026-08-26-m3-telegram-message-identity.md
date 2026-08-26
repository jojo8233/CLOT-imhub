# M3 Telegram 消息身份与 Bridge v2

日期：2026-08-26
状态：M3-1 基础已实现；telegram-tt 消息 outbox、真实账号 fixture 与 shadow 对账仍待后续 Issue

## 1. 目标

在 telegram-tt 开始回传消息前，先统一 TDLib 与 MTProto 的消息身份，避免同一条消息
从后台适配器和原生客户端两条链路进入时落成两行。同时补齐 Bridge v2 后续账号绑定、
发送幂等和连续编辑排序需要的协议字段。

## 2. Canonical Telegram ID

最终消息键固定为：

```text
<chatId>:<MTProto serverMessageId>
```

- `chatId` 使用 Telegram/TDLib 的规范十进制 dialog id；私聊为正数，普通群/频道为负数。
- telegram-tt 的服务器消息 id 已是 MTProto int32，直接使用。
- TDLib 的服务器 `message.id` 为 `serverMessageId << 20`；只有正数且低 20 位全为 0
  时才能右移。该布局以 TDLib 官方 `td/telegram/MessageId.h` 为事实来源。
- TDLib 本地消息键为 `<chatId>:temp:tdlib:<localId>`。
- telegram-tt 本地小数消息键为 `<chatId>:temp:telegram-tt:<localId>`。
- 发送成功后只能通过 `message.id-remapped` 把同一 chat 的临时键改成最终键。
- reply、delete 和 remap 两端全部使用同一算法；跨 chat remap 永久拒绝。

共享实现位于 `packages/shared/src/telegram-message-id.ts`。TDLib normalize 和
`TelegramAdapter.sendMessage` 已改用该实现；telegram-tt fork 在 `src/util/imhub.ts`
保留等价的 MTProto 侧构造与解析函数，待 outbox 接线时直接调用。

## 3. 数据迁移

`0005_telegram_canonical_message_ids`：

- 增加 `messages.edit_version integer null` 与非负约束。
- 把旧 TDLib 最终 id 转为 `<chatId>:<id >> 20>`。
- 把旧 TDLib 本地 id 转入 `temp:tdlib` 命名空间。
- 同步迁移数字型 `reply_to_platform_message_id`。
- 改写前把旧 TDLib id 写入 `message_id_aliases`，兼容迁移前已排队的迟到事件。
- 未知格式、非法 chat、零 id、越界 id、direct/alias 冲突或迁移后键冲突会中止迁移，
  不静默猜测或合并。

down migration 不反向改回账号范围 TDLib id，因为那会重新制造跨 chat 冲突并破坏
telegram-tt 已写入的数据；只移除 `edit_version` 列，canonical id 与兼容 alias 保留。

## 4. Bridge v2

协议版本从 1 升到 2：

- 新增 `account.identity { platformAccountExternalId }`，Telegram 使用当前登录 user id；
  M3-2 用它和 account-control grant 做实际账号绑定。
- `composer.send` 必须携带稳定 `attemptId`，`command.result` 必须原样回显；结果未知后的
  重试沿用同一个 attempt，不能生成新值后盲发。
- `message.upsert.message.editVersion` 为必填 nullable 字段。非 null 时必须是
  `0..2147483647` 的单调整数且同时提供 `editedAt`。
- 服务端一旦收到 versioned edit，后续无版本或更小版本不能覆盖；翻译 revision 使用
  `version:<n>`，同一秒内连续编辑也不会共用旧任务。

协议升级是断开式升级：v1 frame 会被运行时校验拒绝，telegram-tt 接线必须一次性发送 v2。

## 5. 验证边界

已自动覆盖 shared canonical 算法、TDLib normalize、Bridge 运行时校验、稳定 attemptId、
单调 editVersion、服务端 canonical 拒绝和 repo 翻译 revision。0005 migration 已在
`imhub_test` 用合成的旧最终/临时/reply 数据执行并断言结果与旧 alias。

仍未宣称完成：真实 Telegram 账号的私聊/群/频道/topic 双来源 fixture、telegram-tt
消息 outbox、ACK/重试、TDLib + fork shadow 对账。这些分别由 M3-4/M3-5 验收。
