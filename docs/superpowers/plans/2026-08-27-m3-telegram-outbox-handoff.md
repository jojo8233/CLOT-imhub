# M3-4 Telegram 持久事件 outbox 交接记录

日期：2026-08-27

用途：这是 M3-4 代码实现和自动验证后的最新恢复入口。恢复时仍须重新核对 Git、GitHub 与
真实账号状态；本文不替代实时检查，也不把尚未完成的真实故障矩阵写成已验收。

## 1. 当前结论

- PR #16、#17、#18 均已合并；最新 `origin/main` 为 PR #18 merge commit
  `b8b2e3382714831ac3f8b016137593a083a8feeb`。
- Issue #11、#12 均保持开放。PR #16/#17 和 Saved Messages 真实验收已经完成，不要重复。
- M3-4 已在两个隔离 worktree 完成代码与自动验证，但真实账号故障矩阵尚未执行，因此不要关闭
  Issue #12，也不要宣称 M3-4 完整验收。
- im-hub PR #19 已创建并关联 Issue #12：
  <https://github.com/jojo8233/CLOT-imhub/pull/19>。
- telegram-tt 实现提交为
  `94bfc962abc942c331f607209ccb4057ae8d0880 feat: add persistent im-hub message outbox`。
  该提交已推送到 `jojo8233/telegram-tt`：
  <https://github.com/jojo8233/telegram-tt/commit/94bfc962abc942c331f607209ccb4057ae8d0880>。
- im-hub 实现已推送到 `codex/m3-telegram-outbox`，由 PR #19 审查；当前不自动合并或关闭 Issue。

## 2. 仓库与 worktree

im-hub：

- GitHub：`jojo8233/CLOT-imhub`
- 主仓库：`/Users/mac/Documents/Codex/CLOT fanyi/im-hub`
- 隔离 worktree：`/private/tmp/im-hub-m3-outbox`
- 分支：`codex/m3-telegram-outbox`
- 基线：`b8b2e3382714831ac3f8b016137593a083a8feeb`
- PR：<https://github.com/jojo8233/CLOT-imhub/pull/19>

telegram-tt：

- fork：`jojo8233/telegram-tt`；上游：`Ajaxy/telegram-tt`
- 主仓库：`/Users/mac/Claude Code 工作区/代码/telegram-tt`
- 隔离 worktree：`/private/tmp/telegram-tt-m3-outbox`
- 分支：`codex/m3-telegram-outbox`
- 基线：`ba24da89abc1e56b4b8c3c68ebafa819e85e5b1d`
- 当前提交：`94bfc962abc942c331f607209ccb4057ae8d0880`
- 远端：`imhub/codex/m3-telegram-outbox`，与当前提交精确一致

`/Users/mac/Claude Code 工作区/代码/im-hub` 是带有既有用户改动的共享 workspace。本阶段只做过
只读核对，没有修改、清理、暂存或重置其中任何内容。

## 3. 已实现内容

telegram-tt：

- 中央 message updater 生成 `message.upsert`、`message.deleted` 和
  `message.id-remapped`；本地发送保持 temp id，成功后严格按 remap、final upsert 顺序入队。
- `UpdateEditMessage` 与 `UpdateEditChannelMessage` 使用 MTProto `pts` 作为单调
  `editVersion`，避免同一秒快速连续编辑失序。
- pending 与 dead-letter 使用账号 partition 内的 IndexedDB；同账号单 in-flight，ACK 后删除，
  ACK 超时或 retryable 拒绝按 1–60 秒指数退避，永久拒绝移入 dead-letter。
- `eventId` 由账号与规范事件语义生成稳定 SHA-256 截断值；刷新、重放和 ACK 丢失不会换 id。
- pending/dead-letter 各限 1000；同毫秒事件使用单调入队时间保持顺序。dead-letter 满时永久失败
  记录保留在 pending，不静默丢失。
- 快照包含消息正文、方向、发送者/会话展示名、同会话 reply key、时间戳、媒体引用和最小元数据。
  不读取或持久化 token、session、二维码、验证码、2FA、API key、JWT 或 control grant。
- scheduled/ephemeral/quick-reply 不伪装成长期已投递消息；scheduled 实际发送后以普通消息进入。

im-hub：

- typed bridge 升级到 v3，新增不含消息正文的 `outbox.status`。
- renderer 对 guest 状态做帧大小、数量上限和字段运行时校验，按账号保存 pending、dead-letter、
  sending 与 error code。
- TranslationDock 显示非阻塞积压/永久失败/存储故障提示；dead-letter 不会把 Composer 标成断开
  或阻止 Telegram 后续发送。
- 对应架构规格已更新；完整设计见
  `docs/superpowers/specs/2026-08-27-m3-telegram-outbox.md`。

## 4. 自动验证

im-hub：

- `pnpm typecheck` 通过。
- desktop 9 个测试文件、65 个测试通过；最终改动后 native bridge/store 聚焦测试 2 个文件、
  28 个测试再次通过。
- 全量 `pnpm test`：34 个文件、331 个测试通过，1 个既有 todo。
- `pnpm --filter @im-hub/desktop build` 通过。
- `git diff --check` 通过。

telegram-tt：

- `npm run check:ts` 通过。
- 既有 `src/util/imhub.test.ts` 聚焦测试 1/1 通过。
- `git diff --check` 通过。
- 依照 telegram-tt 仓库约定，本补丁没有新增测试文件。

测试没有读取或打印 `.env`、平台会话目录、二维码、验证码或 2FA。全量 im-hub 测试直接使用
测试自身配置；没有把测试指向开发库或生产库。

## 5. 尚未完成

Issue #12 的真实账号故障矩阵仍需完成并留下可审计证据：

1. 断网后恢复、页面刷新、Electron 进程终止和 ACK 丢失。
2. 快速连续编辑、普通/频道删除、local-to-final remap。
3. 图片、文件、语音等媒体引用。
4. 两个账号同时积压时的 partition 隔离。
5. permanent rejection、dead-letter 容量与运维恢复路径。

真实矩阵可能向外部联系人发送消息；开始前先限定安全目标，不要重复已经完成的 Saved Messages
验收。M3-5 的 TDLib/telegram-tt shadow reconciliation 和历史缺口扫描也不属于本提交。

## 6. 恢复顺序

1. 读根 `AGENTS.md`、本交接和 outbox 规格。
2. 刷新 PR #16/#17/#18、Issue #11/#12、两个仓库远端与 worktree 状态。
3. 检查 PR #19 的 checks/review；不要在没有新证据时关闭 Issue #12。
4. 在明确限定安全目标后执行 Issue #12 真实故障矩阵，并把可审计结果写入 Issue；不要重复
   Saved Messages 验收。
5. 不操作共享 workspace 的既有用户改动，不重做 PR #16/#17。

快速核对：

```bash
git -C /private/tmp/im-hub-m3-outbox status --short --branch
git -C /private/tmp/im-hub-m3-outbox rev-parse HEAD origin/main
git -C /private/tmp/telegram-tt-m3-outbox status --short --branch
git -C /private/tmp/telegram-tt-m3-outbox rev-parse HEAD imhub/codex/m3-telegram-outbox
gh pr view 16 --repo jojo8233/CLOT-imhub
gh pr view 17 --repo jojo8233/CLOT-imhub
gh pr view 18 --repo jojo8233/CLOT-imhub
gh pr view 19 --repo jojo8233/CLOT-imhub
gh issue view 11 --repo jojo8233/CLOT-imhub
gh issue view 12 --repo jojo8233/CLOT-imhub
```
