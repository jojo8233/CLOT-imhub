# M3-5 Telegram shadow reconciliation 交接记录

日期：2026-08-29

## 最新 checkpoint

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
- 迁移后开发账本的只读聚合为 0。这表示启用观测后尚无新的真实消息事实；
  不用历史中央库行倒填两个来源，也不把空报告写成 shadow 验收通过。
- M3-4 的真实故障矩阵、双账号 partition、A1/A2 和媒体弹窗修复证据直接复用，
  不重发、不删除、不为 M3-5 重做。语音仍按用户决定跳过。
- 开始真实 shadow 前先完成迁移、单元/数据库回归、typecheck 和全量测试；对账脚本
  不得输出消息正文、账号外部 id 或任何会话凭据。
- PR #19 / Issue #12 保持 OPEN，不合并、不关闭。Issue #13 也不在第一 checkpoint
  完成后提前关闭。

## 下一 checkpoint

1. 推送独立 M3-5 分支并把自动验证证据回写 Issue #13，但不创建伪完成勾选。
2. 在用户确认的两个真实账号与安全会话中生成全新、可识别的 shadow fixture；
   不重用 A1/A2 充当新证据，也不删除它们。
3. 跨过静默窗口后只读运行两个账号的报告，先核对 base upsert canonical 键和指纹；
   temp/remap 是发送端本地生命周期，在定义切换门槛前单独解释，不用降低报告要求隐藏。
4. 以第一批真实差异决定 TDLib 编辑/删除/媒体/回复观测和历史扫描的最小补齐顺序。
