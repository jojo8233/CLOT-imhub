# M3-5 Telegram 双来源 shadow 对账与切换门槛

日期：2026-08-29
状态：执行中；账本、报告、双真实账号 base/delete/edit 已验，其余生命周期和切换门槛待验

## 1. 目标与非目标

TDLib 适配器和 telegram-tt message outbox 在同一个 Telegram 账号上同时运行时，
中央库的 canonical 键幂等只能证明最终没有多出一行，不能证明两条链路都看到了同一
个平台事实，也不能解释哪条链路丢失、延迟或上报了不同内容。M3-5 因此先建立独立
的 shadow 观测账本，再以稳定报告驱动历史缺口扫描、主动修复、灰度和回滚。

本阶段不删除 TDLib 适配器，不把 telegram-tt 提前标成唯一消息来源，不清理平台
会话、登录 partition 或 outbox，也不重复 M3-4 已完成的故障矩阵。

## 2. 事实键与来源

观测来源只允许：

- `tdlib`：服务端 Telegram 适配器观察到的 update。
- `telegram-tt`：补丁客户端经过持久 outbox 和 native control grant 上报的事件。

事实键必须在两个来源间可重现：

- 初始 upsert：`upsert:<canonical-message-id>:base`
- 编辑 upsert：`upsert:<canonical-message-id>:edited-at:<ISO-time>`。这是 TDLib 与
  telegram-tt 都能从 Telegram 服务端取得的修订时间；telegram-tt 的 MTProto `pts`
  继续用于消息落库、翻译和 outbox 排序，但不作为跨 SDK shadow 事实键
- 删除：`delete:<canonical-message-id>`
- 重映射：`remap:<old-canonical-id>:<new-canonical-id>`

一条观测按 `(account_id, source, fact_key)` 幂等 upsert，记录首次/最后观测时间和
重复次数。重放和 ACK 丢失不会制造新的对账事实。

## 3. 语义指纹

观测账本不复制消息正文、原始 update 或任何会话凭据。upsert 只保存由下列字段
生成的 SHA-256 语义指纹：

- canonical conversation/message/reply 键
- 方向和 sender external id
- 正文的 SHA-256，不保存正文本身
- 媒体的 kind/file name/MIME/size 语义形状；不比较两个 SDK 不同的远端引用
- sent/edit 时间；来源专属的 edit version 不参与跨来源指纹

Telegram 的 `edit_date` 是秒级时间。同一消息在同一秒内发生多次编辑时，shadow 账本
不会用伪造版本把它们拆开：相同事实键出现不同指纹会记为同源冲突，不能计入 matched。
telegram-tt 的 `pts` 仍保证中央消息和翻译只接受更高版本；该限制必须保留在切换评估中。

delete/remap 的事实键本身已经完整描述平台事实，指纹由事实键生成。

TDLib 的 `updateDeleteMessages` 现已进入同一 delete 事实键。`from_cache=true`
只表示本地缓存淘汰，不得将中央消息标为删除；其他服务端下发的账号内删除
则代表当前账号视图的真实事实。消息 `deleted_at` 与 shadow 观测必须在同一事务内写入。

真实 S2 delete 证据说明，telegram-tt outbox 只能持久化 webview 实际观察到的 update。
若宿主恢复后只创建 active 账号，未打开账号在删除期间没有 webview；事后加载最终
状态不能反推并伪造历史 delete 事实。因此宿主恢复会话后必须预挂载当前 owner
的所有已支持账号，每个隐藏 pane 仍使用自己的 partition、control grant 和 outbox。
授权收回或账号移除时必须立即卸载，不得为了后台观测绕过 owner/auditor 边界。

## 4. 一致性报告

报告只统计早于静默窗口的事实，防止把正常网络时序误报成丢失。每个 fact key
归入且只归入一类：

- `matched`：两条链路均观测且语义指纹相同。
- `mismatched`：两条链路均观测，但指纹不同。
- `tdlib_only`：只有 TDLib 观测。
- `telegram_tt_only`：只有 telegram-tt 观测。

报告同时返回各事件类型计数和有上限的样例 fact key，便于调查但不吐出正文。
`matched / total` 只是观测指标，不能单独触发旧链路清理。

## 5. 切换门槛与后续 checkpoint

M3-5 按下列顺序续验：

1. 观测账本、静默窗口报告与自动回归。
2. 用既有安全消息 fixture 开启双链路 shadow，先解释每个单边或不一致样本。
   双真实账号的接收/发送最终 base upsert 已获得 matched 证据；telegram-tt 临时
   upsert/remap 是发送端本地生命周期，必须单独分类而不伪装为 base 差异。
3. 补齐 TDLib 编辑、删除、媒体、回复和 remap 观测；不通过降低指纹要求制造一致。
   delete 代码与自动回归已完成；真实 S2 证明发送分区三个 delete matched，也暴露接收
   webview 未创建时三个 TDLib-only 缺口。宿主预挂载修复后，单个 S3 shadow 专用
   fixture 在接收 pane 始终隐藏时，发送/接收的 base 与 delete 均获得 matched，两个
   outbox 均收敛为 `0/0`。delete 路径的该缺口已关闭。edit 自动路径现会在 TDLib
   `updateMessageContent` 后读取完整消息，以 `edit_date` 生成 `editedAt` 快照；跨来源
   fact key/指纹回归已固定为忽略 `pts` 的可比较语义。单个 S4 先发送一次、再编辑同一条
   一次后，发送/接收账号的 base 与 edit 均由两来源以相同指纹观测，无 mismatch、单边或
   同源冲突；中央库两账号各保持一行。S4 保留未删除，后续删除必须另获用户明确同意。
4. 增加受限的历史扫描和主动修复；扫描必须有账号/会话边界、数量上限和可观测进度。
5. 复用 M3-4 已完成的多账号和故障证据，只执行 shadow 特有的差异/恢复矩阵。
6. 定义灰度开关、观察周期、一致率门槛和回滚步骤。在门槛证据完成前不停用 TDLib。

PR #19 和 Issue #12 保持原状。M3-5 工作使用独立分支并回写 Issue #13，不将
shadow 实现追加到 PR #19。
