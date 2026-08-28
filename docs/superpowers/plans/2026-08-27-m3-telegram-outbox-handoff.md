# M3-4 Telegram 持久事件 outbox 交接记录

日期：2026-08-28

用途：这是 M3-4 代码实现和自动验证后的最新恢复入口。恢复时仍须重新核对 Git、GitHub 与
真实账号状态；本文不替代实时检查，也不把尚未完成的真实故障矩阵写成已验收。

## 最新续验 checkpoint（2026-08-28）

本节晚于下面的历史 checkpoint，并取代其中“会话仍撤销、需先重新登录”和“频道/媒体/容量尚未
执行”的旧状态：

- 实时刷新后 `origin/main` 为 `b8b2e3382714831ac3f8b016137593a083a8feeb`；PR #19 仍为
  OPEN、CLEAN、非 Draft、无 checks/review decision，Issue #11/#12 仍为 OPEN。没有合并 PR，
  也没有关闭 Issue。
- telegram-tt 正式修复已推送到 `imhub/codex/m3-telegram-outbox`：`2844547` 增加当前账号
  dead-letter 重试/明确清理和容量回归，`a279a6e` 让断网恢复时失效 Blob 的装饰性图片取色降级到
  主题色。im-hub `53cc781` 增加对应 typed command、账号绑定 renderer bridge 和需确认的 UI 动作。
- 用户重新登录后，页面刷新和 Electron 主进程强制终止后的冷启动都保持登录、恢复列表与 im-hub
  连接，没有 pending、dead-letter、授权失败或持续转圈。只在本地丢弃首个成功 ACK 的探针以同一
  eventId 第二次成功收敛，数据库只有一份消息/会话，随后精确清理为 0。
- 外部目标严格限定为用户本人控制且仅用户一人的私密频道。单次文本发送、同一行编辑、对所有人
  删除均已收敛；图片和文件产生非空远端媒体引用后由用户删除。语音按用户决定跳过，不写成通过。
- 真实 partition 的 1000 条虚构 dead-letter 满容量探针覆盖 `dead_letter_capacity`、明确清理、
  队首唤醒、`permanent_rejection` 和最终 `pending=0/dead=0`。合成事件只命中服务端 422，不进入
  Telegram，开发数据库合成消息/会话均为 0；所有探针代码均已撤销。
- Wi-Fi 断开约 10–15 秒后恢复，Telegram 列表和 im-hub 自动恢复。出现过一次图片解码开发弹窗，
  根因与修复见 `a279a6e`；它不是 outbox、鉴权或重连失败。
- im-hub `pnpm typecheck`、34 文件 332 tests（另 1 个既有 todo）和 desktop build 通过；
  telegram-tt `npm run check:ts`、6 文件 13 tests 通过。
- 用户已接入两个互不相同的真实 Telegram identity；两个独立 webview 均保持登录，两个账号绑定的
  control grant 均验证为 200。回复已完成修复后冷启动闭环；语音按用户决定跳过，剩余真实步骤是
  两个账号同时积压的 partition 隔离。当前尚未为该步骤发送任何 Telegram 消息，不能提前写成完成；
  不要重复 PR #16/#17、Saved Messages、普通群 TEXT-A/EDIT-10 或本节已完成的频道/媒体操作。
- 第二账号首次接入时发现真实 partition 为 `pending=66, dead=0`，服务端每分钟对缺失的历史 delete/
  remap 返回 409，严格有序队列因而一直保留队首。im-hub `4d2a8f8` 把中央库缺失的 delete/remap
  作为幂等 no-op 返回 `accepted=true, duplicate=true`，并增加无 publish 的回归测试。修复后仅冷启
  Electron、未清 IndexedDB 或会话，第二分区从 66 收敛到 0；切回第一分区仍为 0，二者均
  `dead=0`、bridge ready。全量 34 文件、335 tests（另 1 个既有 todo）与 `pnpm typecheck` 通过。
- 收尾时两次未处理的 `SESSION_REVOKED` 字符串已定位到唯一会直接构造同名普通 Error 的路径：
  非主 DC 文件 sender 60 秒超时，而外层只重试 `RPCError`，导致内部超时冒充会话撤销。telegram-tt
  `77788bd` 改用独立内部错误类型，按既有上限清理/重建 exported sender，耗尽后收敛为现有
  `USER_CANCELED`；主连接真实 401 的 broken 链未改。`npm run check:ts` 与现有 MTProtoSender
  4 个用例通过。修复后冷启动、打开原媒体验收私聊并跨过旧 60 秒窗口，登录、4 个会话、20 条消息
  与 Composer 均保持正常，未再出现该字符串；本轮没有发送消息或改账号设置。

### 清理上下文前最终状态

- 本 checkpoint 覆盖的 im-hub 修复代码基线为
  `4d2a8f8`，telegram-tt 修复代码基线为
  `77788bd20c83bdee5b1774c9ababe3aaea45435d`；两者分别已推送到对应的
  `codex/m3-telegram-outbox` 远端分支。
- PR #19 证据评论：<https://github.com/jojo8233/CLOT-imhub/pull/19#issuecomment-5447923098>；
  Issue #12 故障矩阵评论：
  <https://github.com/jojo8233/CLOT-imhub/issues/12#issuecomment-5447924313>。
- 本轮续验时 Electron、telegram-tt Vite 和 im-hub server 仍从两个隔离 worktree 运行；后续恢复
  不能假设这些进程仍存活。容量/ACK 探针、临时 Vitest 配置、评论草稿和合成数据库记录均已精确
  清理；Telegram 登录数据保留在隔离 partition，未被清除。
- 共享 workspace 的既有用户改动从未被修改、暂存、重置或清理。恢复时优先继续使用
  `/private/tmp/im-hub-m3-outbox` 与 `/private/tmp/telegram-tt-m3-outbox`；若系统已清理它们，分别
  从两个远端的 `codex/m3-telegram-outbox` 重建。
- 下次先做只读实时核对；回复已完成，不要重发。语音是用户明确跳过项，不要为了凑齐矩阵主动要求
  重测。双账号最终积压步骤开始前，因 Electron 冷启动已清除会话选择，必须请用户在两个账号各自
  重新打开安全的一对一私聊，并对明确的两条固定标记做操作时确认；未经确认不得外发。

清理上下文后可直接粘贴下面这段作为新任务；它取代本文后面的历史续接提示：

```text
从 jojo8233/CLOT-imhub 最新 origin/main、现有 PR #19 和 Issue #12 继续 M3-4。先读根 AGENTS.md、
docs/superpowers/plans/2026-08-27-m3-telegram-outbox-handoff.md 的“最新续验 checkpoint”，以及
telegram-tt 自己的 CLAUDE.md/AGENTS.md；实时核对 PR #19、Issue #11/#12 和两个远端分支。优先
复用 /private/tmp/im-hub-m3-outbox 与 /private/tmp/telegram-tt-m3-outbox；若已清理，从各自远端
codex/m3-telegram-outbox 重建。不要修改共享 workspace 的既有用户改动，不要重复 PR #16/#17、
Saved Messages、普通群 TEXT-A/EDIT-10，也不要重复已经完成的私密频道文本/编辑/删除、图片、
文件、刷新、Electron 终止、ACK 丢失、断网恢复和 dead-letter 容量探针。语音按用户决定跳过；
回复已完成修复后冷启动闭环；两个不同的真实 Telegram identity 已接入，第二账号的 66 条历史孤儿
delete/remap 已由 im-hub 4d2a8f8 的幂等 ACK 修复在冷启动后排空，两个分区均为 pending/dead 0。
当前剩余真实步骤是两账号同时积压的 partition 隔离，尚未为此发送消息。收尾的裸
SESSION_REVOKED 已定位为 exported sender timeout 误用主会话文案，由 telegram-tt 77788bd 修复并
完成只读冷启动验证，不要再重复。任何可能外发或
删除消息的步骤必须先限定安全目标；没有第二身份时不得伪造双账号证据。不要合并 PR 或关闭 Issue，
除非用户再次明确授权。
```

## 0. 前次清理上下文 checkpoint（历史）

截至 2026-08-28 本次交接保存时：

- im-hub `codex/m3-telegram-outbox` 在本轮恢复前的交接提交为
  `31f3e5fb5702ca9aaabb8cbec83fce327b1d1f6d`；本 checkpoint 所在提交继续推送到同一分支和
  PR #19。telegram-tt 分支精确停在
  `ed09836f6b73544aa2d16d8645afa138827f0cbc`。
- 两个隔离 worktree 均无未提交改动，并分别与
  `origin/codex/m3-telegram-outbox`、`imhub/codex/m3-telegram-outbox` 一致。
- PR #19 为 OPEN、CLEAN、非 Draft，暂无 checks 或 review decision；Issue #11/#12 均 OPEN。
  没有合并 PR，也没有关闭 Issue。
- 本轮 Electron、telegram-tt Vite 和 im-hub server 已停止；下次不能假设任何开发进程仍在运行。
- 只读恢复时 guest 从缓存上报 `account.identity`，主进程状态为 `ready`，但 Vite 网络层在
  `01:12:41` 和 `01:23:38` 再次收到 `SESSION_REVOKED`。根因是 GramJS 把这个错误与主 sender
  可忽略的 `AUTH_KEY_UNREGISTERED` 一起跳过，导致缓存身份掩盖已撤销的服务端会话。
  `ed09836f6b73544aa2d16d8645afa138827f0cbc` 只保留 `AUTH_KEY_UNREGISTERED` 的跳过语义，
  `SESSION_REVOKED`/`USER_DEACTIVATED` 会进入现有 broken → sign-out → bridge 撤权链。
- 修复没有在真实 partition 上热运行，避免未经用户处理登录就触发现有 signed-out 清理语义；没有
  尝试验证码、2FA、重登或外发。下次真实账号操作需要先由用户完成重新登录。
- 真实普通群文本发送、local-to-final remap、单行去重、快速连续编辑和单调 `editVersion` 已验收；
  PR #16/#17 与 Saved Messages 真实验收也早已完成，全部不要重复。
- 旧 `EDIT-10` 的两次删除确认实际已被 Telegram 平台异步执行；此前看似“消息仍在”的直接原因是
  GramJS worker 在网络接收返回空数据后访问 `body.length` 崩溃，客户端没有及时消费删除更新。
  `675df80d8d4b287bd1afc2dfe544b70d796581f0` 将空接收纳入既有重连路径并增加回归测试。完整冷启动
  后 Telegram 保持稳定，旧删除更新随后进入 `/api/native/events`，数据库聚合从 live 1、deleted 0
  收敛为 live 0、deleted 1；不要再操作 `EDIT-10`。
- 为验证修复后的平台删除，只在同一用户选定双人群发送了一条固定的删除专用标记，没有编辑，也
  没有复跑普通文本验收。唯一勾选的“对所有人删除”确认后标记从 Telegram 消失，outbox 为
  `pending=0, dead=0`。该新标记未进入 im-hub 数据库，因此它只证明平台删除路径恢复，不能单独
  作为新消息 upsert/delete 落库闭环证据；旧 `EDIT-10` 的补传才是本轮可审计的服务端删除证据。
- 共享 workspace `/Users/mac/Claude Code 工作区/代码/im-hub` 的既有用户改动从未被修改、清理、
  暂存或重置。后续继续使用隔离 worktree；如果 `/private/tmp` worktree 已被系统清理，从对应远端
  分支重新创建，不要转而在共享 workspace 工作。
- 下一主线先是用户重新登录 Telegram；随后继续 Issue #12 剩余真实故障矩阵。普通群删除已有
  恢复证据；优先在再次确认安全目标后覆盖频道删除与频道编辑，再做媒体、多账号 partition、
  dead-letter 容量与运维恢复；不要把 M3-5 shadow reconciliation 混入 PR #19。
- 修改 `src/api/gramjs/**` 后必须完整停止并重启 Electron，不能把 Vite `page reload` 当成
  SharedWorker 已更新的证据。

清理上下文后可直接粘贴下面这段作为新任务：

```text
从 jojo8233/CLOT-imhub 的最新 origin/main 和现有 PR #19 继续 M3-4。先读 AGENTS.md、
docs/superpowers/plans/2026-08-27-m3-telegram-outbox-handoff.md，以及 telegram-tt 仓库自己的
CLAUDE.md/AGENTS.md；实时核对 PR #19、Issue #11/#12 和两个远端分支。优先复用隔离 worktree
/private/tmp/im-hub-m3-outbox 与 /private/tmp/telegram-tt-m3-outbox；若已被清理，从远端
codex/m3-telegram-outbox 分支重建。不要修改共享 workspace 的既有用户改动，不要重复 PR #16/#17、
Saved Messages、普通群 TEXT-A/EDIT-10 验收。以最新交接记录为事实入口，继续 Issue #12 尚未完成的
真实故障矩阵；任何可能向外部发送/删除消息的步骤先限定安全目标。不要合并 PR 或关闭 Issue，除非
我再次明确授权。
```

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
  `ed09836f6b73544aa2d16d8645afa138827f0cbc fix: propagate revoked Telegram sessions`，建立在
  `675df80d8d4b287bd1afc2dfe544b70d796581f0 fix: reconnect after empty GramJS receive`、
  `c60343e98a05936cab898d3dc08069d5e7524e9b im-hub Outbox: Serialize delivery pump`、
  `6c8d86a33dd4db37081051ccc192a36650777f15 fix: keep Telegram edit bridge in sync` 与
  `94bfc962abc942c331f607209ccb4057ae8d0880 feat: add persistent im-hub message outbox` 之上。
  五者均已推送到 `jojo8233/telegram-tt` 的 `codex/m3-telegram-outbox`。
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
- 当前提交：`ed09836f6b73544aa2d16d8645afa138827f0cbc`
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
- IndexedDB 等待期间的新入队只记录下一次调度请求；同账号始终只有一个异步发送泵，避免两个
  pump 同时读取并重复发送同一个队首事件，也避免 ACK 定时器句柄相互覆盖。
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
- GramJS `_recvLoop` 把连接返回空数据视为连接错误，复用既有 reconnect 流程；不再让
  `body.length` 的未捕获异常终止 worker 并使客户端停在 `waiting for network`。
- 主 sender 只忽略主连接初始化期间的 `AUTH_KEY_UNREGISTERED`；`SESSION_REVOKED` 与
  `USER_DEACTIVATED` 会发布 broken connection，让现有全局 sign-out 和 `account.signed-out`
  桥接撤销错误的 ready 状态。

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
- `src/lib/gramjs/network/MTProtoSender.test.ts` 覆盖空接收重连、撤销/停用会话进入 broken，以及
  主 sender 保留 `AUTH_KEY_UNREGISTERED` 原语义；`src/util/imhubMessages.test.ts` 覆盖普通 outgoing
  文本快照与 final delete 入队。连同既有 WebSocket 和 bridge 测试为 4 个文件、8 个测试通过。
- im-hub `packages/server/src/api/routes/native.test.ts` 22 个测试通过，使用派生 `_test` 数据库验证
  native grant、upsert、delete、remap 与拒绝路径。
- `git diff --check` 通过。
- 单泵竞态修复后再次运行 `npm run check:ts`、既有聚焦测试 1/1 与 `git diff --check`，均通过。

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

## 6. Permanent rejection 与单泵竞态探针

2026-08-27 使用两个固定、虚构且跨会话的 remap 事件验证 permanent rejection。两个事件只进入
telegram-tt IndexedDB、typed bridge 与本机 `/api/native/events`；服务端在 canonical 校验阶段
返回 422，不进入 Telegram，也不创建或修改数据库消息。

首次运行暴露了真实竞态：两个事件连续入队时，第一个 pump 尚在等待 IndexedDB，第二个 pump
也读取了同一个队首，导致首个事件产生两次 HTTP 请求和两次 ACK；后一个 ACK timer 覆盖前一个
句柄，队列已经 `pending=0, dead=2` 后仍误报 `ack_timeout`。

telegram-tt `c60343e98a05936cab898d3dc08069d5e7524e9b` 将异步 pump 串行化并保留等待中的调度请求。
完整重启 Electron 后用相同两个事件回归：每个事件各产生一次 guest event、一次 HTTP 422 和
一次 permanent ACK；状态按 `pending=2/dead=0`、`1/1`、`0/2` 收敛，第二个永久失败没有被第一个
阻塞。继续等待超过 ACK 的 10 秒上限，没有再出现虚假 timeout。

探针使用无效占位 Telegram API 参数启动 Vite，没有读取 telegram-tt `.env`，也没有建立可用的
Telegram 外发能力。两个固定 eventId 对应的 pending/dead-letter 记录随后已精确清理，partition
恢复 `pending=0, dead=0`；临时注入与匿名计数诊断均已移除，未进入提交。

该结果覆盖 permanent rejection 的移出队首、后续事件继续发送以及并发调度故障，不覆盖
dead-letter 满容量和运维恢复路径，也不替代真实频道、媒体或多账号验收。

## 7. 非 Saved Messages 真实文本验收

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

## 8. 故障矩阵进度

Issue #12 已有可审计证据：刷新、Electron 进程终止、断网恢复、本地 ACK 丢失、私密频道文本/
编辑/删除、图片、文件，以及 dead-letter 满容量和人工恢复。语音由用户明确跳过；回复尚未执行；
两个账号同时积压因只有一个已绑定的真实 Telegram identity 而未完成。

任何补充真实矩阵仍可能向外部联系人发送消息；开始前先限定安全目标，不要重复已经完成的 Saved
Messages 或上述证据。M3-5 的 TDLib/telegram-tt shadow reconciliation 和历史缺口扫描也不属于
本提交。

## 9. 普通群删除故障定位与恢复验证

2026-08-28 在用户明确要求继续后，只把既有环境加载到隔离 worktree 进程；没有输出、复制或
记录任何变量值。先保持外部操作只读，沿原有 `EDIT-10` 证据追踪 renderer、GramJS worker、
typed bridge、HTTP 与数据库状态。

- 旧 `EDIT-10` 最终从 Telegram 消失，说明此前删除 RPC 已在平台侧异步成功；当时 outbox 为
  `pending=0, dead=0`，数据库仍为 `1 live / 0 deleted`，表明客户端尚未消费/上报对应 update。
- 临时只传递异常 stack 的诊断把故障固定到 `MTProtoSender._recvLoop`：活动连接的 `recv()` 在
  断开边界返回了 `undefined`，随后对 `body.length` 的访问形成未捕获异常，worker 退出并进入
  `waiting for network`。诊断代码定位后全部撤销，未进入提交。
- telegram-tt `675df80d8d4b287bd1afc2dfe544b70d796581f0` 在 `recv()` 后检查空数据并抛入现有 catch，
  由 `handleConnectionError()` 执行 reconnect；对应单元测试证明空接收会调用重连而不是从
  `_recvLoop` 泄漏异常。
- 完整停止并重启 Electron 后在本轮删除验收窗口内保持稳定，没有再次出现同类未捕获 worker
  异常。服务端随后
  收到一次 `/api/native/events` 200，数据库中的 `EDIT-10` 由 `1 live / 0 deleted` 收敛为
  `0 live / 1 deleted`。结合新标记没有任何数据库行，这是旧删除 update 在恢复连接后补传的
  证据；该结论不依赖消息或会话 id，也没有把 M3-5 主动 shadow reconciliation 混入 PR。
- 为验证修复后的平台删除，只在同一用户选定的双人群发送固定标记
  `IMHUB-M3-OUTBOX-20260828-DELETE-1` 作为一次性删除前置条件，没有编辑，也没有重复
  TEXT-A/EDIT-10 验收。确认该标记是唯一 final outgoing 消息、删除弹窗只有一个勾选的
  `Delete for everyone` 后，只确认一次。标记随后从 Telegram DOM 消失，Composer 为空，outbox
  收敛为 `pending=0, dead=0`。
- 新标记在 im-hub 数据库中为 0 行，因此本轮不把它宣称成新的 upsert/delete 服务端闭环；它只
  验证平台删除路径在 worker 修复后可用。旧 `EDIT-10` 的 delayed update 则覆盖了实际
  `message.deleted` 经 bridge 到服务端落库。后续若要解释新标记为什么未进入中央 updater，须先
  做不外发的状态/单元诊断，不能再发送或删除同类消息来碰运气。
- 安全目标发现仍只有非 creator 的普通群，没有可证明为当前账号自建并可清理的频道/群。本轮未
  执行频道编辑/删除、图片、文件或语音外发，也没有新建频道或扩大外部影响。
- 删除证据完成后，Vite 的缓冲输出在 `00:23:20` 记录了 `SESSION_REVOKED`。后续只读恢复确认它
  是持续存在但被缓存 identity 掩盖的服务端会话撤销；根因、修复与未热运行边界见下一节。

所有阶段诊断代码均已撤销；CDP、截图与调试端口临时文件在收尾时精确删除，server、Vite、
Electron 已停止。telegram-tt 修复已推送，im-hub 仅保留本交接与规格更新等待提交。

## 10. 无外发鉴权与消息链诊断

2026-08-28 继续前先把操作限定为只读鉴权和本地自动测试，没有发送、编辑或删除 Telegram 消息：

- 隔离 server、Vite 与 Electron 启动后，guest 上报 `bridge.ready`、`account.identity`，主进程控制
  状态为 `ready`，持久 outbox 为 `pending=0, dead=0, sending=false`。这只证明缓存身份和 bridge
  可用，不证明 Telegram 服务端 auth key 仍有效。
- 同一运行窗口的 Vite 日志两次出现 `SESSION_REVOKED`，但没有 `account.signed-out`；主进程仍为
  ready。`MTProtoSender._recvLoop` 对 `AUTH_KEY_UNREGISTERED`、`SESSION_REVOKED` 和
  `USER_DEACTIVATED` 统一调用 `_handleBadAuthKey(true)`，其中 `true` 会让 main sender 直接返回。
- telegram-tt `ed09836f6b73544aa2d16d8645afa138827f0cbc` 只在错误确为
  `AUTH_KEY_UNREGISTERED` 时传入跳过标志；撤销或停用会话会发布 `connectionStateBroken`，现有全局
  updater 随后执行 sign-out，并让 im-hub bridge 撤销控制能力。单元回归同时锁住三个错误分支。
- 修复后的 worker 没有在真实 partition 上启动，因为现有 sign-out 语义会清除该 partition 的
  storage/cache。进程已在热重载只提示 page reload、旧 SharedWorker 仍存活时停止；没有触发重登、
  验证码、2FA 或新的外部状态变化。
- `imhubMessages` 新测试证明普通 outgoing 文本会生成完整 `message.upsert` 快照，final id 删除会
  生成 `message.deleted`；服务端 native route 22 个测试也证明 upsert/delete/remap 落库链正常。
  因而本轮没有复现删除专用新标记的 reporter 或服务端代码缺陷。
- 已 ACK 的 outbox 记录按设计从 IndexedDB 删除，服务端也不持久化 eventId 审计，所以此前新标记
  “数据库 0 行”无法在事后唯一归因于未入队、会话撤销时序或观察窗口。它现在作为不确定的历史
  观察保留，不再写成已确认的中央 updater 故障，也不通过再次外发来补证据。

下一步必须由用户完成 Telegram 重新登录。重新登录前不要启动修复后的真实 Electron 验收，也不要
继续频道/媒体等外部矩阵。

## 11. 恢复顺序

1. 读根 `AGENTS.md`、本交接和 outbox 规格。
2. 刷新 PR #16/#17/#18、Issue #11/#12、两个仓库远端与 worktree 状态。
3. 检查 PR #19 的 checks/review；不要在没有新证据时关闭 Issue #12。
4. 由用户完成 Telegram 重新登录；不得读取、记录或代填验证码/2FA。
5. 在明确限定安全目标后执行 Issue #12 真实故障矩阵，并把可审计结果写入 Issue；不要重复
   Saved Messages 验收。
6. 不操作共享 workspace 的既有用户改动，不重做 PR #16/#17。

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

## 12. 最新续验 checkpoint：真实回复 temp id 跨重启碰撞已修复并复验

2026-08-28 在用户再次确认后，只在此前媒体验收对应的 Telegram 私聊中回复一条现有己方消息，
发送固定标记 `IMHUB-M3-OUTBOX-20260828-REPLY-1`，并按约定保留该消息、没有删除。执行前通过
数据库关联与 Telegram DOM 同时确认目标唯一、条目为 private、会话 hash 一致、Composer 可用；
没有进入列表中显示为 `2 members` 的群聊。

本次平台侧结果成功：新消息有唯一 final message id，outgoing status 为 `succeeded`，消息内存在
reply preview，Composer 和 reply 状态均清空。服务端随后按顺序收到 remap 与 final upsert 两个
`/api/native/events` 请求并各返回 200，外壳没有 pending、dead-letter 或 retry 错误提示。

数据库闭环失败，因此回复矩阵仍不能勾选：

- 固定标记精确正文计数为 0；按 Telegram DOM 的 final message id 关联时能找到 1 行，但该行仍是
  08:00:52 的旧正文长度、`reply_to_platform_message_id=null` 且 `deleted_at` 非空。
- telegram-tt 的 GramJS local message id 由“会话 last id + 模块内计数器”组成；完整页面重启会
  重置计数器。旧设计 `<chatId>:temp:telegram-tt:<localId>` 因而复用了早先已删除消息的 temp 键。
- remap 把旧 temp 行改到新 final id；紧随其后的 base upsert按既有幂等语义只判重复，不覆盖旧正文
  或删除状态。两次 HTTP 200 与 outbox 清空只证明事件被接受，不能证明消息快照正确。

修复限定在身份生成与兼容解析，不直接改写现有数据库行：

- telegram-tt `95a65e5ba9166193abd582470f8133303c2ea72b` 的新 temp 键为
  `<chatId>:temp:telegram-tt:<32-hex instanceId>:<localId>`；每个页面实例使用独立随机命名空间，
  同一次发送的 local upsert 与 remap 仍共享同一键。
- im-hub shared parser 同时接受新键和旧四段键，已有 IndexedDB pending 记录仍可补传；新旧键都继续
  受 canonical chat/source/local id 校验。
- 没有采用“自动覆盖不同 sentAt 的既有 final 行并清除 deleted/translation”的自愈方案，因为它会
  对持久数据做不可逆改写。错误行原样保留为审计证据。

修复后的自动验证：im-hub `pnpm typecheck` 通过；shared canonical id 聚焦测试 1 个文件、6 个用例
通过；native route 22 个测试在派生 `_test` 库通过，并由现有 remap 用例覆盖新 temp 键；telegram-tt
`npm run check:ts` 通过；两个 worktree 的 `git diff --check` 通过。没有重跑已完成的真实故障矩阵。

修复后复验已完成。用户对第二条固定标记
`IMHUB-M3-OUTBOX-20260828-REPLY-2` 做了操作时确认；随后从 im-hub `03b9644` 与 telegram-tt
`95a65e5` 冷启动两个隔离 worktree，只在同一媒体验收私聊中回复一条现有己方消息，并按约定保留，
没有进入其他会话或重复已完成矩阵。发送前目标会话计数为 1，数据库 exact body 计数为 0。

修复后的闭环证据如下：

- Telegram DOM 中该标记精确出现 1 次，消息带 reply preview 和非 temp 的 final message id；发送后
  Composer 与 reply 状态均清空。
- 服务端接受对应 `/api/native/events` 请求并返回 200。开发数据库 exact body 聚合为
  `1|1|1|1|1`，依次代表总行数、非空 reply key、唯一平台消息键、live 行和 `direction='out'` 行，
  证明新快照没有复用第一次的旧删除行。
- 桌面壳没有 pending、dead-letter、等待重试或服务端拒绝提示。`REPLY-1` 与 `REPLY-2` 均按用户
  约定保留；没有对旧错误行做覆盖或清理。

真实回复矩阵现已完成，不要再次发送回复标记。语音继续按用户决定跳过；双账号同时积压仍因只有
一个已绑定真实 identity 而阻塞。PR #19 与 Issue #12 保持打开，不合并、不关闭。

收尾补充：两次未处理的 `SESSION_REVOKED` 字符串由非主 DC 文件 sender 超时与主会话撤销共用文案
引起；普通 Error 没有进入只识别 `RPCError` 的清理/重试分支。telegram-tt `77788bd` 为该超时加入
独立内部类型，重试耗尽后转为现有可忽略的 `USER_CANCELED`，真实主连接的 broken 处理保持不变。
`npm run check:ts` 和现有 MTProtoSender 4 个测试通过。修复后只读冷启动恢复 1 个已选账号、4 个
Telegram 会话；打开原媒体验收私聊后 20 条消息与 Composer 在旧 60 秒窗口后仍正常，没有新的
`SESSION_REVOKED`、退出或 outbox 错误。本轮没有发送消息、修改设置或重登。
