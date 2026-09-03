import type { WsKeywordAlertEvent } from '@im-hub/shared'
import type { Kysely } from 'kysely'
import { describe, expect, it, vi } from 'vitest'
import type { Database } from '../db/types.js'
import { KyselyKeywordAlertScanRepo } from './scan-repo.js'
import { startKeywordAlertRuntime } from './runtime.js'
import type { KeywordAlertWorkerOptions } from './worker.js'

describe('startKeywordAlertRuntime', () => {
  it('只构造并启动一个 worker，透传 publish，并在 stop 时等待同一实例', async () => {
    const db = {} as Kysely<Database>
    const publish = vi.fn<(userId: string, event: WsKeywordAlertEvent) => void>()
    const start = vi.fn()
    let releaseStop: (() => void) | undefined
    const stop = vi.fn(() => new Promise<void>(resolve => { releaseStop = resolve }))
    let receivedOptions: KeywordAlertWorkerOptions | undefined
    const createWorker = vi.fn((options: KeywordAlertWorkerOptions) => {
      receivedOptions = options
      return { start, stop }
    })

    const runtime = startKeywordAlertRuntime({ db, publish, createWorker })

    expect(createWorker).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledOnce()
    if (receivedOptions === undefined) throw new Error('expected worker options')
    expect(receivedOptions.repo).toBeInstanceOf(KyselyKeywordAlertScanRepo)
    expect(receivedOptions.publish).toBe(publish)

    const event: WsKeywordAlertEvent = {
      type: 'keyword_alert',
      alertId: 'alert-runtime-sentinel',
      severity: 'important',
      requiresAcknowledgement: true,
      createdAt: '2026-09-03T10:00:00.000Z',
    }
    receivedOptions.publish('recipient-runtime-sentinel', event)
    expect(publish).toHaveBeenCalledWith('recipient-runtime-sentinel', event)

    let stopped = false
    const stopping = runtime.stop().then(() => { stopped = true })
    await Promise.resolve()

    expect(stop).toHaveBeenCalledOnce()
    expect(stopped).toBe(false)
    const release = releaseStop
    if (release === undefined) throw new Error('expected worker stop release')
    release()
    await stopping
    expect(stopped).toBe(true)
  })
})
