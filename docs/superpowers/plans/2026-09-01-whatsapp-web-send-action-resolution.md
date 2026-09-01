# WhatsApp Web Send Action Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 安全解析当前 WhatsApp composer 的唯一原生发送控件，并在保持 attempt/revision/SHA-256 与最终出站 DOM ID 门槛的前提下完成最多一条真实发送。

**Architecture:** 新增无 jsdom 的泛型 send-action resolver，由结构化 DOM port 提供查询、交互祖先与可用性事实；生产 bridge 只负责把真实 `HTMLElement` 适配到该端口。发送链在 pending attempt 写入前后各解析一次，第二次必须仍返回同一个 target，任何缺失、禁用或歧义都在点击前失败。

**Tech Stack:** Node.js 22、pnpm 10、TypeScript ESM strict、Vitest、Electron 33 preload、浏览器 DOM/IndexedDB。

**Spec:** `docs/superpowers/specs/2026-09-01-whatsapp-web-send-action-resolution-design.md`

## Global Constraints

- 必须复用 `/private/tmp/im-hub-m3-outbox` 与分支 `codex/m5-m6-signal-whatsapp`；不得创建新 worktree 或修改主 checkout。
- 使用 pnpm；源码相对导入保留 `.js`，类型导入使用 `import type`；不得使用 `any`、`@ts-ignore` 或非空断言绕过类型边界。
- 不读取、打印或提交 `.env`、WhatsApp/Signal profile/session、数据库正文、账号标识、具体消息键、媒体引用、token、二维码或密钥。
- 不修改 Telegram、Signal、Cloud API、IPC/native bridge 协议、composer 草稿写入或平台消息 ID 算法。
- 不增加 Enter、键盘快捷键、坐标、颜色、按钮位置或任意 SVG fallback；只接受当前 composer footer 内明确、唯一、可见、已连接且未禁用的 send action。
- `attemptId`、初始 `contextRevision` 与最终草稿 SHA-256 绑定不变；pending/unknown 阻止重发；成功仍要求发送前不存在、正文匹配、方向为出站且有实际 WhatsApp DOM `data-id`。
- 双击、切会话、用户改稿、命令超时、结果丢失和进程重启只用合成测试；真实平台最多由用户手动发送一条无敏感纯文字。
- 新测试包从 `/private/tmp/Signal-imhub-integrated-a50.app` 不透明配置生成 `/private/tmp/Signal-imhub-integrated-a51.app`；不得打开或打印配置内容。
- 不重启服务端或 Telegram；不合并 PR #19，不关闭 Issue #12。

---

### Task 1: Build the structural WhatsApp send-action resolver

**Files:**
- Create: `packages/desktop/src/preload/whatsapp-web-send-action.ts`
- Create: `packages/desktop/src/preload/whatsapp-web-send-action.test.ts`

**Interfaces:**
- Consumes: 无；只消费调用方提供的结构化 DOM port。
- Produces:
  - `WhatsAppSendActionDomPort<Node extends object>`
  - `WhatsAppSendActionUnavailableReason`
  - `WhatsAppSendActionResolution<Node extends object>`
  - `resolveWhatsAppSendAction<Node>(scope, port)`
  - `whatsappSendActionRemainsCurrent<Node>(target, resolution)`

- [ ] **Step 1: Write the failing structural fake tests**

在 `whatsapp-web-send-action.test.ts` 定义不依赖 jsdom 的 fake：

```ts
interface FakeNode {
  name: string
  parent: FakeNode | null
  connected: boolean
  visible: boolean
  disabled: boolean
  ariaLabel: string | null
  interactive: boolean
  matches: Set<string>
}
```

fake port 的 `query(scope, selector)` 只返回 scope 子树中 `matches.has(selector)` 的节点；
`interactiveTarget(signal)` 沿 parent 向上找到第一个 `interactive=true` 节点；`isWithin` 沿 parent 校验边界。

先覆盖以下精确行为：

```ts
it('send icon 自身是 role button 时解析为唯一发送动作', () => {})
it('send icon 位于 button 后代时返回其交互祖先', () => {})
it('精确 compose send test id 可以解析', () => {})
it('同一 target 被多个强信号命中时只算一个', () => {})
it('断连、隐藏、disabled、aria-disabled 和 scope 外 target 不可用', () => {})
it('两个不同强 target 同时可用时返回 ambiguous', () => {})
it('强 target 存在但不可用时不降级到 aria target', () => {})
it('aria 只精确接受 send、发送和发送消息', () => {})
it('二次解析必须仍返回同一个 target', () => {})
it('scope 为空时返回 no-scope', () => {})
```

- [ ] **Step 2: Run the resolver test and verify RED**

Run:

```bash
pnpm exec vitest run packages/desktop/src/preload/whatsapp-web-send-action.test.ts
```

Expected: FAIL，报错说明 `whatsapp-web-send-action.js` 不存在。

- [ ] **Step 3: Implement the exact resolver contracts**

新文件导出：

```ts
export interface WhatsAppSendActionDomPort<Node extends object> {
  query(scope: Node, selector: string): readonly Node[]
  interactiveTarget(signal: Node): Node | null
  isWithin(scope: Node, target: Node): boolean
  isConnected(target: Node): boolean
  isVisible(target: Node): boolean
  isDisabled(target: Node): boolean
  ariaLabel(target: Node): string | null
}

export type WhatsAppSendActionUnavailableReason =
  | 'no-scope'
  | 'missing'
  | 'unusable'
  | 'ambiguous'

export type WhatsAppSendActionResolution<Node extends object> =
  | { kind: 'resolved'; target: Node }
  | { kind: 'unavailable'; reason: WhatsAppSendActionUnavailableReason }
```

selector 和 aria allowlist 固定为：

```ts
const STRONG_SEND_SIGNAL_SELECTORS = [
  '[data-testid="compose-btn-send"]',
  '[data-testid="send"]',
  '[data-icon="send"]',
] as const

const ARIA_SEND_SIGNAL_SELECTOR = 'button[aria-label], [role="button"][aria-label]'
const SEND_ARIA_LABELS = new Set(['send', '发送', '发送消息'])
```

实现使用对象身份 `Set<Node>` 去重。强信号只要映射出 scope 内 target，就必须在强信号级别得出
`resolved/unusable/ambiguous`，不能降级到 aria。只有没有任何强 target 时才读取 aria target；aria 值以
`trim().toLocaleLowerCase()` 规范化后做精确集合匹配。

核心控制流固定为：

```ts
export function resolveWhatsAppSendAction<Node extends object>(
  scope: Node | null,
  port: WhatsAppSendActionDomPort<Node>,
): WhatsAppSendActionResolution<Node> {
  if (!scope) return { kind: 'unavailable', reason: 'no-scope' }

  const strongTargets = targetsForSignals(
    scope,
    STRONG_SEND_SIGNAL_SELECTORS.flatMap(selector => port.query(scope, selector)),
    port,
  )
  if (strongTargets.length > 0) return resolveLevel(strongTargets, port)

  const ariaTargets = targetsForSignals(
    scope,
    port.query(scope, ARIA_SEND_SIGNAL_SELECTOR),
    port,
  ).filter(target => SEND_ARIA_LABELS.has(
    (port.ariaLabel(target) ?? '').trim().toLocaleLowerCase(),
  ))
  if (ariaTargets.length === 0) return { kind: 'unavailable', reason: 'missing' }
  return resolveLevel(ariaTargets, port)
}

export function whatsappSendActionRemainsCurrent<Node extends object>(
  target: Node,
  resolution: WhatsAppSendActionResolution<Node>,
): boolean {
  return resolution.kind === 'resolved' && resolution.target === target
}
```

`targetsForSignals` 必须拒绝 `interactiveTarget=null` 和 scope 外 target；`resolveLevel` 先过滤未连接、
不可见或 disabled target，0 个返回 unusable，1 个 resolved，2 个以上 ambiguous。

- [ ] **Step 4: Run Task 1 tests and lower-level typecheck**

Run:

```bash
pnpm exec vitest run packages/desktop/src/preload/whatsapp-web-send-action.test.ts
pnpm --filter @im-hub/desktop exec tsc --noEmit
```

Expected: resolver 10 个测试全部 PASS；desktop TypeScript exit 0。

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/desktop/src/preload/whatsapp-web-send-action.ts packages/desktop/src/preload/whatsapp-web-send-action.test.ts
git commit -m "feat: resolve WhatsApp send actions structurally"
```

---

### Task 2: Wire the resolver into the guarded WhatsApp send flow

**Files:**
- Modify: `packages/desktop/src/preload/whatsapp-web-bridge.ts:68-86`
- Modify: `packages/desktop/src/preload/whatsapp-web-bridge.ts:434-558`
- Modify: `packages/desktop/src/preload/whatsapp-web-bridge.ts:880-931`
- Modify: `packages/desktop/src/preload/whatsapp-web-send.ts:70-91`
- Modify: `packages/desktop/src/preload/whatsapp-web-send.test.ts:61-79`
- Test: `packages/desktop/src/preload/whatsapp-web-send-action.test.ts`

**Interfaces:**
- Consumes: Task 1 `WhatsAppSendActionDomPort`、`resolveWhatsAppSendAction`、`whatsappSendActionRemainsCurrent`。
- Produces: production bridge 的唯一 send-action 路径；既有 `startWhatsAppWebBridge(api)` 与 host/guest 协议不变。

- [ ] **Step 1: Write the failing preflight test for target identity**

在 `whatsapp-web-send.test.ts` 把既有 preflight fixture 改为：

```ts
const valid = {
  contextMatches: true,
  preparedDraft: 'synthetic outbound text',
  currentDraft: 'synthetic outbound text',
  sendActionCurrent: true,
}
expect(whatsappSendPreflightStillValid(valid)).toBe(true)
expect(whatsappSendPreflightStillValid({ ...valid, contextMatches: false })).toBe(false)
expect(whatsappSendPreflightStillValid({ ...valid, currentDraft: 'user edited text' })).toBe(false)
expect(whatsappSendPreflightStillValid({ ...valid, sendActionCurrent: false })).toBe(false)
```

这把“仍连接”收紧为“第二次解析仍是同一唯一 target”。

- [ ] **Step 2: Run the send test and verify RED**

Run:

```bash
pnpm exec vitest run packages/desktop/src/preload/whatsapp-web-send.test.ts
```

Expected: FAIL，TypeScript/Vitest 指出旧实现仍要求 `sendTargetConnected`，没有消费
`sendActionCurrent`。

- [ ] **Step 3: Strengthen the pure send preflight**

在 `whatsapp-web-send.ts` 把输入改为：

```ts
export function whatsappSendPreflightStillValid(input: {
  contextMatches: boolean
  preparedDraft: string
  currentDraft: string
  sendActionCurrent: boolean
}): boolean {
  return input.contextMatches
    && input.currentDraft === input.preparedDraft
    && input.sendActionCurrent
}
```

不得改变 attempt guard、fingerprint 或最终 DOM candidate 逻辑。

- [ ] **Step 4: Add the production HTMLElement port**

在 bridge 导入 Task 1 接口与函数，删除 `SEND_BUTTON_SELECTORS`。在模块级定义：

```ts
const whatsappSendActionDomPort: WhatsAppSendActionDomPort<HTMLElement> = {
  query: (scope, selector) => [...scope.querySelectorAll<HTMLElement>(selector)],
  interactiveTarget: signal => signal.matches('button, [role="button"]')
    ? signal
    : signal.closest<HTMLElement>('button, [role="button"]'),
  isWithin: (scope, target) => scope === target || scope.contains(target),
  isConnected: target => target.isConnected,
  isVisible: target => {
    const style = window.getComputedStyle(target)
    return target.getClientRects().length > 0
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.pointerEvents !== 'none'
      && style.opacity !== '0'
  },
  isDisabled: target => target.matches(':disabled, [aria-disabled="true"]'),
  ariaLabel: target => target.getAttribute('aria-label'),
}
```

新增私有纯 DOM 边界函数：

```ts
function resolveSendAction(input: HTMLElement) {
  return resolveWhatsAppSendAction(
    input.closest<HTMLElement>('footer'),
    whatsappSendActionDomPort,
  )
}
```

删除旧 `sendButton()`；不得保留平行 selector 路径或 Enter fallback。

- [ ] **Step 5: Rewire the first and second send-action checks**

在草稿 fingerprint 通过后首次解析：

```ts
const sendAction = resolveSendAction(input)
if (sendAction.kind !== 'resolved') {
  this.emitCommandFailure(
    command,
    'whatsapp_send_unavailable',
    '未找到唯一可用的 WhatsApp 发送控件',
  )
  return
}
const sendTarget = sendAction.target
```

然后才执行 `beforeIds` 快照和 `writeWhatsAppAttempt(attempt)`。

pending 写入后计算：

```ts
const contextMatches = this.commandMatchesContext(command)
const currentDraft = composerText(input)
const currentSendAction = resolveSendAction(input)
const sendActionCurrent = whatsappSendActionRemainsCurrent(sendTarget, currentSendAction)

if (!whatsappSendPreflightStillValid({
  contextMatches,
  preparedDraft: draft,
  currentDraft,
  sendActionCurrent,
})) {
  await discardWhatsAppAttempt(command.attemptId)
  if (contextMatches && currentDraft === draft && !sendActionCurrent) {
    this.emitCommandFailure(command, 'whatsapp_send_unavailable', 'WhatsApp 发送控件已经变化')
  } else {
    this.emitCommandFailure(command, 'attempt_context_mismatch', 'WhatsApp 会话或输入框在发送前已经变化')
  }
  return
}
```

保持现有 ledger 清理失败分支；只有上述全部通过才允许 `sendTarget.click()` 一次。点击后的 6 秒 DOM
确认、pending unknown 与 confirmed 写回原样保留。

- [ ] **Step 6: Run all affected synthetic regressions**

Run:

```bash
pnpm exec vitest run \
  packages/desktop/src/preload/whatsapp-web-send-action.test.ts \
  packages/desktop/src/preload/whatsapp-web-send.test.ts \
  packages/desktop/src/preload/whatsapp-web-composer.test.ts \
  packages/desktop/src/preload/whatsapp-web-utils.test.ts \
  packages/desktop/src/preload/whatsapp-web-health.test.ts \
  packages/desktop/src/main/native-command-delivery.test.ts \
  packages/desktop/src/renderer/native-bridge.test.ts \
  packages/desktop/src/renderer/store.test.ts \
  packages/desktop/src/renderer/components/NativeClient.test.ts \
  packages/desktop/src/renderer/components/TranslationDock.test.ts
```

Expected: 全部 PASS；双击、改绑、改稿、切会话、焦点、命令超时、结果丢失、重启恢复和最终 DOM ID
既有测试语义不变。

- [ ] **Step 7: Run typecheck and desktop build**

Run:

```bash
pnpm typecheck
pnpm --filter @im-hub/desktop build
git diff --check
```

Expected: 三条命令 exit 0；main、preload、renderer bundle 均成功；无 ESM/type/DOM port 错误。

- [ ] **Step 8: Commit Task 2**

```bash
git add \
  packages/desktop/src/preload/whatsapp-web-bridge.ts \
  packages/desktop/src/preload/whatsapp-web-send.ts \
  packages/desktop/src/preload/whatsapp-web-send.test.ts
git commit -m "fix: resolve the current WhatsApp send action"
```

---

### Task 3: Verify, package a51 and perform the single real acceptance

**Files:**
- Modify: `docs/superpowers/specs/2026-08-29-signal-whatsapp-parallel-checkpoint.md`
- Verify only: all Task 1-2 code and tests

**Interfaces:**
- Consumes: Task 1 resolver、Task 2 production wiring、现有 package preparation script。
- Produces: 完整验证证据、`/private/tmp/Signal-imhub-integrated-a51.app`、最多一条真实发送结论和新 checkpoint。

- [ ] **Step 1: Run the complete test suite**

Run:

```bash
pnpm test
```

Expected: 全量 PASS，既有 todo 保留。若沙箱仅因本机 PostgreSQL `EPERM` 失败，用完全相同命令申请
沙箱外重跑；不得加载或打印 `.env` 或数据库 URL。

- [ ] **Step 2: Run final typecheck, desktop build and scope checks**

Run:

```bash
pnpm typecheck
pnpm --filter @im-hub/desktop build
git diff --check fff23a5..HEAD
git status --short --branch
git diff fff23a5..HEAD --stat
```

Expected: typecheck/build/diff check exit 0；tracked diff 只包含批准的 send-action resolver、bridge/send
测试、设计/计划和 checkpoint，不含 `.env`、profile/session、构建产物或其他平台源码。

- [ ] **Step 3: Generate a51 without inspecting opaque configuration**

先只检查 output 不存在：

```bash
test -d /private/tmp/Signal-imhub-integrated-a50.app
test ! -e /private/tmp/Signal-imhub-integrated-a51.app
```

通过后运行：

```bash
pnpm --filter @im-hub/desktop prepare:signal -- \
  --source /Applications/Signal.app \
  --output /private/tmp/Signal-imhub-integrated-a51.app \
  --profile-source /private/tmp/Signal-imhub-integrated-a50.app
/usr/bin/codesign --verify --deep --strict /private/tmp/Signal-imhub-integrated-a51.app
```

Expected: script 报告 Signal Desktop 8.25.0，codesign exit 0。不得打开或打印 a50/a51 配置。

- [ ] **Step 4: Start a51 without restarting server or Telegram**

确认 a50/a51 没有并发运行后启动：

```bash
open -na /private/tmp/Signal-imhub-integrated-a51.app
```

只打开现有 WhatsApp 会话；不重做平台切换、Signal、登录、气泡翻译或滚动矩阵。

- [ ] **Step 5: Perform one controlled TranslationDock send**

用户输入一条无敏感纯文字并点击“翻译”，先反馈：

```text
原生草稿：新译文单份/否则描述
发送按钮：可用/禁用
错误诊断：无/稳定错误文案
```

只有“新译文单份、发送按钮可用、错误诊断无”才允许用户点击一次发送。点击后只反馈：

```text
已点击发送：一次
发送状态：成功/操作失败/结果未知
原生草稿：已清空/未清空
WhatsApp 新出站消息：有/无/不确定
错误诊断：无/稳定错误文案
```

不得回传正文、账号或 DOM ID。只有 guest 已取得发送前不存在、正文匹配、方向为出站的实际 DOM
`data-id`，TranslationDock 才会显示成功。若状态为结果未知，立即停止，不得再次点击或新建 attempt。

- [ ] **Step 6: Append the exact checkpoint**

在 checkpoint 末尾新增：

```md
## 27. WhatsApp Web 结构化发送控件与最终 DOM ID checkpoint（2026-09-01）
```

只记录：

- resolver/DOM port/两次 target currentness 的边界；
- Task 1-2 定向测试和最终全量/typecheck/build 的实际结果；
- a51 从 a50 不透明配置生成及 deep/strict codesign 结果；
- 单次真实验收的实际反馈与真实发送总数；
- 成功时只写“guest 已确认最终 WhatsApp DOM ID”，不写具体 ID；失败或 unknown 时按事实记录；
- Telegram、Signal、composer 协议和消息 ID 未改，PR #19 未合并，Issue #12 未关闭。

- [ ] **Step 7: Commit the checkpoint and leave the branch clean**

Run:

```bash
git diff --check
git add docs/superpowers/specs/2026-08-29-signal-whatsapp-parallel-checkpoint.md
git commit -m "docs: checkpoint WhatsApp send action acceptance"
git status --short --branch
```

Expected: checkpoint 是唯一最后文档提交；worktree clean；分支仍为
`codex/m5-m6-signal-whatsapp`；PR #19 与 Issue #12 未改变。
