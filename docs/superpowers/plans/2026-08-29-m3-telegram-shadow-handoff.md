# M3-5 Telegram shadow reconciliation 交接记录

日期：2026-08-29

## 最新续验 checkpoint：逐账号 TDLib shadow-only 灰度与回滚门槛

- 新增默认空的 `TELEGRAM_TDLIB_SHADOW_ACCOUNT_IDS`。它只接受逗号分隔、去重后的内部账号
  UUID；空值保持所有账号现有 TDLib 中央入库。无 `all` 或全局关闭捷径，错误 UUID 会阻止
  服务启动而不是扩大灰度。本机真实运行环境没有改动，两个真实账号当前仍是 active。
- allowlist 内 Telegram 账号的 TDLib client 继续连接；upsert/edit、delete、remap 只以真实
  `tdlib` 来源写 shadow 账本，不再改变中央消息投影或推送 UI。telegram-tt 仍正常中央入库。
  manager 现在把事件所属平台一并交给组合根，Signal 等其他平台不会被 Telegram 灰度误拦截。
- 回滚复用 owner-only `telegram-shadow-refresh`，新增 `mode=rollback_tdlib`。它要求账号
  connected、固定确认串 `ROLLBACK_TDLIB_INGEST` 和 1～10 个去重后的最终 canonical 消息 id；
  只用现有 TDLib client 精确 `getMessage` 并以硬编码 `tdlib` 来源进入统一 ingestor，不遍历
  历史、不接受 temp id、不伪造已删除事实。
- 推进门槛固定为：发布后 active 连续观察 7 天；至少 2 个账号、累计至少 100 个可比事实，且
  覆盖 base/edit/delete/media/reply；120 秒静默后的窗口必须 `matched/comparable=100%`，
  `mismatched/tdlibOnly/telegramTtOnly/unstable/missing/coverageUnavailable=0`，主动读取候选和
  failed 均为 0，telegram-tt outbox `dead=0` 且无超过 5 分钟的 pending。历史
  `preObservation`/`sourceLocal` 和窗口外已解释证据不进分母。
- 放量顺序为单账号 24 小时、最多 10% 账号 72 小时、50% 账号 72 小时、100% 账号 7 天；
  每级重新从零计时。任何已静默单边/不一致、coverage 缺口、dead-letter、超时 pending、
  control grant 丢失或账号非 connected 都立即回滚受影响 cohort，不等待阶段结束。
- 回滚先从 allowlist 移除账号并重启恢复 TDLib 中央入库，再按灰度窗口报告中的最终
  `tdlib_only` upsert id 分批执行精确恢复。`unavailable/unsupported/failed` 任一非零即停止；
  delete 或被覆盖的历史事件不倒填，转人工事件调查并重新开始新的 active 观察窗。
- 新增 rollout 单元回归及 manager 平台来源回归；灰度/路由 23 tests、refresh route/service
  11 tests、根级 `pnpm typecheck`、`git diff --check` 及全量 41 文件 380 tests（另 1 个既有
  todo）已通过。尚未真正开启 canary，也没有发送、编辑或删除任何 Telegram 消息。

## 最新续验 checkpoint：S1 受限 TDLib 主动读取已收敛

- coverage 报告现只把 `telegramTtOnly`/`missing` 且仍能取得当前快照的最终消息列入
  `actions.tdlibRefreshCandidates`；`tdlibOnly`、delete、被 edit 覆盖的 base、
  `preObservation`、`sourceLocal` 和 mismatch 不会进入 TDLib 动作列表。
- 新增 owner-only `POST /api/accounts/:id/telegram-shadow-refresh`。默认 `dry_run`；执行必须
  同时提交 `mode=refresh_tdlib`、固定确认串并要求 Telegram 账号 connected。manager 可见不
  等于能操作，auditor 只读；可选 conversation 必须属于账号。
- 执行复用服务端现有唯一 TDLib client，只对精确最终 id 做 `getMessage`；不遍历历史、不创建
  第二 client。单次最多 10 条、逐条 5 秒超时、同账号禁止并发且不自动重试。只有真实返回且
  id 一致的规范快照才由统一 ingestor 以硬编码 `tdlib` 来源幂等入账，调用方不能伪造来源。
- 真实发送账号的 owner 接口 dry-run 用三页 `10 + 10 + 4` 扫完 24 条消息，第一页只有 1 个
  候选、后两页为 0，三页均 `missing=0`。唯一候选是已解释的 S1，不是旧 S2 delete 或 S5
  mismatch。
- 显式主动读取结果为 `requested=1 / found=1 / recorded=1 / unavailable=0 / unsupported=0 /
  failed=0`；同页从 `matched=12 / telegramTtOnly=1` 变为 `matched=13 / telegramTtOnly=0`，
  S5 旧 base 仍为唯一 mismatch。72 小时正式报告为 `total=30 / comparableTotal=14 /
  matched=13 / mismatched=1 / tdlibOnly=0 / telegramTtOnly=0 / sourceLocal=16 / unstable=0`。
- 只读终态确认发送账号中央消息仍为 24 条，`edited=5 / deleted=8 / media=5 / replies=2`；
  shadow source row 增加的是实际 TDLib S1 观测。没有发送、编辑、删除消息，没有触碰
  S4/S5/A1/A2，也没有倒填不可恢复历史。接收端仍为三个已解释 `tdlibOnly` delete，
  `tdlibRefreshCandidateCount=0`。
- 主动读取、adapter 路由、来源固定、部分失败、10 条上限、owner/auditor/manager 门禁、显式
  确认、connected 状态、conversation 归属和输入/数据库错误分类的定向 5 文件 34 tests、
  根级 `pnpm typecheck`、`git diff --check` 和全量 40 文件 373 tests（另 1 个既有 todo）
  均已通过。下一步提交后定义
  观察周期、一致率与回滚门槛；TDLib 仍不得退出。

## 最新续验 checkpoint：受限历史 coverage dry-run 已完成

- 新增只读命令 `pnpm --filter @im-hub/server shadow-coverage <account-uuid>
  <sent-after-iso> <sent-before-iso> [limit] [conversation-uuid|-] [cursor]`。它只查中央消息和
  shadow 账本，不调用平台历史接口、不启动额外 TDLib client，也不写数据库。
- 账号必填；可选会话 UUID 必须属于该账号；时间窗是半开区间且最多 31 天；单页硬上限
  500。分页 cursor 使用 `(sent_at, message UUID)` keyset 并绑定账号/会话/时间窗；输出
  `processedMessages / pageMessages / hasMore / nextCursor`，可继续观察进度。
- 扫描按中央库仍可证明的 base、当前最后一次 edit 和 delete 构造 expected facts。无事实且
  早于账号最早 shadow 观测的历史归为 `preObservation`，较新的才是 `missing`；无任何账本
  基线时归为 `coverageUnavailable`；temp 行归为 `sourceLocal`。不会用当前消息快照伪造已
  被覆盖的旧 edit/base，也不会反推历史 delete。
- dry-run 的 `currentSnapshotFetchable` 只是下一阶段可重新读取当前平台快照的候选，不代表
  可以伪造缺失来源。delete/被 edit 覆盖的 base 是 `historicalEventUnrecoverable`，mismatch
  需要 `manualInvestigation`。命令不输出正文、raw、账号平台身份或凭据。
- 自动回归覆盖分类、会话边界、31 天时间上限、500 行上限、scope-bound cursor 和分页进度；
  coverage + 既有 shadow 三个测试文件共 14 tests 通过，根级 `pnpm typecheck` 通过；全量
  38 文件 362 tests（另 1 个既有 todo）通过。
- 双真实账号只读 dry-run 已覆盖现有记录且单页完成。发送端 24 条消息、37 个 expected facts，
  可比 14 个：`matched=12 / mismatched=1 / telegramTtOnly=1 / missing=0`，另有
  `preObservation=22 / sourceLocal=1`；已解释项仍仅为修正前 S5 base 与 S1 pending_auth。
  接收端 11 条消息、17 个 expected facts，可比 14 个：`matched=11 / tdlibOnly=3 /
  missing=0`，另有 `preObservation=2 / sourceLocal=1`；三个单边仍仅为 S2 预挂载前 delete，
  均标为历史不可恢复。本次未拉平台、未写开发库、未触碰 S4/S5/A1/A2。
- 下一步是设计并实现只处理 `currentSnapshotFetchable` 的受限主动读取，保持实际来源并提供
  dry-run/执行开关、幂等、速率、进度和停止条件；不可恢复历史只保留解释，不倒填。

## 最新 checkpoint

- 用户在 S5 edit 正式报告完成后逐一切换两个账户检查输入坞，两边均未出现“消息回传队列
  待处理”或“永久失败事件”提示。结合两个 owner webview 已验证的 bridge/control grant
  和两来源 edit fact 均已到达，对应两个 outbox `pending=0 / dead=0`。S5 的
  image+caption+same-chat reply+edit checkpoint 已完整关闭。
- 用户只把同一条 S5 图片消息的 caption 编辑一次为
  `IMHUB-M3-SHADOW-20260829-S5-EDITED`，没有重发或删除。两账号中央库仍各一行，均保留
  `media_count=1 / kind=image / reply=true / deleted=false`；旧 caption 行数为 0，两个账号
  使用同一个服务端 `editedAt=2026-08-29T06:36:30.000Z`。
- 发送账号的新 edited-at fact 立即收敛为 `sources=2 / hashes=1 / conflict=false`。接收账号
  先到 TDLib，telegram-tt 在约 60 秒后到达，随后也为 `sources=2 / hashes=1 /
  conflict=false`；这是静默窗口内的正常隐藏 pane 时序，不是单边丢失。
- 跨过 120 秒后的正式报告：发送端 `total=30 / comparableTotal=14 / matched=12 /
  mismatched=1 / telegramTtOnly=1 / sourceLocal=16 / unstable=0`，新增 edit 已 matched，
  mismatch 仅是修正前 S5 base 的 3 秒算法发现证据，单边仅是 S1 pending_auth 历史缺口；
  接收端 `total=14 / comparableTotal=14 / matched=11 / tdlibOnly=3 / mismatched=0 /
  unstable=0`，S5 base/edit 均 matched，三个单边仍是 S2 预挂载前历史 delete。
- S5 因此已用一条消息和一次 caption 编辑完成 image+caption+same-chat reply 的真实 shadow
  证据；没有新增 S6，也没有触碰 S4、A1、A2 或既有媒体 fixture。S5 现保留为已编辑、
  未删除；后续不得再次编辑或删除，除非用户另行明确同意。两个 outbox 已确认 `0/0`。
- 用户按约定只发送一次 S5：在发送 S4 的同一安全会话中回复保留的 S4，附一张无敏感内容
  图片，caption 为 `IMHUB-M3-SHADOW-20260829-S5`。两账号中央库各只有一条最终数字消息，
  均为 `media_count=1 / kind=image / reply=true / edited=false / deleted=false`，不是重复发送。
- 接收账号 S5 base 为 `sources=2 / hashes=1 / conflict=false`。发送账号两来源也均已到达，
  但首次为 `sources=2 / hashes=2 / conflict=false`。字段级只读 hash 诊断逐项排除 reply、媒体、
  caption、sender 和方向，唯一匹配 telegram-tt hash 的变量是 `sentAt=-3s`。
- 根因是出向媒体的 SDK 时间语义不同：telegram-tt 在开始上传时定格本地消息时间，TDLib
  返回平台接受上传后的服务端时间；接收端两边都拿服务端时间，因而已 matched。shadow 现
  只把出向媒体 `sentAt` 固定为不可比 null；入向媒体与文本仍严格比较时间，`editedAt` 仍
  进入 revision 和指纹。没有修改或倒填既有 S5 base 账本，该 base 保留为算法发现证据。
- 跨过 120 秒后的正式旧算法报告为：发送端 `total=29 / comparableTotal=13 / matched=11 /
  mismatched=1 / telegramTtOnly=1 / sourceLocal=16 / unstable=0`，唯一 mismatch 是 S5 base，
  单边项仍是 S1 pending_auth 历史缺口；接收端 `total=13 / comparableTotal=13 / matched=10 /
  tdlibOnly=3 / mismatched=0 / unstable=0`，S5 base 已计入 matched，三个单边项仍是 S2 历史
  delete 缺口。
- 回归先稳定复现 3 秒差异，修正后媒体/reply/shadow 定向 3 文件 27 tests、`pnpm typecheck`、
  `git diff --check` 和可连接本机派生测试库的全量 37 文件 359 tests（另 1 个既有 todo）通过。
  临时只读诊断脚本已删除，未读取/输出平台会话、远端媒体引用或账号外部身份。
- 下一步不新增 S6：在新算法和服务已加载后，只把同一条 S5 caption 编辑一次为
  `IMHUB-M3-SHADOW-20260829-S5-EDITED`。这会用新 revision 验证两账号 image+reply 双来源；
  不删除 S5，也不触碰 S4、A1、A2 或既有媒体 fixture。
- 已完成媒体、回复和 remap 的只读审计及最小实现。telegram-tt 已提供图片、视频、音频、
  语音、文件、贴纸及同会话 reply；TDLib 归一化现补齐对应内容，并覆盖圆形视频和动画。
  跨会话 reply 明确保持 null，不猜测当前会话键。
- 图片和贴纸只保留两个 SDK 都稳定提供的 kind；视频/音频/文件继续比较 MIME、大小和真实
  文件名。telegram-tt 在平台没有 filename attribute 时依据 SDK 远端 id 生成的展示名被
  排除，远端引用本身仍不进 shadow 指纹，避免假 mismatch 而不放宽真实文件名差异。
- temp upsert 和 remap 已在报告中明确归为 `source_local`，`comparableTotal` 只统计跨来源
  可比事实。最新 24 小时只读报告：发送端 `total=26 / comparableTotal=12 / matched=11 /
  telegramTtOnly=1 / sourceLocal=14`；唯一可比单边项是 S1 发送时 TDLib 尚为
  `pending_auth` 的既有前置条件缺口。接收端 `total=12 / comparableTotal=12 / matched=9 /
  tdlibOnly=3 / sourceLocal=0`，三个单边 delete 仍是 S2 预挂载修复前历史缺口。两端均为
  `mismatched=0 / unstable=0`，没有把最终数字消息键误归为本地生命周期。
- 新回归先稳定暴露媒体/reply 返回 null、temp/remap 污染单边计数和 SDK 自动文件名假差异，
  实现后定向 3 文件 26 tests、`pnpm typecheck` 及可连接本机派生测试库的全量 37 文件
  358 tests（另 1 个既有 todo）通过。开发账本没有既有媒体 shadow fact，未改写或倒填历史。
- 当时定义的下一条真实动作是一个 shadow 专用组合探针：从 `existing` 在同一安全会话中
  回复保留的 S4，同时附一张无敏感内容图片并使用 caption
  `IMHUB-M3-SHADOW-20260829-S5`，只发送一次。
  它同时验证 image/caption/reply，不重做 M3-4 媒体、回复或故障矩阵；S4、A1、A2 和既有
  媒体 fixture 均不编辑、不删除。
- 用户重新登录的是 im-hub 工作台会话，不是 Telegram；登录后两个 TDLib 账号仍为
  `connected`，两个 owner webview 均重新取得并验证 control grant。S4 发送前中央库计数为 0。
- 用户从 `existing` 向 `new` 只发送一次 `IMHUB-M3-SHADOW-20260829-S4`。发送端在
  temp/final remap 的极短窗口曾同时可见两行，随后自动合并为一条最终行；接收端始终一行，
  因而不是重复平台发送。两账号的最终 base fact 都是两来源、单一 hash、无冲突。
- base 确认后，用户只把同一条 S4 编辑一次为带 `-EDITED` 后缀的正文。即时只读结果显示
  发送/接收账号各一行、均有 `edited_at` 和非 null `edit_version`，旧正文行数为 0；两个编辑
  fact 使用同一个服务端 `editedAt` revision，各自均为 `sources=2 / hashes=1 / conflict=false`。
- 跨过 120 秒后的旧口径 24 小时正式报告中，发送账号为 `11 matched / 0 mismatched /
  0 TDLib-only / 0 unstable`，其中 7 个 matched upsert 包含 S4 base/edit；15 个
  telegram-tt-only 仍是已解释的本地 temp upsert/remap 生命周期。接收账号为
  `9 matched / 0 mismatched / 0 telegram-tt-only / 0 unstable`，8 个 matched upsert
  包含 S4 base/edit；3 个 TDLib-only delete 是预挂载修复前的 S2 历史缺口，不属于 S4。
- S4 的 telegram-tt 观测在最初 19 秒内有稳定重复但 hash 不变，之后十余分钟没有持续重放；
  服务端均已接受。用户随后逐一切换两个账号检查输入坞，均未出现“消息回传队列待处理”或
  “永久失败事件”提示；结合两侧已验证的 bridge/control grant，对应两个 outbox `0/0`。
  S4 现保留为已编辑、未删除；删除必须另获用户明确同意。
- TDLib 编辑观测与跨来源 revision 已完成自动接线。官方事件把编辑时间放在
  `updateMessageEdited`、把最终正文放在独立 `updateMessageContent`；适配器在后者到达后
  通过 `getMessage` 取得完整 sender/date/content/edit_date 快照，只对 `edit_date > 0`
  且内容可归一化的消息发出规范编辑消息。断线/relink 后旧 client 的迟到结果会被丢弃。
- shadow 编辑事实键统一为 `edited-at:<ISO-time>`，语义指纹保留 `editVersion` 键但固定为
  null，以维持既有 base hash 并排除 TDLib 不具备的 MTProto `pts`。telegram-tt 的 `pts`
  未删除，仍负责中央库、翻译 revision 与 outbox 的快速连续编辑排序。同一秒多次编辑若
  正文不同会成为同源冲突而非伪 matched。
- 回归测试先分别稳定失败，再在实现后转绿；相关 3 文件 21 tests、`pnpm typecheck`
  与可连接本机派生测试库的全量 37 文件 354 tests（另 1 个既有 todo）通过。第一次全量
  运行仅因沙箱禁止连接 `127.0.0.1:5432` 在数据库 setup 阶段失败，允许本机连接后原命令通过。
- 预挂载修复后，用户从 `existing` 向 `new` 只发送一次
  `IMHUB-M3-SHADOW-20260829-S3`；只读数据库确认两分区各一行，没有因页面延迟
  再次生成多条。120 秒报告中，发送/接收的最终 base upsert 均为 `1/1 matched`，
  无 mismatch、TDLib-only 或同源不稳定；发送侧一组临时 upsert/remap 依设计单独分类。
- 用户另行明确同意后，在 `new` 仍为未切换的隐藏 pane 时，仅对所有人删除 S3。
  即时观测已显示发送/接收的 TDLib 和 telegram-tt 四个来源分区各一个 delete；
  跨过 120 秒后，两账号的 `delete` 均为 `1/1 matched`，无任何单边或不一致。
  两个 IndexedDB outbox 最终均为 `pending=0, dead=0`。
- S3 因此完成“单条 base + 隐藏接收 pane delete”的 shadow 专用复验，不是重做
  M3-4 故障矩阵。S3 已删除；S1、剩余第一条 S2、A1、A2 仍保留不动。
- 用户已明确同意保留四条 S2 中最上面第一条，并对所有人删除下面连续三条。
  即时只读确认发送/接收分区都是第一条 live、后三条 deleted；S1、A1、A2 未动。
- 120 秒正式报告显示：`existing` 发送分区的三个 delete 全部 matched，连同四个
  base upsert 为 `7 matched / 0 mismatched / 0 TDLib-only`；余下 8 个 telegram-tt-only
  是四组临时 upsert/remap 生命周期。`new` 接收分区的四个 base upsert matched，
  但三个 delete 都是 TDLib-only。两账号均无 mismatch 或同源不稳定。
- 两个 IndexedDB outbox 都为 `pending=0, dead=0`。接收侧缺口不是卡队列：用户按
  `⌘R` 后只打开了发送账号，删除发生时接收账号的 webview 尚未创建。事后
  打开只加载删除后的最终状态，telegram-tt 不会伪造历史 `message.deleted`。
- 宿主已修正为恢复会话后预挂载当前 owner 的所有已支持 Telegram webview，隐藏
  pane 也使用各自的物理 partition、control grant 和 outbox 持续接收 update；未授权、
  auditor、其他 owner 和未支持平台不挂载，权限收回后立即卸载。开发态已观察到
  两个 owner 账号同时建立 webview 并完成各自 control grant。
- 预挂载回归测试先稳定复现“只挂 active 账号”缺口，修复后定向测试、
  `pnpm typecheck`、desktop build 和全量 37 文件 352 tests（另 1 个既有 todo）通过。
- `existing` / `new` 两个 TDLib 账号都已真实登录并收敛为 `connected`。
  用户从 `existing` 向 `new` 发送 `IMHUB-M3-SHADOW-20260829-S2` 时，因 Telegram
  页面延迟显示而连续点击了四次；后续确认这是四条不同的真实平台消息，
  不是数据库重复，也没有第五条。不再重发 S2。
- 跨过 120 秒静默窗口后，`new` 接收分区的 S1 + 四条 S2 为 `5/5 matched`；
  `existing` 发送分区的四条 S2 最终 base upsert 全部 matched。两边均无
  mismatch、TDLib-only 或同源不稳定；发送侧另有 11 个 telegram-tt-only 的临时
  upsert/remap 生命周期事实，这些不是最终 base 差异。两个 webview 的 outbox 均为
  `pending=0, dead=0`。
- TDLib 适配器已补齐 `updateDeleteMessages` 观测：只把平台/当前账号视图的删除
  转成 canonical `delete` 事实，`from_cache=true` 的本地缓存淘汰明确忽略；删除状态与
  shadow 观测在同一事务内落库，事件处理器异常隔离。`pnpm typecheck`、定向数据库
  用例及全量 37 文件 351 tests（另 1 个既有 todo）通过。
- S1 发送侧 TDLib 为 `pending_auth` 后，用户通过「账号状态 → 重新关联」真实复验时遇到
  二维码永久停在“正在生成”。relink HTTP 始终为 200，根因不是 WebSocket 或 QR 渲染，
  而是 `tdl.createClient()` 的 receive loop 可能在业务 listener 挂载前收到并缓存首个
  authorization state；状态不再变化时，适配器永远收不到 `WaitPhoneNumber`。
- TelegramAdapter 现会在 listener 挂载后主动读取一次 `getAuthorizationState`；若实时
  authorization update 已到达则跳过快照，避免同一 WaitPhoneNumber 旋转两份 token；
  disconnect/relink 期间旧 client 的迟到结果也不会覆盖新实例。回归测试先稳定复现空挑战，
  修复后通过；全量 37 文件 348 tests（另 1 个既有 todo）和 typecheck 通过。
- 修复加载后，用户刷新宿主、重新关联一次即看到二维码并完成扫码；只读数据库确认
  `existing` / `new` 两个 TDLib 账户均为 `connected`，且 credentials/identity 均存在。
  本次没有清理 native partition，也没有发送、编辑或删除 Telegram 消息。
- 用户已明确从 `existing` 真实账户向 `new` 真实账户的一对一安全会话手动发送一次
  `IMHUB-M3-SHADOW-20260829-S1`，没有编辑或删除。跨过 120 秒静默窗口后的只读报告显示：
  `new` 接收分区的 base upsert 为 `1/1 matched`，两来源语义哈希一致，无 mismatch、
  单边事实或同源不稳定。
- `existing` 发送分区记录了 telegram-tt 的临时 upsert、最终 upsert 和 remap，三项均为
  telegram-tt-only，且没有同源冲突。只读账号状态同时显示 `new` 的 TDLib 为
  `connected`，`existing` 的 TDLib 为 `pending_auth`；因此当前发送侧单边结果是 TDLib
  登录前置条件未满足，不是 canonical key 或语义哈希差异。S1 保留，不重发、不删除。
- 下一次真实消息前必须先让 `existing` 的 TDLib 状态收敛到 `connected`。连接完成后使用
  新标记 `IMHUB-M3-SHADOW-20260829-S2` 做一次同方向 base upsert 复验；不得用重放或
  数据库补写伪造缺失的 TDLib 来源。
- Issue #13 为 M3-5 的现行范围：shadow 对账、差异修复、灰度/回滚与切换门槛。
- M3-5 依赖未合并的 PR #19，因此 im-hub 独立分支 `codex/m3-telegram-shadow`
  从 PR #19 头部 `18d4a02` 堆叠建立。不得把 M3-5 提交推入
  `codex/m3-telegram-outbox`。
- 第一 checkpoint 已实现 `tdlib` / `telegram-tt` 来源观测账本、语义指纹
  和带静默窗口的离线对账报告。详细语义见
  `docs/superpowers/specs/2026-08-29-m3-telegram-shadow-reconciliation.md`。
- `0007_telegram_shadow_observations` 以 `(account_id, source, fact_key)` 幂等记录首次/
  最后观测时间、重放次数、语义指纹和同源冲突。正文、raw、远端媒体引用、token
  和账号外部身份不进账本。observation 与消息账号不一致时整笔拒绝。
- TDLib upsert/remap 以 `tdlib` 记录；native upsert/delete/remap 只在服务端已验证平台为
  Telegram 时以 `telegram-tt` 记录。Signal/WhatsApp/Zoom native 事件不会污染该账本。
- `pnpm --filter @im-hub/server shadow-report <account-uuid> [hours] [grace-seconds]` 为只读报告。
  它按事实最早观测时间应用静默窗口，输出 matched/mismatched/两个单边分类、
  同源不稳定计数、事件类型分组和有上限的 fact key 样本。
- 开发库和按规则派生的测试库均已成功执行 `0007`。定向账本/ingest/native 回归通过；
  im-hub `pnpm typecheck`、全量 36 文件 347 tests（另 1 个既有 todo）和 desktop build 通过。
  回归包含非 Telegram 边界、倒序观测时间和跨账号拒绝。
- S1 发送前，迁移后开发账本的只读聚合为 0。这表示当时启用观测后尚无新的真实消息事实；
  不用历史中央库行倒填两个来源，也不把空报告写成 shadow 验收通过。
- M3-4 的真实故障矩阵、双账号 partition、A1/A2 和媒体弹窗修复证据直接复用，
  不重发、不删除、不为 M3-5 重做。语音仍按用户决定跳过。
- 开始真实 shadow 前先完成迁移、单元/数据库回归、typecheck 和全量测试；对账脚本
  不得输出消息正文、账号外部 id 或任何会话凭据。
- PR #19 / Issue #12 保持 OPEN，不合并、不关闭。Issue #13 也不在第一 checkpoint
  完成后提前关闭。

## 下一 checkpoint

1. 不再发送、编辑或删除 S4；删除必须另行取得用户明确同意。
2. S5 已完成一次发送和一次 caption 编辑，不再重发、编辑或删除。两账号消息行和正式
   shadow 报告和 outbox `0/0` 均已收敛；旧 base mismatch 保留为已解释的算法发现证据。
3. 受限历史 coverage dry-run 已实现并在双真实账号上只读验证；不得把
   `preObservation`、`sourceLocal` 或不可恢复 delete 当成待倒填缺陷。
4. TDLib 当前快照主动读取已用 S1 真实收敛；逐账号灰度开关、观察/一致率门槛和精确回滚通道
   已实现。当前 allowlist 仍为空；必须先完成新的 7 天 active 观察窗，不能立即开启 canary。
   在证据完成前不停用 TDLib，不伪造缺失的 telegram-tt/TDLib 来源。
