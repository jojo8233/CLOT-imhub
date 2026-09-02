import { afterEach, describe, expect, it, vi } from 'vitest'
import { BootstrapRetryController } from './bootstrap-retry.js'

describe('BootstrapRetryController', () => {
  afterEach(() => { vi.useRealTimers() })

  it('单飞执行有界指数退避，成功 reset 后回到初始延迟', () => {
    vi.useFakeTimers()
    const retry = new BootstrapRetryController()
    const operation = vi.fn()

    retry.schedule(operation)
    retry.schedule(operation)
    vi.advanceTimersByTime(999)
    expect(operation).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(operation).toHaveBeenCalledTimes(1)

    retry.schedule(operation)
    vi.advanceTimersByTime(1_999)
    expect(operation).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(operation).toHaveBeenCalledTimes(2)

    retry.schedule(operation)
    vi.advanceTimersByTime(4_000)
    retry.schedule(operation)
    vi.advanceTimersByTime(8_000)
    retry.schedule(operation)
    vi.advanceTimersByTime(7_999)
    expect(operation).toHaveBeenCalledTimes(4)
    vi.advanceTimersByTime(1)
    expect(operation).toHaveBeenCalledTimes(5)

    retry.reset()
    retry.schedule(operation)
    vi.advanceTimersByTime(1_000)
    expect(operation).toHaveBeenCalledTimes(6)
  })

  it('取消后旧登录态的迟到重试不会执行', () => {
    vi.useFakeTimers()
    const retry = new BootstrapRetryController()
    const operation = vi.fn()
    retry.schedule(operation)
    retry.cancel()
    vi.runAllTimers()
    expect(operation).not.toHaveBeenCalled()
  })
})
