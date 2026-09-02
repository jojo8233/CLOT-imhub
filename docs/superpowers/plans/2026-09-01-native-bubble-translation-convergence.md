# Native Bubble Translation Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Telegram 已验证的批处理/pending 行为与 Signal 已验证的结果绑定纪律收敛为无界面组件，并让 WhatsApp Web 气泡翻译通过平台 DOM 适配器复用它。

**Architecture:** `NativeTranslationCoordinator` 负责语言检测、目标分组、最多 20 条的网关批量请求、纠偏、逐项结果和缓存；新 `NativeBubbleTranslationController` 负责 500ms 聚合、最多 3 批并发、pending/成功/失败/reset 状态机；新 `WhatsAppWebTranslationAdapter` 把该状态机映射到 WhatsApp DOM marker。Telegram、Signal、composer/send 与各平台消息 ID 保持不变。

**Tech Stack:** TypeScript ESM、Vitest 2 fake timers、Electron 33 preload、WhatsApp Web DOM、pnpm 10、Node.js 22。

**Spec:** `docs/superpowers/specs/2026-09-01-native-bubble-translation-convergence-design.md`

## Global Constraints

- 只使用现有 worktree `/private/tmp/im-hub-m3-outbox` 和分支 `codex/m5-m6-signal-whatsapp`；不得创建 worktree 或修改主 checkout。
- 不增加依赖，不修改翻译服务端协议，不修改 Telegram fork 或 Signal 已验收路径。
- 不修改 `TranslationDock → composer.set-draft → composer.send`，不发送真实消息。
- 不复用 Telegram/Signal 消息 ID 算法处理 WhatsApp；平台消息身份继续由平台适配层拥有。
- 不读取或输出 `.env`、平台 profile/session、数据库正文、账号标识、具体消息键、媒体引用、token、二维码或密钥。
- 修复必须先写失败测试；禁止 `any`、`@ts-ignore`、非空断言和无关重构。
- 相对源码导入使用 `.js` 后缀，类型导入使用 `import type`，代码保持单引号、无分号和 2 空格缩进。
- 每次网关批量请求最多 20 条；聚合窗口 500ms；最多 3 个活动批次；成功缓存最多 500 条。
- 真实复验只使用既有入站/出站纯文字和滚动加载；不重复平台切换、Signal、登录、生命周期、503 outbox 或发送矩阵。
- 不合并 PR #19，不关闭 Issue #12。

---

### Task 1: Add ordered batch translation to the coordinator

**Files:**
- Modify: `packages/desktop/src/preload/native-translation-coordinator.ts:8-107`
- Modify: `packages/desktop/src/preload/native-translation-coordinator.test.ts:1-122`

**Interfaces:**
- Consumes: `NativeTranslationGatewayPort.detectLanguage(text)`、`NativeTranslationGatewayPort.translateBatch(input)`、`bilingualTranslationTarget(sourceLang)`。
- Produces: `NativeTranslationTextResult` 与 `NativeTranslationCoordinator.translateMany(texts)`，供 Task 2/3 使用；保留现有 `translate(text)` 和 `clear()`。

- [ ] **Step 1: Write failing tests for ordered grouping, chunking, partial failure and cache reuse**

在 `native-translation-coordinator.test.ts` 导入新类型，并增加以下测试。测试网关根据 `targetLang` 返回可预测译文，不包含真实消息正文：

```ts
it('按目标语言分组批量翻译并恢复输入顺序', async () => {
  const translateBatch = vi.fn(async (input: NativeTranslationBatchInput) => input.texts.map(text => (
    result(`${input.targetLang}:${text}`, input.sourceLang ?? 'und')
  )))
  const port = gateway({
    detectLanguage: vi.fn(async text => text.startsWith('中') ? 'zh-CN' : 'en'),
    translateBatch,
  })
  const coordinator = new NativeTranslationCoordinator(port)

  await expect(coordinator.translateMany(['中一', 'west', '中二'])).resolves.toEqual([
    { status: 'translated', translated: 'en:中一' },
    { status: 'translated', translated: 'zh:west' },
    { status: 'translated', translated: 'en:中二' },
  ])
  expect(translateBatch).toHaveBeenCalledTimes(2)
  expect(translateBatch).toHaveBeenCalledWith({
    texts: ['中一', '中二'],
    targetLang: 'en',
    sourceLang: 'zh-cn',
  })
  expect(translateBatch).toHaveBeenCalledWith({
    texts: ['west'],
    targetLang: 'zh',
    sourceLang: 'en',
  })
})

it('同一语言组超过二十条时拆批且保持顺序', async () => {
  const texts = Array.from({ length: 21 }, (_, index) => `text-${index}`)
  const translateBatch = vi.fn(async (input: NativeTranslationBatchInput) => (
    input.texts.map(text => result(`译:${text}`, 'en'))
  ))
  const port = gateway({ translateBatch })
  const coordinator = new NativeTranslationCoordinator(port)

  const translated = await coordinator.translateMany(texts)
  expect(translateBatch).toHaveBeenCalledTimes(2)
  expect(translateBatch.mock.calls.map(([input]) => input.texts.length)).toEqual([20, 1])
  expect(translated).toEqual(texts.map(text => ({
    status: 'translated',
    translated: `译:${text}`,
  })))
})

it('批量结果缺项或失败只影响对应文本且失败不会缓存', async () => {
  const translateBatch = vi.fn()
    .mockResolvedValueOnce([
      result('成功一', 'en'),
      result('', 'en', true),
    ])
    .mockResolvedValueOnce([result('恢复', 'en')])
  const port = gateway({ translateBatch })
  const coordinator = new NativeTranslationCoordinator(port)

  await expect(coordinator.translateMany(['one', 'two', 'three'])).resolves.toEqual([
    { status: 'translated', translated: '成功一' },
    { status: 'failed' },
    { status: 'failed' },
  ])
  await expect(coordinator.translateMany(['one', 'two'])).resolves.toEqual([
    { status: 'translated', translated: '成功一' },
    { status: 'translated', translated: '恢复' },
  ])
  expect(port.detectLanguage).toHaveBeenCalledTimes(4)
})

it('同批重复正文只检测并翻译一次', async () => {
  const port = gateway()
  const coordinator = new NativeTranslationCoordinator(port)

  await expect(coordinator.translateMany(['same', 'same'])).resolves.toEqual([
    { status: 'translated', translated: '译文' },
    { status: 'translated', translated: '译文' },
  ])
  expect(port.detectLanguage).toHaveBeenCalledTimes(1)
  expect(port.translateBatch).toHaveBeenCalledTimes(1)
})

it('成功缓存达到上限时淘汰最早正文', async () => {
  const port = gateway()
  const coordinator = new NativeTranslationCoordinator(port, { maxCacheEntries: 2 })

  await coordinator.translateMany(['first', 'second', 'third'])
  await coordinator.translate('first')
  expect(port.translateBatch).toHaveBeenCalledTimes(2)
})
```

把现有未知语言纠偏测试扩展为混合批量：只有预检测未知且 detected target 改变的项进入第二次请求；其他项只请求一次。

- [ ] **Step 2: Run the coordinator test and verify RED**

Run:

```bash
pnpm exec vitest run packages/desktop/src/preload/native-translation-coordinator.test.ts
```

Expected: FAIL，报错包含 `coordinator.translateMany is not a function` 或新导出类型不存在；现有 7 项测试仍能运行到新失败点。

- [ ] **Step 3: Implement the batch result contract and ordered batch engine**

在 `native-translation-coordinator.ts` 增加公开结果类型：

```ts
export type NativeTranslationTextResult =
  | { status: 'translated'; translated: string }
  | { status: 'failed' }

interface PendingText {
  text: string
  resolve(translated: string): void
  reject(error: Error): void
}

interface TranslationWorkItem {
  index: number
  text: string
  sourceLang: string | undefined
  targetLang: string
}

interface InternalTranslationResult {
  translated: string
  detectedLang: string | undefined
}

const MAX_BATCH_SIZE = 20
```

实现 `translateMany`，先为每个新的非空正文创建并注册 cache promise，再一次性处理所有 cache miss；重复正文直接复用刚注册的 promise。每个 promise 用 `then/catch` 转成逐项 discriminated union，失败时删除对应 cache：

```ts
async translateMany(texts: readonly string[]): Promise<NativeTranslationTextResult[]> {
  const pending: PendingText[] = []
  const operations = texts.map(text => {
    if (!text.trim()) return Promise.resolve<NativeTranslationTextResult>({ status: 'failed' })
    const cached = this.cache.get(text)
    if (cached) {
      return cached.then(
        translated => ({ status: 'translated', translated }) as const,
        () => ({ status: 'failed' }) as const,
      )
    }

    let resolveOperation: (translated: string) => void = () => undefined
    let rejectOperation: (error: Error) => void = () => undefined
    const base = new Promise<string>((resolve, reject) => {
      resolveOperation = resolve
      rejectOperation = reject
    })
    let operation: Promise<string>
    operation = base.catch((error: unknown) => {
      if (this.cache.get(text) === operation) this.cache.delete(text)
      throw error
    })
    this.remember(text, operation)
    pending.push({ text, resolve: resolveOperation, reject: rejectOperation })
    return operation.then(
      translated => ({ status: 'translated', translated }) as const,
      () => ({ status: 'failed' }) as const,
    )
  })

  if (pending.length > 0) await this.resolvePendingBatch(pending)
  return Promise.all(operations)
}
```

把当前 FIFO 淘汰逻辑移入 `remember(text, operation)`。实现 `resolvePendingBatch`、`requestGroups` 和长度 20 的 chunk 循环：检测异常视为未知语言；按规范化后的 `sourceLang + targetLang` 分组；`translateBatch` 返回 undefined、抛错、failed、空译文或数组缺项时只拒绝对应项。预检测未知且批量 detected language 改变目标时，把该项按规范 detected source 重组并只请求一次纠偏。最终按原始 index resolve/reject `PendingText`。

现有单条入口改为批量入口的严格包装：

```ts
async translate(text: string): Promise<string> {
  if (!text.trim()) throw new Error('translation text is blank')
  const result = (await this.translateMany([text]))[0]
  if (!result || result.status === 'failed') throw new Error('translation unavailable')
  return result.translated
}
```

保留 `clear()` 与可注入 `resolveTargetLanguage`；不得更改 `NativeTranslationGatewayPort`。

- [ ] **Step 4: Run the coordinator test and verify GREEN**

Run:

```bash
pnpm exec vitest run packages/desktop/src/preload/native-translation-coordinator.test.ts
```

Expected: PASS，包含原有 7 项和新增批量测试；没有 unhandled rejection。

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/desktop/src/preload/native-translation-coordinator.ts packages/desktop/src/preload/native-translation-coordinator.test.ts
git commit -m "feat: batch native translation coordination"
```

---

### Task 2: Add the platform-neutral bubble translation state machine

**Files:**
- Create: `packages/desktop/src/preload/native-bubble-translation-controller.ts`
- Create: `packages/desktop/src/preload/native-bubble-translation-controller.test.ts`

**Interfaces:**
- Consumes: Task 1 `NativeTranslationTextResult[]` through an injected `translate(texts)` port.
- Produces: `NativeBubbleTranslationController<TKey>`、`NativeBubbleTranslationObservation<TKey>`、`NativeBubbleTranslationStats`，供 Task 3 WhatsApp adapter 使用。

- [ ] **Step 1: Write failing fake-timer tests for batching and lifecycle**

新测试文件用 `vi.useFakeTimers()`，定义字符串 key 的观察和内存事件记录器：

```ts
function observation(
  key: string,
  text = key,
): NativeBubbleTranslationObservation<string> {
  return { key, text, revision: 1 }
}
```

至少覆盖以下断言：

```ts
it('立即进入 pending 并在五百毫秒后合并为一批', async () => {
  const translate = vi.fn(async (texts: readonly string[]) => texts.map(text => ({
    status: 'translated' as const,
    translated: `译:${text}`,
  })))
  const pending: string[] = []
  const success: string[] = []
  const current = new Set(['a', 'b'])
  const controller = new NativeBubbleTranslationController<string>({
    translate,
    isCurrent: item => current.has(item.key),
    onPending: item => pending.push(item.key),
    onSuccess: (item, translated) => success.push(`${item.key}:${translated}`),
    onFailure: () => undefined,
    onStale: () => undefined,
  })

  controller.observe(observation('a'))
  controller.observe(observation('b'))
  expect(pending).toEqual(['a', 'b'])
  await vi.advanceTimersByTimeAsync(499)
  expect(translate).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(translate).toHaveBeenCalledWith(['a', 'b'])
  expect(success).toEqual(['a:译:a', 'b:译:b'])
})

it('二十一条拆成二十加一且最多三个活动批次', async () => {
  const releases: Array<() => void> = []
  const translate = vi.fn((texts: readonly string[]) => new Promise<NativeTranslationTextResult[]>(resolve => {
    releases.push(() => resolve(texts.map(text => ({
      status: 'translated',
      translated: `译:${text}`,
    }))))
  }))
  const controller = createController(translate)
  for (let index = 0; index < 61; index += 1) {
    controller.observe(observation(`item-${index}`))
  }

  await vi.advanceTimersByTimeAsync(500)
  expect(translate).toHaveBeenCalledTimes(3)
  expect(controller.stats()).toEqual({ queued: 1, active: 3 })
  releases[0]?.()
  await vi.runAllTicks()
  expect(translate).toHaveBeenCalledTimes(4)
})
```

再增加离散测试：同 key/正文/revision 重复观察不重复 pending；同 key 正文变化使旧结果 stale；逐项 failed 结束 pending 并调用 failure；translate 抛错使本批全部 failure；`reset()` 后迟到结果不回填；失败后调用 `retry(item)` 只产生一个新请求；`stats()` 精确返回 queued/active。

- [ ] **Step 2: Run the controller test and verify RED**

Run:

```bash
pnpm exec vitest run packages/desktop/src/preload/native-bubble-translation-controller.test.ts
```

Expected: FAIL，报错说明 `native-bubble-translation-controller.js` 不存在。

- [ ] **Step 3: Implement the generic controller**

新文件导出以下精确接口：

```ts
import type { NativeTranslationTextResult } from './native-translation-coordinator.js'

export interface NativeBubbleTranslationObservation<TKey> {
  key: TKey
  text: string
  revision: string | number
}

export interface NativeBubbleTranslationPort<TKey> {
  translate(texts: readonly string[]): Promise<NativeTranslationTextResult[]>
  isCurrent(item: NativeBubbleTranslationObservation<TKey>): boolean
  onPending(item: NativeBubbleTranslationObservation<TKey>): void
  onSuccess(item: NativeBubbleTranslationObservation<TKey>, translated: string): void
  onFailure(item: NativeBubbleTranslationObservation<TKey>): void
  onStale(item: NativeBubbleTranslationObservation<TKey>): void
}

export interface NativeBubbleTranslationStats {
  queued: number
  active: number
}

export interface NativeBubbleTranslationControllerOptions {
  batchSize?: number
  debounceMs?: number
  maxConcurrency?: number
}
```

内部 entry 带单调 token、controller epoch 和 `queued | active` 状态。默认值固定为 20、500、3；三个选项都必须是正安全整数。`observe()` 对空白返回 false；同 key + text + revision 的当前 entry 返回 false；事实变化则替换 `byKey` 中的 token 并把新 entry 入队。`reset()` 清 timer、清队列、清 `byKey` 并推进 epoch。
公开 `retry(item)` 直接复用 `observe(item)` 的原子去重，因此连续重试调用不能为同一观察生成并发任务。

核心 drain 顺序固定为：

```ts
private drain(): void {
  while (this.active < this.maxConcurrency) {
    const batch = this.takeCurrentBatch()
    if (batch.length === 0) return
    this.active += 1
    for (const entry of batch) entry.state = 'active'
    void this.translateBatch(batch).finally(() => {
      this.active -= 1
      this.drain()
    })
  }
}
```

`translateBatch` 捕获 port 异常并生成等长 failed 结果；逐项应用前必须同时满足 entry epoch 未变、
`byKey` 仍指向同 token、`port.isCurrent(item)` 为 true。token 已被新观察替换或 epoch 变化时静默丢弃；
事实当前性失败时删除 entry、调用 `onStale`，不得调用 `onFailure`。成功与失败都先从 `byKey` 删除再发
对应 callback，使 callback 内立即重试不会被旧 entry 阻塞。

- [ ] **Step 4: Run Task 2 tests and the coordinator regression suite**

Run:

```bash
pnpm exec vitest run packages/desktop/src/preload/native-bubble-translation-controller.test.ts packages/desktop/src/preload/native-translation-coordinator.test.ts
```

Expected: PASS；fake timers 在 `afterEach` 恢复为真实 timer，测试结束没有 pending promise 警告。

- [ ] **Step 5: Commit Task 2**

```bash
git add packages/desktop/src/preload/native-bubble-translation-controller.ts packages/desktop/src/preload/native-bubble-translation-controller.test.ts
git commit -m "feat: add native bubble translation controller"
```

---

### Task 3: Build a testable WhatsApp DOM adapter

**Files:**
- Create: `packages/desktop/src/preload/whatsapp-web-translation.ts`
- Create: `packages/desktop/src/preload/whatsapp-web-translation.test.ts`
- Modify: `packages/desktop/src/preload/whatsapp-web-utils.ts`
- Modify: `packages/desktop/src/preload/whatsapp-web-utils.test.ts`

**Interfaces:**
- Consumes: Task 1 `NativeTranslationCoordinator.translateMany/clear` 与 Task 2 controller。
- Produces: `WhatsAppWebTranslationAdapter<Row, Marker>` 和结构化 `WhatsAppTranslationDomPort<Row, Marker>`；Task 4 用真实 `HTMLElement`/marker 实现该 port。

- [ ] **Step 1: Write failing adapter tests with a structural fake DOM**

定义不依赖 jsdom 的 fake row/marker：

```ts
interface FakeMarker {
  textContent: string | null
  attributes: Set<string>
  onclick: (() => void) | null
  removed: boolean
}

interface FakeRow {
  text: string
  connected: boolean
  marker: FakeMarker | null
}
```

创建 `WhatsAppTranslationDomPort<FakeRow, FakeMarker>`，`marker(row, true)` 只创建一个 marker，
`removeAllMarkers()` 把所有 fake marker 标记 removed 并置空。使用 fake timers 覆盖：

- 新行立即得到单个“翻译中…” marker，500ms 后变成译文；
- 同一行重复观察不新增 marker、不重复请求；
- 模拟滚动新增第二行时只翻译第二行；
- 请求期间改变 `row.text` 或 `row.connected=false`，旧译文不写入并触发 `scheduleScan`；
- failed 显示“翻译暂不可用 · 点击重试”并设置 error attribute；连续点击只产生一个 pending 请求；
- `reset()` 移除 marker、清 coordinator cache、清队列；reset 前的迟到结果不写入；
- `stats()` 透传 controller queued/active。

在 `whatsapp-web-utils.test.ts` 增加：

```ts
it('只有真实会话边界才重置 WhatsApp 译文', () => {
  const current = {
    platformConversationId: 'wa:first@c.us',
    contactExternalId: 'first@c.us',
    contactDisplayName: 'First',
  }
  expect(shouldResetWhatsAppTranslations(current, {
    ...current,
    contactDisplayName: 'First · online',
  })).toBe(false)
  expect(shouldResetWhatsAppTranslations(current, {
    ...current,
    platformConversationId: 'wa:second@c.us',
  })).toBe(true)
  expect(shouldResetWhatsAppTranslations(current, null)).toBe(true)
  expect(shouldResetWhatsAppTranslations(null, current)).toBe(true)
})
```

- [ ] **Step 2: Run the adapter tests and verify RED**

Run:

```bash
pnpm exec vitest run packages/desktop/src/preload/whatsapp-web-translation.test.ts packages/desktop/src/preload/whatsapp-web-utils.test.ts
```

Expected: FAIL，分别说明 adapter 模块与 `shouldResetWhatsAppTranslations` 尚不存在。

- [ ] **Step 3: Implement the adapter contracts and marker lifecycle**

新文件导出结构接口，不引用测试 fake 类型：

```ts
export interface WhatsAppTranslationDomPort<Row extends object, Marker> {
  text(row: Row): string | null
  isConnected(row: Row): boolean
  marker(row: Row, create: boolean): Marker | null
  setText(marker: Marker, text: string): void
  setError(marker: Marker, failed: boolean): void
  setRetryHandler(marker: Marker, handler: (() => void) | null): void
  removeMarker(marker: Marker): void
  removeAllMarkers(): void
  scheduleScan(): void
}

export interface WhatsAppTranslationCoordinatorPort {
  translateMany(texts: readonly string[]): Promise<NativeTranslationTextResult[]>
  clear(): void
}
```

`WhatsAppWebTranslationAdapter<Row, Marker>` 内部持有 `WeakMap<Row, string>` 和 Task 2 controller。
`observe(row, text)` 在已有 marker 且已应用正文相同时返回 false；否则把 row/text/当前 adapter generation
交给 controller。回调行为必须精确为：

```ts
onPending: item => {
  const marker = this.dom.marker(item.key, true)
  if (marker) this.dom.setText(marker, '翻译中…')
},
onSuccess: (item, translated) => {
  const marker = this.dom.marker(item.key, true)
  if (!marker) return
  this.dom.setText(marker, translated)
  this.dom.setError(marker, false)
  this.dom.setRetryHandler(marker, null)
  this.translatedRows.set(item.key, item.text)
},
onFailure: item => {
  const marker = this.dom.marker(item.key, true)
  if (!marker) return
  this.dom.setText(marker, '翻译暂不可用 · 点击重试')
  this.dom.setError(marker, true)
  this.translatedRows.set(item.key, item.text)
  this.dom.setRetryHandler(marker, () => this.retry(item.key))
},
onStale: () => this.dom.scheduleScan(),
```

`isCurrent` 必须检查 generation、`dom.isConnected(row)` 和 `dom.text(row) === item.text`。
`retry(row)` 删除 applied 快照、通过 `dom.removeMarker` 移除旧 marker，重新读取当前正文；正文存在时只调用一次 `observe`，
不存在时只调 `scheduleScan`。`reset()` 先推进 generation，再 reset controller、clear coordinator、
removeAllMarkers 并重建 WeakMap。

在 `whatsapp-web-utils.ts` 导出：

```ts
export function shouldResetWhatsAppTranslations(
  current: NativeConversationContext | null,
  next: NativeConversationContext | null,
): boolean {
  if (!current && !next) return false
  return !sameWhatsAppConversation(current, next)
}
```

- [ ] **Step 4: Run Task 3 and lower-level regressions**

Run:

```bash
pnpm exec vitest run packages/desktop/src/preload/whatsapp-web-translation.test.ts packages/desktop/src/preload/whatsapp-web-utils.test.ts packages/desktop/src/preload/native-bubble-translation-controller.test.ts packages/desktop/src/preload/native-translation-coordinator.test.ts
```

Expected: PASS；没有 DOM 全局变量需求，也没有新增依赖。

- [ ] **Step 5: Commit Task 3**

```bash
git add packages/desktop/src/preload/whatsapp-web-translation.ts packages/desktop/src/preload/whatsapp-web-translation.test.ts packages/desktop/src/preload/whatsapp-web-utils.ts packages/desktop/src/preload/whatsapp-web-utils.test.ts
git commit -m "feat: adapt WhatsApp bubbles to shared translation"
```

---

### Task 4: Replace the private WhatsApp queue with the adapter

**Files:**
- Modify: `packages/desktop/src/preload/whatsapp-web-bridge.ts:26-121`
- Modify: `packages/desktop/src/preload/whatsapp-web-bridge.ts:155-385`
- Test: `packages/desktop/src/preload/whatsapp-web-translation.test.ts`
- Test: `packages/desktop/src/preload/whatsapp-web-health.test.ts`
- Test: `packages/desktop/src/preload/whatsapp-web-utils.test.ts`

**Interfaces:**
- Consumes: Task 3 `WhatsAppWebTranslationAdapter`、`WhatsAppTranslationDomPort`、`shouldResetWhatsAppTranslations`。
- Produces: WhatsApp production bridge 使用共用批量状态机；不改变 `startWhatsAppWebBridge(api)` 或 IPC/native bridge 协议。

- [ ] **Step 1: Add a failing integration assertion for reset semantics**

先在 adapter 测试加入“已成功 marker → 同会话显示名变化不调用 reset → 真正会话切换调用 reset 后 marker 清空”的组合测试。使用 `shouldResetWhatsAppTranslations` 驱动与生产 `updateContext` 相同的判断。该测试在 bridge 改线前应能证明期望，但 bridge 源码仍含 `translationQueue`；随后用静态断言锁住私有队列移除：

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

it('生产 bridge 不再维护私有翻译队列', () => {
  const bridgePath = fileURLToPath(new URL('./whatsapp-web-bridge.ts', import.meta.url))
  const source = readFileSync(bridgePath, 'utf8')
  expect(source).not.toContain('translationQueue')
  expect(source).not.toContain('queuedRows')
  expect(source).not.toContain('drainTranslationQueue')
  expect(source).toContain('WhatsAppWebTranslationAdapter')
})
```

- [ ] **Step 2: Run the integration assertion and verify RED**

Run:

```bash
pnpm exec vitest run packages/desktop/src/preload/whatsapp-web-translation.test.ts
```

Expected: FAIL，指出生产 bridge 仍包含 `translationQueue`、`queuedRows` 或没有使用 adapter。

- [ ] **Step 3: Wire the real HTMLElement port and remove the private queue**

在 bridge 顶部导入 adapter 和 reset helper。删除 `QueuedTranslation` 类型、
`MAX_TRANSLATION_CONCURRENCY`、`translatedRows`、`queuedRows`、`translationQueue`、
`activeTranslations`、`translationGeneration`、`drainTranslationQueue()` 和 `translateRow()`。

构造函数中保留现有 coordinator，并创建 adapter：

```ts
private readonly pageTranslations: WhatsAppWebTranslationAdapter<HTMLElement, HTMLElement>

this.translationCoordinator = new NativeTranslationCoordinator(api)
this.pageTranslations = new WhatsAppWebTranslationAdapter<HTMLElement, HTMLElement>(
  this.translationCoordinator,
  {
    text: row => messageText(row),
    isConnected: row => row.isConnected,
    marker: (row, create) => translationMarker(row, create),
    setText: (marker, text) => { marker.textContent = text },
    setError: (marker, failed) => {
      if (failed) marker.setAttribute('data-imhub-translation-error', 'true')
      else marker.removeAttribute('data-imhub-translation-error')
    },
    setRetryHandler: (marker, handler) => { marker.onclick = handler },
    removeMarker: marker => marker.remove(),
    removeAllMarkers: () => {
      for (const marker of document.querySelectorAll(`[${TRANSLATION_ATTRIBUTE}]`)) marker.remove()
    },
    scheduleScan: () => this.scheduleScan(),
  },
)
```

`scanMessages()` 保留身份、proxy、main、selector health 和 300 行上限，只把合格正文交给 adapter：

```ts
for (const row of rows) {
  const text = messageText(row)
  if (!text || text.length > 4_000) continue
  this.pageTranslations.observe(row, text)
}
this.scheduleTranslationVisibilityCheck()
```

`resetPageTranslations()` 只调用 `this.pageTranslations.reset()`。可见性诊断中的 `queued/active` 改读：

```ts
const translationStats = this.pageTranslations.stats()
const stats = {
  rows: rows.length,
  readable: readable.length,
  markers: markers.length,
  connected: connected.length,
  visible: visible.length,
  loading,
  failed,
  translated: Math.max(0, connected.length - loading - failed),
  queued: translationStats.queued,
  active: translationStats.active,
}
```

`updateContext` 在 exact same context 和同 platform conversation 元数据分支后，使用
`shouldResetWhatsAppTranslations(previous, value)`；只有 true 时 reset。保留既有 `contextRevision`
递增和 composer stale-context 语义。账号 identity 真正变化仍显式 reset；删除 sign-out 路径中与
`updateContext(null)` 重复的第二次 reset。

- [ ] **Step 4: Run all affected preload tests**

Run:

```bash
pnpm exec vitest run packages/desktop/src/preload/native-translation-coordinator.test.ts packages/desktop/src/preload/native-bubble-translation-controller.test.ts packages/desktop/src/preload/whatsapp-web-translation.test.ts packages/desktop/src/preload/whatsapp-web-utils.test.ts packages/desktop/src/preload/whatsapp-web-health.test.ts packages/desktop/src/preload/whatsapp-web-composer.test.ts packages/desktop/src/preload/whatsapp-web-send.test.ts
```

Expected: PASS；composer/send 回归测试保持原数量与语义，没有真实发送。

- [ ] **Step 5: Run typecheck before committing the bridge integration**

Run:

```bash
pnpm typecheck
```

Expected: exit 0；无 `any`、无 DOM port 结构不兼容、无 ESM 导入错误。

- [ ] **Step 6: Commit Task 4**

```bash
git add packages/desktop/src/preload/whatsapp-web-bridge.ts packages/desktop/src/preload/whatsapp-web-translation.test.ts
git commit -m "refactor: share WhatsApp bubble translation flow"
```

---

### Task 5: Full verification, integrated package and checkpoint

**Files:**
- Modify: `docs/superpowers/specs/2026-08-29-signal-whatsapp-parallel-checkpoint.md`
- Verify only: all code and tests changed in Tasks 1-4

**Interfaces:**
- Consumes: completed Tasks 1-4 and existing package preparation script.
- Produces: verified branch state, `/private/tmp/Signal-imhub-integrated-a50.app`, and an evidence-backed checkpoint without changing PR #19 or Issue #12.

- [ ] **Step 1: Run the complete test suite**

Run:

```bash
pnpm test
```

Expected: all unit/integration tests pass, with the existing todo preserved. If the sandbox alone blocks PostgreSQL with `EPERM`, rerun the identical command outside the sandbox after confirming the already-configured test URL derives an `_test` database; do not load or print `.env`.

- [ ] **Step 2: Run final typecheck and production desktop build**

Run:

```bash
pnpm typecheck
pnpm --filter @im-hub/desktop build
```

Expected: both commands exit 0. Build output includes main, preload and renderer bundles without unresolved imports.

- [ ] **Step 3: Review the complete branch diff for scope and secrets**

Run:

```bash
git status --short
git diff 6d92d46..HEAD --stat
git diff 6d92d46..HEAD -- packages/desktop/src/preload docs/superpowers/specs
```

Expected: only the planned coordinator/controller/adapter/bridge/tests/docs are present; no `.env`、profile/session、build product or unrelated source change。

- [ ] **Step 4: Generate the next integrated test package without inspecting opaque configuration**

确认 output 不存在后运行：

```bash
pnpm --filter @im-hub/desktop prepare:signal -- \
  --source /Applications/Signal.app \
  --output /private/tmp/Signal-imhub-integrated-a50.app \
  --profile-source /private/tmp/Signal-imhub-integrated-a49.app
/usr/bin/codesign --verify --deep --strict /private/tmp/Signal-imhub-integrated-a50.app
```

Expected: package script reports Signal Desktop 8.25.0 and codesign exits 0. `--profile-source` is opaque byte copying；不得打开或打印其中配置。

- [ ] **Step 5: Perform only the affected real acceptance matrix**

让用户先关闭当前隔离测试客户端，但保持服务端与 Telegram 运行；随后启动 a50：

```bash
open -na /private/tmp/Signal-imhub-integrated-a50.app
```

只复用现有 WhatsApp 会话和历史消息，由用户反馈：

```text
当前可见入站译文：有/无
当前可见出站译文：有/无
向上滚动后新增入站译文：有/无
向上滚动后新增出站译文：有/无
错误诊断：无/仅稳定错误文案
```

Expected: 四项均为“有”，错误诊断为“无”。不得点击 TranslationDock 发送，不回传正文、账号标识或 DOM id。

- [ ] **Step 6: Append an exact checkpoint and commit it**

在 checkpoint 末尾新增 `## 26. 原生气泡翻译批处理收敛 checkpoint（2026-09-01）`，只记录：

- 三层边界：coordinator 批量、通用 controller 状态机、WhatsApp DOM adapter；
- 未修改 Telegram/Signal/composer/send/消息 ID；
- 定向测试、全量测试、typecheck、desktop build 的实际通过数量和命令结果；
- a50 从 a49 不透明配置生成、deep/strict codesign 结果和只读真实验收结果；
- 真实发送数仍为 0，PR #19 未合并，Issue #12 未关闭。

然后运行并提交：

```bash
git diff --check
git add docs/superpowers/specs/2026-08-29-signal-whatsapp-parallel-checkpoint.md
git commit -m "docs: checkpoint bubble translation convergence"
git status --short --branch
```

Expected: `git diff --check` 无输出；最终 worktree clean；分支仍为 `codex/m5-m6-signal-whatsapp`。
