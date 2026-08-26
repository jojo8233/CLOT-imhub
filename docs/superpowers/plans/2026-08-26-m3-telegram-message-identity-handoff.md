# M3-1 Telegram 消息身份交接记录

日期：2026-08-26

用途：这是清理 Codex 上下文后的恢复入口。下一次任务先读取本文，再核对 Git 与 GitHub
实时状态；不要依赖旧聊天记录，也不要把本文中的历史状态当成远端仍未变化的证明。

## 1. 当前结论

M2 已通过 PR #7 合并。M3-1 的 canonical Telegram message id、Bridge v2、单调
`editVersion`、服务端约束和历史迁移已在本地实现并提交；telegram-tt 也已提交等价的
MTProto 侧 ID 工具。

两个新提交尚未推送。最后一次操作时 `github.com:443`、GitHub API 和 Codex GitHub
连接器均超时，因此未创建 M3-1 PR，也未更新 Issue #9。该现象是网络不可达，不是已知的
分支、代码或凭据错误。

## 2. im-hub Git 状态

- 仓库：`jojo8233/CLOT-imhub`
- 本地路径：`/Users/mac/Documents/Codex/CLOT fanyi/im-hub`
- 当前分支：`codex/m3-canonical-message-id`
- M3-1 实现提交：
  `4eaadf3064e43e2de404ac40137e57839c0a6bd6 feat: add M3 Telegram canonical message identity`
- 基线：
  `813c933642426c03e6cd2c5c273392c6bf9e27b6 Merge pull request #7 from jojo8233/codex/m2-native-bridge`
- 记录交接前，`main` 与本地缓存的 `origin/main` 都是 `813c933`；当前分支相对它领先
  1 个实现提交。
- 当前分支尚无 upstream；本地没有 `origin/codex/m3-canonical-message-id` 远端引用。
- PR #7 已合并，Issue #5 已关闭。
- M3 tracking Issues #8–#13 已创建；#8 已关闭，#9–#13 记录时仍待后续处理。
- M3-1 不应使用 `Closes #9`：真实账号 fixture、telegram-tt 实际接线和 shadow 对账
  尚未完成。PR 正文只写 `Refs #9`。

本文提交后，im-hub 分支会比 `4eaadf3` 再多一个纯文档交接提交；恢复时以当前分支 HEAD
为准，不要只推单个实现 commit。

## 3. telegram-tt Git 状态

- 仓库：`jojo8233/telegram-tt`（fork）；上游为 `Ajaxy/telegram-tt`
- 本地路径：`/Users/mac/Claude Code 工作区/代码/telegram-tt`
- 当前分支：`codex/m3-telegram-complete-loop`
- 本地 M3-1 提交：
  `5a6b1a1ebe9eb29cd00189b62fa1e7334c669aaa feat: add im-hub canonical Telegram message IDs`
- fork 远端同名分支当前停在：
  `b770dec09cf98db4600a01fe112da7d212902e8e chore: 清理 im-hub 补丁 lint 基线`
- 因此本地相对 `imhub/codex/m3-telegram-complete-loop` 领先 1 个提交。
- 当前工作分支已把 11 个既有 im-hub 补丁重放到上游
  `3cd724ed8ebf8e1c907ef75ffb4cdbdd1ed2dc0f`。
- rebase 前备份分支已在本地与 fork 远端保留：
  `codex/im-hub-patches-pre-rebase-20260826`，指向 `f89fa9c`。

telegram-tt 是独立 Git 仓库。进入后必须先读它自己的 `CLAUDE.md`/`AGENTS.md`，继续用
npm，不新增测试，不把 im-hub 补丁散到无关上游文件。

## 4. M3-1 已完成内容

详细规则见
`docs/superpowers/specs/2026-08-26-m3-telegram-message-identity.md`。

### 4.1 Canonical Telegram ID

- shared 新增 `packages/shared/src/telegram-message-id.ts`。
- 最终键固定为 `<chatId>:<MTProto serverMessageId>`。
- TDLib 只有正数且低 20 位为 0 的 `message.id` 才右移为 server id。
- TDLib 临时键为 `<chatId>:temp:tdlib:<localId>`。
- telegram-tt 临时键为 `<chatId>:temp:telegram-tt:<localId>`。
- chat int64、server id int32、规范十进制、负零、跨 chat remap 均有拒绝逻辑。
- TDLib normalize、发送返回值、send-success remap 已改用 shared helper。
- telegram-tt `src/util/imhub.ts` 已加入等价的构造与解析函数，但尚未接入 outbox。

### 4.2 Bridge v2 与编辑排序

- `NATIVE_BRIDGE_PROTOCOL_VERSION` 已从 1 升到 2。
- 新增 `account.identity { platformAccountExternalId }`。
- `composer.send` 必须携带稳定 `attemptId`，send 的 `command.result` 必须原样回显。
- `message.upsert` 必须携带 nullable `editVersion`；有版本时同时要求 `editedAt`。
- desktop runtime parser、pending command 校验、store identity 状态已同步。
- 数据库和消息仓储只接受更大的 version；一旦进入 versioned edit，不允许无版本事件
  重新覆盖。翻译 revision 使用 `version:<n>`。

### 4.3 服务端与数据迁移

- Telegram native context/event 会拒绝非 canonical chat/message/reply/delete/remap。
- remap 必须在同一 chat；仓储合并时优先保留更高 `editVersion` 的正文。
- migration `0005_telegram_canonical_message_ids` 增加 `messages.edit_version`。
- 旧 TDLib final/local/reply id 会迁入 canonical/temp 命名空间；旧 ID 先写 alias，兼容
  迁移前已排队事件。
- 未知格式、非法 chat、零/越界 ID、direct/alias 冲突、跨 chat reply、collapse 冲突会
  中止迁移，不静默猜测或合并。
- down migration 只移除 `edit_version`，不反向破坏 canonical ID 与 alias。

开发数据库没有执行 `0005`，也没有清表。迁移只在 `imhub_test` 和进程唯一的一次性测试库
验证；一次性测试库已自动删除。

## 5. 最终验证结果

im-hub 已提交版本：

- `pnpm typecheck`：通过。
- M3-1 相关测试：5 个文件、66 tests passed。
- `pnpm test`：31 个测试文件通过，302 passed，1 个既有 todo。
- `pnpm --filter @im-hub/desktop build`：通过。
- `git diff --check`：通过。
- `0005` 一次性数据库验证：非法 reply ID 会阻断；修正后的旧 final/temp/reply 数据迁移为
  预期 canonical 值，旧 alias 保留；测试库随后删除。

telegram-tt 已提交版本：

- `npm exec eslint -- src/util/imhub.ts`：通过。
- `npm run check:ts`：通过。
- 仓库规则明确要求不要新增测试，因此没有给该 fork 新增测试文件。

Electron/im-hub 与 telegram-tt 的开发窗口已关闭；记录时没有继续运行本次检查启动的程序。

## 6. 仍未完成，禁止写成已验收

1. 用真实 Telegram 账号采集私聊、普通群、频道和 topic 的 TDLib/telegram-tt 双来源 fixture，
   确认同一消息严格得到同一最终键。
2. telegram-tt 尚未发送 `bridge.ready`、`account.identity`、`context.changed`、composer
   result 或消息 outbox 事件；当前工具函数不是完整接线。
3. 持久 outbox、ACK/重试、同账号 single-flight/限流、稳定 attempt 发送幂等尚未完成。
4. TDLib + telegram-tt shadow 回传与数据库对账尚未开始。
5. 短时 account-control grant、实际平台身份绑定、移除 guest JWT 历史注入尚未完成。
6. 删除账号时平台登出并清理 `persist:native-<accountId>` 尚未完成。
7. telegram-tt 尚未实际提供单调编辑版本，所以不能宣称真实快速连续编辑闭环。
8. 本分支尚未经过 GitHub PR 审查，`0005` 也未在开发/生产数据上执行。

## 7. 下次启动的精确步骤

1. 读取根目录 `AGENTS.md`、native pivot、M2 bridge spec、M3 identity spec 和本文。
2. 分别确认两个仓库工作树干净；不要切到当前 workspace 中那个无远端、带用户改动的
   `/Users/mac/Claude Code 工作区/代码/im-hub` 仓库。
3. 网络恢复后先 fetch 并核对远端是否变化：

   ```bash
   git -C '/Users/mac/Documents/Codex/CLOT fanyi/im-hub' fetch origin
   git -C '/Users/mac/Documents/Codex/CLOT fanyi/im-hub' status --short --branch
   git -C '/Users/mac/Claude Code 工作区/代码/telegram-tt' fetch origin imhub
   git -C '/Users/mac/Claude Code 工作区/代码/telegram-tt' status --short --branch
   ```

4. 若 `origin/main` 仍与当前分支兼容，推送两个完整分支：

   ```bash
   git -C '/Users/mac/Documents/Codex/CLOT fanyi/im-hub' \
     push -u origin codex/m3-canonical-message-id
   git -C '/Users/mac/Claude Code 工作区/代码/telegram-tt' \
     push imhub codex/m3-telegram-complete-loop
   ```

5. 在 `jojo8233/CLOT-imhub` 创建非 Draft PR：
   - 标题：`feat: add M3 Telegram canonical message identity`
   - base：`main`
   - head：`codex/m3-canonical-message-id`
   - 正文总结 canonical ID、Bridge v2、`editVersion`、`0005` 和验证结果。
   - 只写 `Refs #9`，不要写 `Closes #9`。
6. 在 Issue #9 留下 PR、telegram-tt commit、验证结果及剩余真实 fixture/outbox/shadow
   边界；未经用户明确要求不要合并 PR。
7. PR 建立后再决定继续 M3-2，还是先根据 review 修正 M3-1。不要把未审查迁移直接跑到
   开发或生产数据库。

## 8. 可直接复制的新任务提示词

```text
读取 /Users/mac/Documents/Codex/CLOT fanyi/im-hub/AGENTS.md、
docs/superpowers/specs/2026-08-25-native-client-pivot.md、
docs/superpowers/specs/2026-08-26-m2-native-bridge.md、
docs/superpowers/specs/2026-08-26-m3-telegram-message-identity.md，以及
docs/superpowers/plans/2026-08-26-m3-telegram-message-identity-handoff.md。
核对 jojo8233/CLOT-imhub 的 main、Issue #9、当前 PR，以及两个本地仓库和远端分支状态。
从交接记录继续：优先推送 codex/m3-canonical-message-id 和 telegram-tt 的
codex/m3-telegram-complete-loop，创建 M3-1 PR（只 Refs #9，不关闭 Issue），再汇报远端变化
与下一步。不要擅自合并，不要运行开发/生产数据库迁移，也不要修改带用户改动的另一份
/Users/mac/Claude Code 工作区/代码/im-hub。
```
