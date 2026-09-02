import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeTranslationTextResult } from './native-translation-coordinator.js'
import {
  NativeBubbleTranslationController,
  type NativeBubbleTranslationObservation,
} from './native-bubble-translation-controller.js'

function observation(
  key: string,
  text = key,
  revision: string | number = 1,
): NativeBubbleTranslationObservation<string> {
  return { key, text, revision }
}

function createController(
  translate: (texts: readonly string[]) => Promise<NativeTranslationTextResult[]>,
  overrides: Partial<ConstructorParameters<typeof NativeBubbleTranslationController<string>>[0]> = {},
) {
  return new NativeBubbleTranslationController<string>({
    translate,
    isCurrent: () => true,
    onPending: () => undefined,
    onSuccess: () => undefined,
    onFailure: () => undefined,
    onStale: () => undefined,
    ...overrides,
  })
}

describe('NativeBubbleTranslationController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

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

  it('六十一条拆成二十加一且最多三个活动批次', async () => {
    const releases: Array<() => void> = []
    const translate = vi.fn((texts: readonly string[]) => new Promise<NativeTranslationTextResult[]>(resolve => {
      releases.push(() => resolve(texts.map(text => ({
        status: 'translated' as const,
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
    await vi.advanceTimersByTimeAsync(0)
    expect(translate).toHaveBeenCalledTimes(4)
    for (const release of releases) release()
    await vi.runAllTicks()
    await vi.advanceTimersByTimeAsync(0)
  })

  it('活动批次结束不会跳过新观察的五百毫秒聚合窗口', async () => {
    const releases: Array<() => void> = []
    const translate = vi.fn((texts: readonly string[]) => new Promise<NativeTranslationTextResult[]>(resolve => {
      releases.push(() => resolve(texts.map(text => ({
        status: 'translated' as const,
        translated: `译:${text}`,
      }))))
    }))
    const controller = createController(translate)

    controller.observe(observation('a'))
    await vi.advanceTimersByTimeAsync(500)
    controller.observe(observation('b'))
    await vi.advanceTimersByTimeAsync(499)
    releases[0]?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(translate).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(translate).toHaveBeenCalledTimes(2)
    releases[1]?.()
    await vi.advanceTimersByTimeAsync(0)
  })

  it('重复观察同一事实不重复进入 pending 或请求', async () => {
    const translate = vi.fn(async (texts: readonly string[]) => texts.map(text => ({
      status: 'translated' as const,
      translated: `译:${text}`,
    })))
    const pending: string[] = []
    const controller = createController(translate, { onPending: item => pending.push(item.key) })

    expect(controller.observe(observation('a'))).toBe(true)
    expect(controller.observe(observation('a'))).toBe(false)
    expect(pending).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(500)
    expect(translate).toHaveBeenCalledWith(['a'])
  })

  it('正文变化后丢弃旧结果，只回填新事实', async () => {
    const releases: Array<() => void> = []
    const translate = vi.fn((texts: readonly string[]) => new Promise<NativeTranslationTextResult[]>(resolve => {
      releases.push(() => resolve(texts.map(text => ({
        status: 'translated' as const,
        translated: `译:${text}`,
      }))))
    }))
    const success: string[] = []
    const controller = createController(translate, {
      onSuccess: (item, translated) => success.push(`${item.text}:${translated}`),
    })

    controller.observe(observation('a', '旧正文'))
    await vi.advanceTimersByTimeAsync(500)
    controller.observe(observation('a', '新正文', 2))
    releases[0]?.()
    await vi.runAllTicks()
    expect(success).toEqual([])
    await vi.advanceTimersByTimeAsync(500)
    releases[1]?.()
    await vi.runAllTicks()
    expect(success).toEqual(['新正文:译:新正文'])
  })

  it('逐项失败会结束 pending 并只调用该项 failure', async () => {
    const failures: string[] = []
    const successes: string[] = []
    const controller = createController(async () => [
      { status: 'translated', translated: '译:a' },
      { status: 'failed' },
    ], {
      onSuccess: item => successes.push(item.key),
      onFailure: item => failures.push(item.key),
    })

    controller.observe(observation('a'))
    controller.observe(observation('b'))
    await vi.advanceTimersByTimeAsync(500)
    expect(successes).toEqual(['a'])
    expect(failures).toEqual(['b'])
    expect(controller.stats()).toEqual({ queued: 0, active: 0 })
  })

  it('translate 抛错会使该批所有项目失败', async () => {
    const failures: string[] = []
    const controller = createController(async () => {
      throw new Error('unavailable')
    }, { onFailure: item => failures.push(item.key) })

    controller.observe(observation('a'))
    controller.observe(observation('b'))
    await vi.advanceTimersByTimeAsync(500)
    expect(failures).toEqual(['a', 'b'])
  })

  it('当前性失效时调用 stale 而非 failure', async () => {
    const current = new Set(['a'])
    const stale: string[] = []
    const failures: string[] = []
    const controller = createController(async () => [{ status: 'translated', translated: '译:a' }], {
      isCurrent: item => current.has(item.key),
      onStale: item => stale.push(item.key),
      onFailure: item => failures.push(item.key),
    })

    controller.observe(observation('a'))
    current.delete('a')
    await vi.advanceTimersByTimeAsync(500)
    expect(stale).toEqual(['a'])
    expect(failures).toEqual([])
  })

  it('reset 后迟到结果不会回填', async () => {
    let release: (() => void) | undefined
    const success: string[] = []
    const controller = createController(() => new Promise<NativeTranslationTextResult[]>(resolve => {
      release = () => resolve([{ status: 'translated', translated: '译:a' }])
    }), { onSuccess: item => success.push(item.key) })

    controller.observe(observation('a'))
    await vi.advanceTimersByTimeAsync(500)
    controller.reset()
    release?.()
    await vi.runAllTicks()
    await vi.advanceTimersByTimeAsync(0)
    expect(success).toEqual([])
    expect(controller.stats()).toEqual({ queued: 0, active: 0 })
  })

  it('失败后 retry 同一观察只产生一个新请求', async () => {
    const translate = vi.fn()
      .mockResolvedValueOnce([{ status: 'failed' } satisfies NativeTranslationTextResult])
      .mockResolvedValueOnce([{ status: 'translated', translated: '译:a' } satisfies NativeTranslationTextResult])
    const controller = createController(translate)
    const item = observation('a')

    controller.observe(item)
    await vi.advanceTimersByTimeAsync(500)
    expect(translate).toHaveBeenCalledTimes(1)
    expect(controller.retry(item)).toBe(true)
    expect(controller.retry(item)).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(translate).toHaveBeenCalledTimes(2)
  })

  it('空白观察和非法调度选项被拒绝', () => {
    const translate = async (): Promise<NativeTranslationTextResult[]> => []
    const controller = createController(translate)
    expect(controller.observe(observation('blank', '  '))).toBe(false)
    const port = {
      translate,
      isCurrent: () => true,
      onPending: () => undefined,
      onSuccess: () => undefined,
      onFailure: () => undefined,
      onStale: () => undefined,
    }
    expect(() => new NativeBubbleTranslationController(port, { batchSize: 0 }))
      .toThrow('batchSize must be a positive safe integer')
    expect(() => new NativeBubbleTranslationController(port, { debounceMs: Number.NaN }))
      .toThrow('debounceMs must be a positive safe integer')
    expect(() => new NativeBubbleTranslationController(port, { maxConcurrency: 1.5 }))
      .toThrow('maxConcurrency must be a positive safe integer')
  })
})
