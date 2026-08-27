# M3-4 Telegram 持久事件 outbox 交接记录

日期：2026-08-27

用途：这是 M3-4 代码实现和自动验证后的最新恢复入口。恢复时仍须重新核对 Git、GitHub 与
真实账号状态；本文不替代实时检查，也不把尚未完成的真实故障矩阵写成已验收。

## 1. 当前结论

- PR #16、#17、#18 均已合并；最新 `origin/main` 为 PR #18 merge commit
  `b8b2e3382714831ac3f8b016137593a083a8feeb`。
- Issue #11、#12 均保持开放。PR #16/#17 和 Saved Messages 真实验收已经完成，不要重复。
- M3-4 已在两个隔离 worktree 完成代码与自动验证，并在非 Saved Messages 的双人群完成一条
  真实文本发送和多次编辑验收；完整故障矩阵仍未执行，因此不要关闭 Issue #12，也不要宣称
  M3-4 完整验收。
- im-hub PR #19 已创建并关联 Issue #12：
  <https://github.com/jojo8233/CLOT-imhub/pull/19>。
- telegram-tt 最新实现提交为
  `6c8d86a33dd4db37081051ccc192a36650777f15 fix: keep Telegram edit bridge in sync`，建立在
  `94bfc962abc942c331f607209ccb4057ae8d0880 feat: add persistent im-hub message outbox` 之上。
  两者均已推送到 `jojo8233/telegram-tt` 的 `codex/m3-telegram-outbox`。
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
- 当前提交：`6c8d86a33dd4db37081051ccc192a36650777f15`
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
- 异步翻译结果只在源正文仍匹配时回填；组件暂存译文也绑定源正文，连续编辑不会把上一版译文
  显示在当前正文下方。
- 对“本次确有内容变化、但 Telegram 返回 `MESSAGE_NOT_MODIFIED`”的非定时消息，重新读取
  Telegram 当前消息，并以频道 `pts` 或全局 state `pts` 作为单调版本恢复中央 updater/outbox；
  拉取或版本读取失败时仍保留原错误与回滚，不猜测成功。

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
- 最终收敛代码的既有 `src/util/imhub.test.ts` 聚焦测试 1/1 通过。
- `git diff --check` 通过。
- 依照 telegram-tt 仓库约定，本补丁没有新增测试文件。

上述自动测试没有加载或打印 `.env`、平台会话目录、二维码、验证码或 2FA。全量 im-hub 测试
直接使用测试自身配置；没有把测试指向开发库或生产库。下述本地探针经用户授权只把既有环境
加载到对应进程，从未输出、复制或记录变量值。

## 5. 本地非破坏性持久化探针

2026-08-27 在用户明确授权仅向本机进程加载既有环境后，启动隔离 worktree 的 server、
telegram-tt Vite 和 Electron，并复用既有已登录 partition。Bridge v3 建立后首先报告
`pending=0, dead=0, sending=false, error=none`，确认重启后的空队列状态重放。

由于不重复 Saved Messages、也不向第三方发送新消息，本次使用了一个正文为空且绝不进入
Telegram 的开发态哨兵 delete 事件：

- 主进程在 HTTP 前只对固定哨兵模拟 retryable 失败，记录变为 `pending=1`，并观察到
  `retryable_rejection` 与一次 `ack_timeout`。
- 停止 Electron、移除首次入队代码后重新启动；同一 partition 仍恢复 `pending=1` 并重试，
  证明记录跨页面/进程终止持久存在。
- 主进程随后只对该哨兵返回 accepted ACK；状态从 `pending=1` 回到 `pending=0`，dead-letter
  始终为 0。
- 哨兵没有进入 Telegram、HTTP 或数据库；所有临时代码和诊断日志均已移除，三个开发进程均
  已关闭，两个 worktree 恢复干净。

这只证明真实 Electron partition 中 IndexedDB 持久化、retryable/ACK timeout 状态和 ACK 删除
链路可运行，不能替代中央 Telegram updater、真实消息内容或完整故障矩阵，因此 Issue #12
验收框仍保持未勾选。

## 6. 非 Saved Messages 真实文本验收

2026-08-27 在用户选定的双人 Telegram 群中完成一条固定测试消息，不重复 Saved Messages：

- 原始发送 `IMHUB-M3-OUTBOX-20260827-TEXT-A` 经 local upsert、id remap 和 final upsert 后，
  数据库按最终 `platform_message_id` 只保留 1 行，方向为 outbound/live。
- `EDIT-3` 入库后 `edit_version=7433`；快速连续 `EDIT-4`/`EDIT-5` 最终只保留 `EDIT-5`，
  `edit_version=7435`，证明同一消息没有新增重复行且较新 `pts` 胜出。
- 连续编辑同时复现了旧译文短暂显示在新正文下方的竞态；telegram-tt 最新提交把翻译结果和
  组件 fallback 都绑定到对应源正文。
- worker 源码变更后的页面热重载不会终止既有 SharedWorker。早期 `EDIT-7` 至 `EDIT-9`
  实际仍运行旧 worker，不能作为新修复的失败证据。完整停止并重启 Electron 后，`EDIT-10`
  只进入一次编辑 RPC 且成功返回；服务端收到 outbox 事件，数据库仍只有 1 行，正文为
  `EDIT-10`，`edit_version=7449`。
- 验收期间的阶段诊断不包含正文、账号、会话或消息 id，定位后已全部删除。最终代码另外删除了
  与中央 updater 重复的成功回包上报，只保留中央 updater 和 `MESSAGE_NOT_MODIFIED` 恢复路径。

因此真实普通文本发送、final id 去重、普通群连续编辑和单调版本已覆盖；这仍不是 Issue #12
完整故障矩阵。

开发验收注意：修改 `src/api/gramjs/**` worker 代码后必须完整重启 Electron；只观察 Vite 的
`page reload` 不足以证明新 worker 已加载。

## 7. 尚未完成

Issue #12 的真实账号故障矩阵仍需完成并留下可审计证据：

1. 断网后恢复、页面刷新、Electron 进程终止和 ACK 丢失。
2. 普通/频道删除，以及频道编辑；普通群快速连续编辑与 local-to-final remap 已有上述证据。
3. 图片、文件、语音等媒体引用。
4. 两个账号同时积压时的 partition 隔离。
5. permanent rejection、dead-letter 容量与运维恢复路径。

真实矩阵可能向外部联系人发送消息；开始前先限定安全目标，不要重复已经完成的 Saved Messages
验收。M3-5 的 TDLib/telegram-tt shadow reconciliation 和历史缺口扫描也不属于本提交。

## 8. 恢复顺序

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
