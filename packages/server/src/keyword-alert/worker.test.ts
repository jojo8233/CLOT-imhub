import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WsKeywordAlertEvent } from '@im-hub/shared'
import type {
  ActiveKeywordRule,
  KeywordAlertDelivery,
  KeywordAlertScanJob,
} from './scan-repo.js'
import {
  KeywordAlertWorker,
  keywordAlertRetryDelayMs,
  type KeywordAlertWorkerRepo,
} from './worker.js'

const now = new Date('2026-09-03T10:00:00.000Z')

function job(
  id: string,
  bodySnapshot: string,
  createdAt = now,
): KeywordAlertScanJob {
  return {
    id,
    messageId: `message-${id}`,
    messageRevision: 'initial',
    bodySnapshot,
    createdAt,
    attemptCount: 0,
  }
}

function rule(
  id: string,
  pattern: string,
  effectiveAt = new Date('2026-09-03T09:00:00.000Z'),
): ActiveKeywordRule {
  return {
    id,
    pattern,
    normalizedPattern: pattern.toLowerCase(),
    severity: 'urgent',
    revision: 1,
    effectiveAt,
  }
}

function event(
  alertId: string,
  requiresAcknowledgement: boolean,
): WsKeywordAlertEvent {
  return {
    type: 'keyword_alert',
    alertId,
    severity: 'urgent',
    requiresAcknowledgement,
    createdAt: now.toISOString(),
  }
}

class FakeScanRepo implements KeywordAlertWorkerRepo {
  completed: Array<{ jobId: string; ruleIds: string[] }> = []
  failures: Array<{ jobId: string; errorCode: 'scan_failed' }> = []
  committedJobIds = new Set<string>()
  ruleLoadCount = 0
  completeError: Error | null = null
  deliveries = new Map<string, KeywordAlertDelivery[]>()

  constructor(
    readonly jobs: KeywordAlertScanJob[],
    readonly rules: ActiveKeywordRule[],
  ) {}

  async claimBatch(_workerId: string, _now: Date): Promise<KeywordAlertScanJob[]> {
    return this.jobs
  }

  async loadActiveRules(): Promise<ActiveKeywordRule[]> {
    this.ruleLoadCount += 1
    return this.rules
  }

  async complete(
    _workerId: string,
    claimedJob: KeywordAlertScanJob,
    matchedRules: readonly ActiveKeywordRule[],
  ): Promise<KeywordAlertDelivery[]> {
    this.completed.push({
      jobId: claimedJob.id,
      ruleIds: matchedRules.map(matchedRule => matchedRule.id),
    })
    this.committedJobIds.add(claimedJob.id)
    if (this.completeError) throw this.completeError
    return this.deliveries.get(claimedJob.id) ?? []
  }

  async fail(
    _workerId: string,
    claimedJob: KeywordAlertScanJob,
    _now: Date,
    errorCode: 'scan_failed',
  ): Promise<void> {
    this.failures.push({ jobId: claimedJob.id, errorCode })
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('KeywordAlertWorker.drainOnce', () => {
  it('每批只加载一次规则，并把每个任务的命中规则交给原子完成操作', async () => {
    const repo = new FakeScanRepo(
      [job('j1', 'customer requested REFUND'), job('j2', 'ordinary question')],
      [rule('r1', 'refund')],
    )
    repo.deliveries.set('j1', [
      { userId: 'owner-1', event: event('alert-1', true) },
      { userId: 'auditor-1', event: event('alert-1', false) },
    ])
    const published: Array<[string, WsKeywordAlertEvent]> = []
    const worker = new KeywordAlertWorker({
      repo,
      workerId: 'worker-1',
      now: () => now,
      publish: (userId, publishedEvent) => published.push([userId, publishedEvent]),
    })

    await expect(worker.drainOnce()).resolves.toEqual({ claimed: 2, completed: 2, failed: 0 })
    expect(repo.completed).toEqual([
      { jobId: 'j1', ruleIds: ['r1'] },
      { jobId: 'j2', ruleIds: [] },
    ])
    expect(repo.ruleLoadCount).toBe(1)
    expect(published).toEqual([
      ['owner-1', expect.objectContaining({
        type: 'keyword_alert',
        requiresAcknowledgement: true,
      })],
      ['auditor-1', expect.objectContaining({
        type: 'keyword_alert',
        requiresAcknowledgement: false,
      })],
    ])
  })

  it('过滤任务创建后才生效的规则', async () => {
    const repo = new FakeScanRepo(
      [job('j1', 'refund', new Date('2026-09-03T10:00:00.000Z'))],
      [rule('r1', 'refund', new Date('2026-09-03T10:00:00.001Z'))],
    )
    const worker = new KeywordAlertWorker({
      repo,
      workerId: 'worker-1',
      now: () => now,
      publish: () => undefined,
    })

    await worker.drainOnce()

    expect(repo.completed).toEqual([{ jobId: 'j1', ruleIds: [] }])
  })

  it('处理失败只用固定 scan_failed 代码重排任务且不泄露正文、规则或错误文本', async () => {
    const body = 'BODY-MUST-NOT-LEAK'
    const pattern = 'PATTERN-MUST-NOT-LEAK'
    const repo = new FakeScanRepo([job('j1', body)], [rule('r1', pattern)])
    repo.completeError = new Error(`database rejected ${body} ${pattern}`)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const worker = new KeywordAlertWorker({
      repo,
      workerId: 'worker-1',
      now: () => now,
      publish: () => undefined,
    })

    await expect(worker.drainOnce()).resolves.toEqual({ claimed: 1, completed: 0, failed: 1 })
    expect(repo.failures).toEqual([{ jobId: 'j1', errorCode: 'scan_failed' }])
    const logged = JSON.stringify(warning.mock.calls)
    expect(logged).toContain('scan_failed')
    expect(logged).not.toContain(body)
    expect(logged).not.toContain(pattern)
    expect(logged).not.toContain('database rejected')
  })

  it('WebSocket 发布失败不重试已提交任务，持久告警仍供 HTTP 恢复', async () => {
    const repo = new FakeScanRepo([job('j1', 'refund')], [rule('r1', 'refund')])
    repo.deliveries.set('j1', [{ userId: 'owner-1', event: event('alert-1', true) }])
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const worker = new KeywordAlertWorker({
      repo,
      workerId: 'worker-1',
      now: () => now,
      publish: () => { throw new Error('socket payload must stay private') },
    })

    await expect(worker.drainOnce()).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 })
    expect(repo.committedJobIds).toEqual(new Set(['j1']))
    expect(repo.failures).toEqual([])
    const logged = JSON.stringify(warning.mock.calls)
    expect(logged).toContain('publish_failed')
    expect(logged).not.toContain('socket payload must stay private')
  })
})

describe('keywordAlertRetryDelayMs', () => {
  it.each([
    [1, 1_000],
    [2, 2_000],
    [9, 256_000],
    [10, 300_000],
  ])('第 %i 次失败延迟 %i ms', (attemptCount, expectedMs) => {
    expect(keywordAlertRetryDelayMs(attemptCount)).toBe(expectedMs)
  })
})

describe('KeywordAlertWorker lifecycle', () => {
  it('按 250 ms 空闲轮询且进行中的 drain 未完成时不重叠启动下一轮', async () => {
    vi.useFakeTimers()
    let releaseClaim: ((jobs: KeywordAlertScanJob[]) => void) | undefined
    let claimCount = 0
    const repo: KeywordAlertWorkerRepo = {
      claimBatch: async () => {
        claimCount += 1
        return new Promise<KeywordAlertScanJob[]>(resolve => { releaseClaim = resolve })
      },
      loadActiveRules: async () => [],
      complete: async () => [],
      fail: async () => undefined,
    }
    const worker = new KeywordAlertWorker({ repo, publish: () => undefined })

    worker.start()
    await vi.advanceTimersByTimeAsync(250)
    expect(claimCount).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(claimCount).toBe(1)

    releaseClaim?.([])
    await vi.advanceTimersByTimeAsync(249)
    expect(claimCount).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(claimCount).toBe(2)

    releaseClaim?.([])
    await worker.stop()
  })

  it('stop 取消后续轮询并等待当前 drain 完成', async () => {
    vi.useFakeTimers()
    let releaseClaim: ((jobs: KeywordAlertScanJob[]) => void) | undefined
    let claimCount = 0
    const repo: KeywordAlertWorkerRepo = {
      claimBatch: async () => {
        claimCount += 1
        return new Promise<KeywordAlertScanJob[]>(resolve => { releaseClaim = resolve })
      },
      loadActiveRules: async () => [],
      complete: async () => [],
      fail: async () => undefined,
    }
    const worker = new KeywordAlertWorker({ repo, publish: () => undefined })

    worker.start()
    await vi.advanceTimersByTimeAsync(250)
    let stopped = false
    const stopping = worker.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)

    releaseClaim?.([])
    await stopping
    await vi.advanceTimersByTimeAsync(1_000)
    expect(stopped).toBe(true)
    expect(claimCount).toBe(1)
  })
})
