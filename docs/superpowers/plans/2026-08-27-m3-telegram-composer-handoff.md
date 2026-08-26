# M3-3 Telegram 原生 Composer Bridge 交接记录

日期：2026-08-27

用途：这是清理 Codex 上下文后的最新恢复入口。恢复时必须重新核对 Git、GitHub 和真实
账号状态；本文记录的是保存时已经确认的事实，不替代后续实时检查。

## 1. 保存时结论

M3-3 的 telegram-tt 原生 Composer typed bridge、稳定发送 attempt、canonical message id
回传和 im-hub 外层翻译发送接线已经完成并推送。im-hub PR #16 保存时为可合并的开放
PR，Issue #11 因尚未完成真实 Telegram 账号验证而保持开放；下一阶段 Issue #12 也保持
开放。

不要把“代码和自动化验证完成”写成“真实账号端到端验证完成”。PR #16 合并后，推荐先
完成 M3-3 真实账号验收并记录结果，再关闭 Issue #11，然后进入 M3-4 持久事件 outbox。

## 2. GitHub 实时状态

2026-08-27 保存本文前已通过 GitHub CLI 成功刷新：

- PR #16：`OPEN`、非 draft、`mergeStateStatus=CLEAN`，没有已登记的 status checks；
  base `3464352a60b3de079ffe674fe9c1c990c5557532`，保存本文前的实现 head
  `66869cb77c0fa656f0d3117d059b3eec16889315`。本文提交并推送后 head 会继续前进。
  链接：<https://github.com/jojo8233/CLOT-imhub/pull/16>
- Issue #11：`OPEN`，`[M3-3] telegram-tt 原生 Composer typed bridge`。
  链接：<https://github.com/jojo8233/CLOT-imhub/issues/11>
- Issue #12：`OPEN`，`[M3-4] telegram-tt 持久事件 outbox 与可靠回传`。
  链接：<https://github.com/jojo8233/CLOT-imhub/issues/12>

恢复后先重新运行 `gh pr view 16` 和 `gh issue view 11/12`，不要假定上述状态未变化。

## 3. im-hub Git 状态

- GitHub 仓库：`jojo8233/CLOT-imhub`
- 主仓库路径：`/Users/mac/Documents/Codex/CLOT fanyi/im-hub`
- 本阶段临时 worktree：`/private/tmp/im-hub-m3-composer.b4Gmwq`
- 分支：`codex/m3-telegram-composer`
- M3-3 实现提交：
  `66869cb77c0fa656f0d3117d059b3eec16889315 feat: connect Telegram native Composer bridge`
- 基线：
  `3464352a60b3de079ffe674fe9c1c990c5557532 Merge pull request #15 from jojo8233/codex/m3-account-control`
- 保存本文前，本地实现 HEAD 与本地缓存的
  `origin/codex/m3-telegram-composer` 精确一致。本文会作为后续文档提交推送到同一 PR。

`/Users/mac/Claude Code 工作区/代码/im-hub` 是另一个已有用户改动的共享 workspace。
本阶段没有修改它。恢复工作时继续使用上述临时 worktree；若临时目录已经被系统清理，
从主仓库的远端分支重新创建 worktree，不要清理、覆盖或重置共享 workspace。

## 4. telegram-tt Git 状态

- GitHub fork：`jojo8233/telegram-tt`；上游为 `Ajaxy/telegram-tt`
- 主仓库路径：`/Users/mac/Claude Code 工作区/代码/telegram-tt`
- 本阶段临时 worktree：`/private/tmp/telegram-tt-m3-composer.psbf7o`
- 分支：`codex/m3-telegram-composer`
- M3-3 提交：
  - `58ff7a13d8bf08f173a707e31d0c240625716c36 Composer / im-hub: Add typed bridge and stable send attempts`
  - `0c9adabe06fa9804083122c6354a2cf2b6c997fe fix: preserve paid Composer confirmation in im-hub bridge`
- 基线：
  `9538b3ac072c0c7383080e4ddd64b664e93cd57d Composer / im-hub: Add account-control states and close gated views`
- 保存本文前，本地 HEAD 与本地缓存的
  `imhub/codex/m3-telegram-composer` 精确一致。

telegram-tt 是独立仓库。进入后先读它自己的 `CLAUDE.md`/`AGENTS.md`，继续使用 npm，
并保持 im-hub 补丁集中、最小化。若临时 worktree 已消失，从 fork 的远端分支重建，不要
在 im-hub 仓库里误操作它。

## 5. M3-3 已完成内容

设计事实以
`docs/superpowers/specs/2026-08-27-m3-telegram-composer-bridge.md` 为准。核心实现包括：

- im-hub shared protocol 增加 host 到 guest 的 `bridge.request-state`；NativeClient 在账号
  控制状态就绪后请求 telegram-tt 重放当前 context 和 Composer state。
- telegram-tt 集中定义 typed host command/event；当前 Composer 注册 chat/topic context，
  chat 或 topic 改变时递增 `contextRevision`，并在录音等异步步骤后再次校验上下文与发送门禁。
- `composer.set-draft`/`composer.get-draft` 使用 telegram-tt 原生富文本编辑器；草稿和发送
  gate 改变时重放 Composer state。
- typed bridge 的付费消息复用 Telegram 原生确认弹窗；取消或切换上下文会明确终止 attempt，
  余额不足时保持不可发送并由原生 Composer 负责充值流程。
- im-hub TranslationDock 为一次发送保留稳定的 `sendAttemptId` 和精确 native draft。
  结果未知时，用同一 attempt 查询/重试，不依赖已经清空的原生输入框；只有确认成功才清空
  外层草稿。
- telegram-tt 将内部 `imHubAttemptId` 贯穿本地发送与 worker update，但不发送给 MTProto；
  canonical 成功结果为 `<chatId>:<serverMessageId>`。
- 分组附件等待所有消息完成；部分失败返回明确错误。已完成 attempt 在渲染进程内存中最多
  保留 100 个，同一 attempt 重放不会重复发送。
- edit、scheduled list、forward、ephemeral reply/command 等当前无法安全表示成单一 canonical
  新消息结果的模式统一上报 `canSend=false`。
- 旧的 `ImHubComposer.tsx`、SCSS 和 MiddleColumn 挂载已删除；相关桥接错误文案已本地化，
  language types 已重新生成。
- 对超时、context mismatch、partial failure、stale result、attempt mismatch、缺失 message id
  和 bridge disconnected 等歧义结果保留 attempt，支持安全恢复。

## 6. 已完成验证

im-hub：

- `pnpm typecheck` 通过。
- focused desktop tests：3 个文件、32 个测试通过。
- `pnpm test` 在沙箱内因无法连接本机 PostgreSQL 报 `EPERM`；随后在沙箱外加载主仓库
  `.env` 并只使用派生测试库重跑，33 个测试文件、325 个测试通过，另有 1 个既有 todo。
- `pnpm --filter @im-hub/desktop build` 通过。
- `git diff --check` 通过。

telegram-tt：

- `npm run lang:ts` 通过，生成 2875 个 simple keys 和 172 个 plural keys。
- `npm run check:ts` 通过。
- `git diff --check` 通过。
- `npm run check:css` 未通过：既有上游文件
  `src/components/middle/message/_message-content.scss` 有 8 个 error、401 个 warning。
  M3-3 相对基线没有修改该文件；本阶段唯一 stylesheet 变化是删除旧
  `ImHubComposer.module.scss`，PR #16 正文已记录此基线问题。

2026-08-27 恢复后的收尾复核：

- 修复 typed bridge 绕过付费消息确认的风险，并补齐转发、临时回复、scheduled list、余额
  等 Composer gate 变化后的 state 重放；录音等异步步骤结束后同时复核上下文与实时 gate。
- telegram-tt `npm run check:ts` 通过，`git diff --check` 通过。
- im-hub `pnpm typecheck` 通过；desktop 8 个测试文件、59 个测试通过；desktop build 通过；
  `git diff --check` 通过。

## 7. 尚未完成与边界

以下项目不能在恢复时误判为完成：

1. 尚未用真实 Telegram 账号验收 private/group/channel/topic、reply、attachment、silent、
   scheduled、超时后同 attempt 恢复，以及多账号隔离。
2. Issue #11 要在真实账号验证通过并留下可审计记录后再关闭。
3. M3-4 的持久事件 outbox、ACK/retry、edit/delete/remap 尚未开始；跟踪于 Issue #12。
4. M3-5 shadow reconciliation 和更完整的历史对账尚未开始。
5. 当前稳定 attempt 只保存在 renderer 内存；页面/进程崩溃后的恢复属于后续持久化范围。
6. telegram-tt 上游 CSS lint 基线问题仍存在，但不由 M3-3 引入。
7. installer、自动更新和源码分发仍不属于本阶段完成项。

## 8. 推荐恢复顺序

1. 读取根 `AGENTS.md`，再读本交接及以下设计文档：
   - `docs/superpowers/specs/2026-08-25-native-client-pivot.md`
   - `docs/superpowers/specs/2026-08-26-m2-native-bridge.md`
   - `docs/superpowers/specs/2026-08-26-m3-telegram-message-identity.md`
   - `docs/superpowers/specs/2026-08-26-m3-account-control.md`
   - `docs/superpowers/specs/2026-08-27-m3-telegram-composer-bridge.md`
2. 重新核对 PR #16、Issue #11/#12、两个仓库 worktree、HEAD、upstream 和工作区是否干净。
3. 如果 PR #16 尚未合并，先处理 review/CI；除非用户明确要求，不主动合并 PR。
4. PR #16 合并后，优先做真实账号 M3-3 验收。通过后把证据记录到 Issue #11 并关闭它。
5. 随后从合并后的 im-hub `main` 与 telegram-tt 对应已推送基线开始 M3-4 Issue #12。
   在设计持久 outbox 前，先核对服务端当前事件落库、ACK 和 WebSocket 重连代码，不要只按
   Issue 描述推断现状。

快速核对命令示例：

```bash
git -C "/private/tmp/im-hub-m3-composer.b4Gmwq" status --short --branch
git -C "/private/tmp/im-hub-m3-composer.b4Gmwq" rev-parse HEAD origin/codex/m3-telegram-composer
git -C "/private/tmp/telegram-tt-m3-composer.psbf7o" status --short --branch
git -C "/private/tmp/telegram-tt-m3-composer.psbf7o" rev-parse HEAD imhub/codex/m3-telegram-composer
gh pr view 16 --repo jojo8233/CLOT-imhub
gh issue view 11 --repo jojo8233/CLOT-imhub
gh issue view 12 --repo jojo8233/CLOT-imhub
```

## 9. 清理上下文后的启动提示词

可把下面整段作为新任务的第一条消息：

```text
读取 /Users/mac/Documents/Codex/CLOT fanyi/im-hub/AGENTS.md，及：
- docs/superpowers/specs/2026-08-25-native-client-pivot.md
- docs/superpowers/specs/2026-08-26-m2-native-bridge.md
- docs/superpowers/specs/2026-08-26-m3-telegram-message-identity.md
- docs/superpowers/specs/2026-08-26-m3-account-control.md
- docs/superpowers/specs/2026-08-27-m3-telegram-composer-bridge.md
- docs/superpowers/plans/2026-08-27-m3-telegram-composer-handoff.md

核对 GitHub PR #16、Issue #11/#12，以及 im-hub、telegram-tt 两个仓库和远端分支的
实时状态，从最新交接继续。不要修改
/Users/mac/Claude Code 工作区/代码/im-hub 的既有用户改动。先判断 PR #16 是否已经合并：
未合并则继续收尾；已合并则先完成 M3-3 真实账号验收，再开始 M3-4 Issue #12。
```
