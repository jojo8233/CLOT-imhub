import { randomUUID } from 'node:crypto'
import type { WsKeywordAlertEvent } from '@im-hub/shared'
import { AhoCorasickKeywordMatcher } from './matcher.js'
import {
  keywordAlertRetryDelayMs,
  type ActiveKeywordRule,
  type KeywordAlertDelivery,
  type KeywordAlertScanJob,
} from './scan-repo.js'

export { keywordAlertRetryDelayMs } from './scan-repo.js'

const IDLE_POLL_MS = 250

export interface KeywordAlertWorkerRepo {
  claimBatch(workerId: string, now: Date): Promise<KeywordAlertScanJob[]>
  loadActiveRules(): Promise<ActiveKeywordRule[]>
  complete(
    workerId: string,
    job: KeywordAlertScanJob,
    matchedRules: readonly ActiveKeywordRule[],
  ): Promise<KeywordAlertDelivery[]>
  fail(
    workerId: string,
    job: KeywordAlertScanJob,
    now: Date,
    errorCode: 'scan_failed',
  ): Promise<void>
}

export interface KeywordAlertWorkerOptions {
  repo: KeywordAlertWorkerRepo
  publish(userId: string, event: WsKeywordAlertEvent): void
  now?: () => Date
  workerId?: string
}

export class KeywordAlertWorker {
  private readonly repo: KeywordAlertWorkerRepo
  private readonly publish: (userId: string, event: WsKeywordAlertEvent) => void
  private readonly now: () => Date
  private readonly workerId: string
  private started = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private currentDrain: Promise<void> | undefined

  constructor(options: KeywordAlertWorkerOptions) {
    this.repo = options.repo
    this.publish = options.publish
    this.now = options.now ?? (() => new Date())
    this.workerId = options.workerId ?? `keyword-alert-${randomUUID()}`
  }

  async drainOnce(): Promise<{ claimed: number; completed: number; failed: number }> {
    const jobs = await this.repo.claimBatch(this.workerId, this.now())
    if (jobs.length === 0) return { claimed: 0, completed: 0, failed: 0 }

    let rules: ActiveKeywordRule[]
    let matcher: AhoCorasickKeywordMatcher
    try {
      rules = await this.repo.loadActiveRules()
      matcher = new AhoCorasickKeywordMatcher(rules)
    } catch {
      await this.failJobs(jobs)
      return { claimed: jobs.length, completed: 0, failed: jobs.length }
    }

    const rulesById = new Map(rules.map(rule => [rule.id, rule]))
    let completed = 0
    let failed = 0

    for (const job of jobs) {
      let deliveries: KeywordAlertDelivery[]
      try {
        const matchedRules = matcher.matchRuleIds(job.bodySnapshot)
          .map(ruleId => rulesById.get(ruleId))
          .filter((rule): rule is ActiveKeywordRule => rule !== undefined)
          .filter(rule => rule.effectiveAt <= job.createdAt)
        deliveries = await this.repo.complete(this.workerId, job, matchedRules)
        completed += 1
      } catch {
        failed += 1
        await this.failJob(job)
        continue
      }

      let publishFailureCount = 0
      for (const delivery of deliveries) {
        try {
          this.publish(delivery.userId, delivery.event)
        } catch {
          publishFailureCount += 1
        }
      }
      if (publishFailureCount > 0) logFixedEvent('publish_failed', publishFailureCount)
    }

    return { claimed: jobs.length, completed, failed }
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.scheduleNextDrain()
  }

  async stop(): Promise<void> {
    this.started = false
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    await this.currentDrain
  }

  private scheduleNextDrain(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.started) return

      const drain = this.drainOnce()
        .then(() => undefined)
        .catch(() => { logFixedEvent('drain_failed', 1) })
      this.currentDrain = drain
      void drain.finally(() => {
        if (this.currentDrain === drain) this.currentDrain = undefined
        if (this.started) this.scheduleNextDrain()
      })
    }, IDLE_POLL_MS)
  }

  private async failJobs(jobs: readonly KeywordAlertScanJob[]): Promise<void> {
    for (const job of jobs) await this.failJob(job)
  }

  private async failJob(job: KeywordAlertScanJob): Promise<void> {
    logFixedEvent('scan_failed', 1)
    try {
      await this.repo.fail(this.workerId, job, this.now(), 'scan_failed')
    } catch {
      logFixedEvent('fail_update_failed', 1)
    }
  }
}

function logFixedEvent(
  code: 'scan_failed' | 'fail_update_failed' | 'publish_failed' | 'drain_failed',
  count: number,
): void {
  console.warn(`[keyword-alert-worker] code=${code} count=${count}`)
}
