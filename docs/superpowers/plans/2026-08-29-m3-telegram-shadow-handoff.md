# M3-5 Telegram shadow reconciliation 交接记录

日期：2026-08-29

## 最新 checkpoint

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

1. 提交/推送预挂载修复并回写 Issue #13；PR #19 和 Issue #12 保持 OPEN。
2. 修复加载后仅执行一个 shadow 专用探针：在两个账号 webview 都已预挂载、
   `pending=0, dead=0` 时，从 `existing` 向 `new` 只发送一次
   `IMHUB-M3-SHADOW-20260829-S3`。不重复 M3-4 故障矩阵。
3. S3 双账号 base upsert 跨过 120 秒并 matched 后，经用户另行明确确认，仅对所有人
   删除 S3；删除时保持接收账号为隐藏 pane，验证四个来源分区都产生 matched delete。
   S1、剩余第一条 S2、A1、A2 不动。
