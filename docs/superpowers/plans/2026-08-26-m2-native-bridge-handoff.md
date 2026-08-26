# M2 原生桥接交接记录

日期：2026-08-26

用途：这是可跨对话恢复的事实快照。清理 Codex 上下文后，下一次任务先读取本文，
再根据 Git/GitHub 的实时状态继续；不要只依赖旧聊天记录。

## 1. Git 与 GitHub 状态

- 仓库：`jojo8233/CLOT-imhub`
- 工作分支：`codex/m2-native-bridge`
- M2 实现提交：`900d0bd feat: implement M2 native bridge`
- 分支创建及最终 fetch 时，`main` 与 `origin/main` 都是
  `6e6cba651915cccf5ef2f2b1e8f35ff28cfcacce`
- Pull Request：[#7 feat: implement M2 native client bridge](https://github.com/jojo8233/CLOT-imhub/pull/7)
- PR 状态（记录时）：OPEN、非 Draft、MERGEABLE；GitHub 未报告自动 checks
- PR 正文使用 `Closes #5`，但没有执行合并

开始下一次任务时必须重新 `git fetch origin` 并核对上述状态，因为远端可能已经变化。

## 2. 已完成

- 在 `packages/shared` 定义版本化的原生会话、草稿、发送、消息回传与 ACK 协议。
- Electron 增加受控 guest preload、origin/partition/navigation/permission 策略；生产构建
  不显示 guest DevTools。
- 固定翻译输入坞已接入 `setDraft → getDraft → send`：发送前读取员工在原生输入框
  修改后的最终内容，并以 account/conversation/revision 防止切换期间误发或串稿。
- 服务端增加 owner-only 的 `/api/native/context`、`/api/native/events`，支持消息新增、
  编辑、删除和临时/最终 id remap。
- migration `0004_native_bridge_message_events` 增加 reply/edit/delete 与 message aliases。
- 消息生命周期已覆盖同账号进程内串行、多实例 advisory lock、remap 合并、编辑 revision、
  迟到译文拒绝、规范发布快照和 WebSocket 更新/删除/合并事件。
- auditor 只读门禁、恢复登录后的实时角色刷新，以及 HTTP/WS/账号切换竞态已收口。
- M2 规格、native pivot、RUNBOOK 和功能状态文档已同步。

详细设计与边界见
`docs/superpowers/specs/2026-08-26-m2-native-bridge.md`。

## 3. 最终验证结果

- `pnpm typecheck`：通过
- `pnpm test`：30 个测试文件通过，289 passed，1 个既有 todo
- `pnpm --filter @im-hub/desktop build`：通过
- `git diff --check`：通过
- 提交前工作树干净；`.env` 与 `packages/desktop/out/` 均为 ignored，未提交

## 4. 必须保持准确的产品表述

- 用户可操作的会话界面已经只保留原生 UI，不存在两套用户界面并行。
- TDLib/signal-cli 仍运行于后台，当前属于归档/回退来源，不能随意删除。
- telegram-tt 目前尚未发送 M2 原生消息事件，所以**当前不存在双路回传重复**。
- 重复消息风险发生在 M3 开启 TDLib + telegram-tt shadow 回传之后；进入 shadow 前必须
  先统一 canonical message id。
- M2 是平台无关合约与受控宿主基础完成，不代表 Telegram 真实运行闭环已经完成。

## 5. M3 生产阻断项

以下项目尚未完成，不能在 PR/文档中写成已验收：

1. telegram-tt fork 接入 `bridge.ready`、`context.changed`、composer 命令和持久 outbox；
   做真实多账号、媒体、发送、编辑/删除、重试与存档 E2E。
2. TDLib 与 telegram-tt 统一账号级 Telegram 消息键（目标形态
   `chatId:serverMessageId`，需用真实 fixture 确认），同步 reply/delete/remap 并迁移旧数据。
3. 移除 telegram-tt 的 `window.__IM_HUB__` 12 小时 JWT 历史注入，改为宿主代理或
   窄权限短时能力。新 typed bridge 本身不传 token，但整个 guest 目前仍能读取旧 JWT。
4. 服务端签发、Electron 主进程验证短时 account-control grant，并绑定 guest 实际登录的
   平台账号身份；renderer owner/auditor 判断不能作为生产安全边界。
5. `composer.send` 使用稳定 attempt id 做结果幂等；8 秒超时目前只能解释为“结果未知”。
6. 删除 im-hub 账号时退出平台会话并清理 `persist:native-<accountId>` partition。
7. 平台事件提供单调 edit/version；只有 `editedAt` 时，同一时间精度内的连续编辑无法排序。
8. outbox 做同账号 single-flight/窗口限流及连接池压力测试。

`../telegram-tt` 是独立仓库。只有下次任务明确要求开始 M3/修改它时才能进入；进入后先读
它自己的 `CLAUDE.md`/`AGENTS.md`，继续使用 npm，并保持补丁集中、最小化。

## 6. 下次启动步骤

1. 读取根目录 `AGENTS.md`、`CLAUDE.md`、M0 产品规格、native pivot、M2 规格和本文。
2. 读取 GitHub Issue #5 与 PR #7 的最新状态、评论和 checks。
3. 在 im-hub 执行 `git fetch origin`，确认工作树无未提交改动，并核对
   `main`、`origin/main`、`codex/m2-native-bridge` 的关系。
4. 若 PR #7 有审查意见，继续在当前分支修正、验证和推送；未经用户明确要求不要合并。
5. 若用户明确要求开始 M3，先确认 PR #7 是否已合并，再为 M3 重新梳理方案、迁移顺序、
   安全门槛和真实 E2E 验收，不要直接修改 telegram-tt。

## 7. 可直接复制的新任务提示词

```text
读取 AGENTS.md、CLAUDE.md、M0 产品规格、native client pivot、
docs/superpowers/specs/2026-08-26-m2-native-bridge.md，以及
docs/superpowers/plans/2026-08-26-m2-native-bridge-handoff.md。
再读取 GitHub Issue #5 和 PR #7，fetch origin 并核对本地/远端分支状态。
从交接记录的当前进度继续；先汇报远端是否变化、PR 是否有新反馈以及下一步方案，
不要擅自合并，也不要在未确认 M3 范围前修改 ../telegram-tt。
```
