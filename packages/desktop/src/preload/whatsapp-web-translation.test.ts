import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeTranslationTextResult } from './native-translation-coordinator.js'
import {
  WhatsAppWebTranslationAdapter,
  type WhatsAppTranslationDomPort,
} from './whatsapp-web-translation.js'

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

class FakeDom implements WhatsAppTranslationDomPort<FakeRow, FakeMarker> {
  readonly rows: FakeRow[]
  scheduleScans = 0

  constructor(rows: FakeRow[]) {
    this.rows = rows
  }

  text(row: FakeRow): string | null {
    return row.text
  }

  isConnected(row: FakeRow): boolean {
    return row.connected
  }

  marker(row: FakeRow, create: boolean): FakeMarker | null {
    if (!row.marker && create) {
      row.marker = {
        textContent: null,
        attributes: new Set(),
        onclick: null,
        removed: false,
      }
    }
    return row.marker
  }

  setText(marker: FakeMarker, text: string): void {
    marker.textContent = text
  }

  setError(marker: FakeMarker, failed: boolean): void {
    if (failed) marker.attributes.add('data-im-hub-translation-error')
    else marker.attributes.delete('data-im-hub-translation-error')
  }

  setRetryHandler(marker: FakeMarker, handler: (() => void) | null): void {
    marker.onclick = handler
  }

  removeMarker(marker: FakeMarker): void {
    marker.removed = true
    for (const row of this.rows) {
      if (row.marker === marker) row.marker = null
    }
  }

  removeAllMarkers(): void {
    for (const row of this.rows) {
      if (row.marker) row.marker.removed = true
      row.marker = null
    }
  }

  scheduleScan(): void {
    this.scheduleScans += 1
  }
}

class FakeCoordinator {
  readonly calls: string[][] = []
  clears = 0
  private readonly requests: Array<{
    texts: readonly string[]
    resolve(results: NativeTranslationTextResult[]): void
  }> = []

  translateMany(texts: readonly string[]): Promise<NativeTranslationTextResult[]> {
    this.calls.push([...texts])
    return new Promise(resolve => {
      this.requests.push({ texts, resolve })
    })
  }

  clear(): void {
    this.clears += 1
  }

  resolveNext(results: NativeTranslationTextResult[]): void {
    const request = this.requests.shift()
    if (!request) throw new Error('no translation request to resolve')
    request.resolve(results)
  }
}

function row(text: string): FakeRow {
  return { text, connected: true, marker: null }
}

function translated(text: string): NativeTranslationTextResult {
  return { status: 'translated', translated: text }
}

function createAdapter(rows: FakeRow[]) {
  const dom = new FakeDom(rows)
  const coordinator = new FakeCoordinator()
  const adapter = new WhatsAppWebTranslationAdapter(dom, coordinator)
  return { adapter, coordinator, dom }
}

describe('WhatsAppWebTranslationAdapter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('新行立即显示 pending，并在五百毫秒后显示译文', async () => {
    const first = row('hello')
    const { adapter, coordinator } = createAdapter([first])

    expect(adapter.observe(first, first.text)).toBe(true)
    expect(first.marker?.textContent).toBe('翻译中…')
    await vi.advanceTimersByTimeAsync(500)
    coordinator.resolveNext([translated('你好')])
    await vi.runAllTicks()

    expect(first.marker?.textContent).toBe('你好')
    expect(first.marker?.attributes.has('data-im-hub-translation-error')).toBe(false)
  })

  it('同一行重复观察不会新增 marker 或重复请求', async () => {
    const first = row('hello')
    const { adapter, coordinator } = createAdapter([first])

    adapter.observe(first, first.text)
    const marker = first.marker
    expect(adapter.observe(first, first.text)).toBe(false)
    expect(first.marker).toBe(marker)
    await vi.advanceTimersByTimeAsync(500)
    expect(coordinator.calls).toEqual([['hello']])
  })

  it('滚动加入第二行时只翻译新行', async () => {
    const first = row('first')
    const second = row('second')
    const { adapter, coordinator } = createAdapter([first, second])

    adapter.observe(first, first.text)
    await vi.advanceTimersByTimeAsync(500)
    coordinator.resolveNext([translated('第一条')])
    await vi.runAllTicks()
    adapter.observe(first, first.text)
    adapter.observe(second, second.text)
    await vi.advanceTimersByTimeAsync(500)

    expect(coordinator.calls).toEqual([['first'], ['second']])
  })

  it('虚拟化行回到旧正文时重新请求，并忽略中间正文的迟到结果', async () => {
    const first = row('A')
    const { adapter, coordinator } = createAdapter([first])

    adapter.observe(first, first.text)
    await vi.advanceTimersByTimeAsync(500)
    coordinator.resolveNext([translated('A 的译文')])
    await vi.runAllTicks()
    expect(first.marker?.textContent).toBe('A 的译文')

    first.text = 'B'
    expect(adapter.observe(first, first.text)).toBe(true)
    await vi.advanceTimersByTimeAsync(500)

    first.text = 'A'
    expect(adapter.observe(first, first.text)).toBe(true)
    coordinator.resolveNext([translated('B 的迟到译文')])
    await vi.runAllTicks()
    expect(first.marker?.textContent).toBe('翻译中…')

    await vi.advanceTimersByTimeAsync(500)
    coordinator.resolveNext([translated('A 的新译文')])
    await vi.runAllTicks()
    expect(first.marker?.textContent).toBe('A 的新译文')
  })

  it.each([
    ['正文变化', (first: FakeRow) => { first.text = 'changed' }],
    ['行已断开', (first: FakeRow) => { first.connected = false }],
  ])('请求期间%s时不写回旧译文并重新扫描', async (_name, invalidate) => {
    const first = row('hello')
    const { adapter, coordinator, dom } = createAdapter([first])

    adapter.observe(first, first.text)
    await vi.advanceTimersByTimeAsync(500)
    invalidate(first)
    coordinator.resolveNext([translated('你好')])
    await vi.runAllTicks()

    expect(first.marker?.textContent).toBe('翻译中…')
    expect(dom.scheduleScans).toBe(1)
  })

  it('失败 marker 可重试，连续点击只创建一个 pending 请求', async () => {
    const first = row('hello')
    const { adapter, coordinator } = createAdapter([first])

    adapter.observe(first, first.text)
    await vi.advanceTimersByTimeAsync(500)
    coordinator.resolveNext([{ status: 'failed' }])
    await vi.runAllTicks()
    expect(first.marker?.textContent).toBe('翻译暂不可用 · 点击重试')
    expect(first.marker?.attributes.has('data-im-hub-translation-error')).toBe(true)
    const retry = first.marker?.onclick
    retry?.()
    first.marker?.onclick?.()
    await vi.advanceTimersByTimeAsync(500)

    expect(first.marker?.textContent).toBe('翻译中…')
    expect(first.marker?.attributes.has('data-im-hub-translation-error')).toBe(false)
    expect(coordinator.calls).toEqual([['hello'], ['hello']])
  })

  it('reset 清理 marker、cache、队列，并拒绝迟到结果', async () => {
    const first = row('hello')
    const second = row('later')
    const { adapter, coordinator } = createAdapter([first, second])

    adapter.observe(first, first.text)
    await vi.advanceTimersByTimeAsync(500)
    adapter.observe(second, second.text)
    const oldMarker = first.marker
    const queuedMarker = second.marker
    adapter.reset()
    coordinator.resolveNext([translated('你好')])
    await vi.runAllTicks()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(500)

    expect(oldMarker?.removed).toBe(true)
    expect(queuedMarker?.removed).toBe(true)
    expect(first.marker).toBeNull()
    expect(second.marker).toBeNull()
    expect(coordinator.clears).toBe(1)
    expect(coordinator.calls).toEqual([['hello']])
    expect(adapter.stats()).toEqual({ queued: 0, active: 0 })
  })

  it('stats 透传 controller 的 queued 与 active', async () => {
    const first = row('hello')
    const { adapter } = createAdapter([first])

    adapter.observe(first, first.text)
    expect(adapter.stats()).toEqual({ queued: 1, active: 0 })
    await vi.advanceTimersByTimeAsync(500)
    expect(adapter.stats()).toEqual({ queued: 0, active: 1 })
  })
})
