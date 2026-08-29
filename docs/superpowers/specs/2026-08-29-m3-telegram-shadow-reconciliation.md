# M3-5 Telegram 双来源 shadow 对账与切换门槛

日期：2026-08-29
状态：执行中；账本、报告、双真实账号 base/delete/edit、媒体/回复组合探针、outbox
终态、受限历史 coverage dry-run 及 TDLib 当前快照主动读取已验；观察周期和切换门槛待验

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

跨来源可比事实键必须在两个来源间可重现：

- 初始 upsert：`upsert:<canonical-message-id>:base`
- 编辑 upsert：`upsert:<canonical-message-id>:edited-at:<ISO-time>`。这是 TDLib 与
  telegram-tt 都能从 Telegram 服务端取得的修订时间；telegram-tt 的 MTProto `pts`
  继续用于消息落库、翻译和 outbox 排序，但不作为跨 SDK shadow 事实键
- 删除：`delete:<canonical-message-id>`

客户端发送阶段的 temp upsert 与 remap 不是 Telegram 服务端事实。TDLib 和 telegram-tt
各自生成不同的本地临时 id，不能要求另一 SDK 产生相同事实。账本仍以
`remap:<old-canonical-id>:<new-canonical-id>` 留下可追踪记录，但报告将 temp upsert 和
所有 remap 归为 `source_local`，不放进跨来源比较分母。最终数字消息 id 的 base/edit
upsert 仍必须比较，不得借 remap 名义掩盖真实单边缺口。

一条观测按 `(account_id, source, fact_key)` 幂等 upsert，记录首次/最后观测时间和
重复次数。重放和 ACK 丢失不会制造新的对账事实。

## 3. 语义指纹

观测账本不复制消息正文、原始 update 或任何会话凭据。upsert 只保存由下列字段
生成的 SHA-256 语义指纹：

- canonical conversation/message/reply 键
- 方向和 sender external id
- 正文的 SHA-256，不保存正文本身
- 媒体的 kind/file name/MIME/size 共同语义形状；不比较两个 SDK 不同的远端引用。
  照片和贴纸只比较双方稳定提供的 kind；无 filename attribute 时 telegram-tt 依据
  SDK 远端 id 生成的 `video…` / `audio…` / `file…` 展示名不进指纹，真实文件名仍比较
- 只比较同会话 reply canonical key；跨会话回复不猜测成当前会话消息
- 时间语义：入向消息与文本消息继续严格比较 `sentAt`；出向媒体在 telegram-tt 中是开始
  上传的本地时间、在 TDLib 中是平台接受上传后的服务端时间，因此不把该上传耗时写入
  跨 SDK 指纹。`editedAt` 仍同时进入 revision 和指纹；来源专属 edit version 不参与

Telegram 的 `edit_date` 是秒级时间。同一消息在同一秒内发生多次编辑时，shadow 账本
不会用伪造版本把它们拆开：相同事实键出现不同指纹会记为同源冲突，不能计入 matched。
telegram-tt 的 `pts` 仍保证中央消息和翻译只接受更高版本；该限制必须保留在切换评估中。

delete/remap 的事实键本身已经完整描述观测事实，指纹由事实键生成；其中 remap 仅作
来源本地追踪，不计作双来源一致性证据。

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
- `source_local`：temp upsert 或 remap，只属于单个 SDK 的发送生命周期，不参与跨来源比较。

报告同时返回各事件类型计数和有上限的样例 fact key，便于调查但不吐出正文。
`total` 包含全部可追踪事实，`comparableTotal` 排除 `source_local`；
`matched / comparableTotal` 也只是观测指标，不能单独触发旧链路清理。

### 4.1 受限历史 coverage dry-run

历史 coverage 扫描只读取中央 `messages` 和 shadow 观测账本，不调用 Telegram
`getChatHistory`，不启动第二个 TDLib client，也不补写、改写或删除消息和 shadow 事实。
调用必须指定账号和半开时间窗 `[sentAfter, sentBefore)`；单个时间窗最多 31 天，单页
`limit` 为 1～500。可选的 `conversationId` 是中央库会话 UUID，并再次校验属于该账号。
分页使用 `(sent_at, message UUID)` keyset cursor；cursor 绑定账号、会话和时间窗，报告返回
本页数、累计处理数、`hasMore` 和下一 cursor，不能把另一范围的 cursor 混用。

```bash
pnpm --filter @im-hub/server shadow-coverage \
  <account-uuid> <sent-after-iso> <sent-before-iso> [limit] [conversation-uuid|-] [cursor]
```

扫描只为最终数字消息构造中央库仍可证明的 expected facts：base、当前保存的最后一次 edit
以及 delete。中央消息表没有历史正文版本，不能据此重建更早编辑；临时消息事实继续归为
`sourceLocal`。每个账号最早的 `first_observed_at` 是保守 coverage 起点：没有账本事实且事件
早于该时间的项目归为 `preObservation`，之后才归为 `missing`；账号完全没有 shadow 基线时
归为 `coverageUnavailable`，不得把空账本写成通过。已有观测继续按 `matched`、`mismatched`、
`tdlibOnly`、`telegramTtOnly` 分类。

dry-run 同时输出修复性质，但不执行修复。`currentSnapshotFetchable` 只表示当前未删除平台
快照以后可以由真实来源重新读取，不授权伪造缺失来源；已删除事件和被后续 edit 覆盖的 base
归为 `historicalEventUnrecoverable`，mismatch 归为 `manualInvestigation`。输出只有聚合计数、
游标和有上限的 fact key 样本，不含正文、raw、账号平台身份、令牌或会话凭据。

2026-08-29 对双真实账号覆盖全部现有消息的首次 dry-run 已完成。发送端扫描 24 条消息，
其中 23 条最终消息、1 条 source-local 临时消息；37 个 expected facts 中 14 个进入可比分母，
结果为 `matched=12 / mismatched=1 / telegramTtOnly=1 / missing=0`，另有
`preObservation=22 / sourceLocal=1`。mismatch 仍是修正前 S5 base，单边仍是 TDLib
`pending_auth` 时的 S1。接收端扫描 11 条消息，其中 10 条最终消息、1 条 source-local；
17 个 expected facts 中 14 个可比，结果为 `matched=11 / tdlibOnly=3 / missing=0`，另有
`preObservation=2 / sourceLocal=1`。三个单边仍是 S2 预挂载修复前的 delete，均被明确标为
历史事件不可恢复。本次没有平台拉取和数据库写入。

### 4.2 受限 TDLib 当前快照主动读取

主动读取只处理 coverage 当前页中同时满足下列条件的消息：状态为 `telegramTtOnly` 或
`missing`、修复性质为 `currentSnapshotFetchable`、消息 id 是最终 server canonical key。
`tdlibOnly` 不会被 TDLib 重读冒充 telegram-tt 来源；已删除、被编辑覆盖的旧 base、
`preObservation`、`sourceLocal` 和 mismatch 都不会进入动作列表。

服务端提供 `POST /api/accounts/:id/telegram-shadow-refresh`。请求默认为 `dry_run`；单页上限
进一步收紧为 10。执行模式必须由账号 owner 本人提交 `mode=refresh_tdlib` 和固定确认串
`REFRESH_TDLIB_SHADOW`，账号必须为 connected Telegram。manager 即使能看到下属账号也不能
操作其平台会话，auditor 不能执行写操作；可选会话仍须属于该账号。

执行复用服务器进程中该账号已经连接的唯一 TDLib client，对 dry-run 选出的精确 id 逐条
调用 `getMessage`，不调用 `getChatHistory`，不新建 session。单条读取最多等待 5 秒，同账号
同一时间只允许一个 refresh，单次最多 10 条，不自动重试。只有真实 TDLib 返回、能够归一化
且 canonical id 与请求一致的快照，才通过统一 ingestor 以硬编码 `tdlib` 来源幂等写入；调用方
不能传 source。响应返回 before coverage、`requested/found/recorded/unavailable/unsupported/
failed` 进度和 after coverage，且不返回消息正文或 raw。

2026-08-29 首次真实主动读取只命中发送端已解释的 S1：三页 dry-run 以 `10 + 10 + 4`
处理完 24 条消息，第一页唯一候选、其余页为 0，所有页 `missing=0`。显式执行结果为
`requested=1 / found=1 / recorded=1 / unavailable=0 / unsupported=0 / failed=0`；同页从
`matched=12 / telegramTtOnly=1` 收敛为 `matched=13 / telegramTtOnly=0`，旧 S5 base
`mismatched=1` 原样保留。72 小时正式报告为 `total=30 / comparableTotal=14 / matched=13 /
mismatched=1 / tdlibOnly=0 / telegramTtOnly=0 / sourceLocal=16 / unstable=0`。中央消息仍为
24 条，`edited=5 / deleted=8 / media=5 / replies=2`；主动读取没有发送、编辑、删除或新增消息。
接收端复核仍为 `matched=11 / tdlibOnly=3 / missing=0`，且
`tdlibRefreshCandidateCount=0`，证明三个不可恢复 delete 不会被误选。

## 5. 切换门槛与后续 checkpoint

M3-5 按下列顺序续验：

1. 观测账本、静默窗口报告与自动回归。
2. 用既有安全消息 fixture 开启双链路 shadow，先解释每个单边或不一致样本。
   双真实账号的接收/发送最终 base upsert 已获得 matched 证据；telegram-tt 临时
   upsert/remap 是发送端本地生命周期，必须单独分类而不伪装为 base 差异。
3. 补齐 TDLib 编辑、删除、媒体、回复和 remap 观测；不通过降低双方共同语义要求制造一致。
   delete 代码与自动回归已完成；真实 S2 证明发送分区三个 delete matched，也暴露接收
   webview 未创建时三个 TDLib-only 缺口。宿主预挂载修复后，单个 S3 shadow 专用
   fixture 在接收 pane 始终隐藏时，发送/接收的 base 与 delete 均获得 matched，两个
   outbox 均收敛为 `0/0`。delete 路径的该缺口已关闭。edit 自动路径现会在 TDLib
   `updateMessageContent` 后读取完整消息，以 `edit_date` 生成 `editedAt` 快照；跨来源
   fact key/指纹回归已固定为忽略 `pts` 的可比较语义。单个 S4 先发送一次、再编辑同一条
   一次后，发送/接收账号的 base 与 edit 均由两来源以相同指纹观测，无 mismatch、单边或
   同源冲突；中央库两账号各保持一行。用户逐一切换两账号后，输入坞均无 pending/dead-letter
   非零提示，对应两个 outbox `0/0`。S4 保留未删除，后续删除必须另获用户明确同意。
   TDLib 归一化现覆盖图片、视频、音频、语音、文件、贴纸、圆形视频、动画及同会话回复；
   图片/贴纸和 SDK 自动文件名按上述共同语义收敛。报告现把 temp/remap 明确归为
   `source_local`。自动回归已完成。单条 S5 已以“带 caption 的图片并回复既有 S4”完成
   组合探针：两账号均只有一条 image/caption/reply 最终行，接收端 base 两来源同 hash；
   发送端首次暴露 telegram-tt 上传开始时间比 TDLib 平台接受时间早 3 秒。字段级只读诊断
   排除了图片、caption、reply、sender 和方向差异，修正后只忽略出向媒体上传耗时，入向
   媒体与文本时间仍严格比较。用户随后只把同一条 S5 caption 编辑一次；两账号仍各一条
   image+reply 消息，新的 edited-at fact 均为两来源同 hash、无冲突。发送端修正前 base
   mismatch 保留为已解释的算法发现证据，不改写账本；接收端 base/edit 均 matched。
   用户逐一切换两个账户后，输入坞均无 pending/dead-letter 非零提示，两个 outbox `0/0`。
   本次没有新增消息，也没有重做 M3-4 的媒体、回复或故障矩阵。
4. 受限历史 coverage dry-run 与 TDLib 当前快照主动读取已按账号/可选会话/时间/数量和
   keyset 进度边界完成；不可恢复历史不倒填，缺失的 telegram-tt 来源不由 TDLib 冒充。
5. 复用 M3-4 已完成的多账号和故障证据，只执行 shadow 特有的差异/恢复矩阵。
6. 定义灰度开关、观察周期、一致率门槛和回滚步骤。在门槛证据完成前不停用 TDLib。

PR #19 和 Issue #12 保持原状。M3-5 工作使用独立分支并回写 Issue #13，不将
shadow 实现追加到 PR #19。
