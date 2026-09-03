import type { WsKeywordAlertEvent } from '@im-hub/shared'
import type { Kysely } from 'kysely'
import { describe, expect, it, vi } from 'vitest'
import type { Database } from '../db/types.js'
import { KyselyKeywordAlertScanRepo } from './scan-repo.js'
import {
  createKeywordAlertServerLifecycle,
  createKeywordAlertShutdownSignalHandler,
  startKeywordAlertServerLifecycle,
  startKeywordAlertRuntime,
  stopKeywordAlertAdapters,
} from './runtime.js'
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

    const runtime = await startKeywordAlertRuntime({ db, publish, createWorker })

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

describe('keyword alert server lifecycle', () => {
  it('runtime 启动失败时先停止已构造 worker 再释放全部宿主资源', async () => {
    const sensitiveSentinels = [
      'BODY-MUST-NOT-LEAK',
      'PATTERN-MUST-NOT-LEAK',
      'MESSAGE-ID-MUST-NOT-LEAK',
    ]
    const order: string[] = []
    const reported: Array<{ code: string; count: number }> = []

    const result = await startKeywordAlertServerLifecycle({
      startRuntime: () => startKeywordAlertRuntime({
        db: {} as Kysely<Database>,
        publish: () => undefined,
        createWorker: () => ({
          start: () => {
            order.push('worker-start')
            throw new Error(sensitiveSentinels.join(' '))
          },
          stop: async () => { order.push('worker-stop') },
        }),
      }),
      stopAdapters: async () => { order.push('adapters') },
      closeApp: async () => { order.push('app') },
      quitRedis: async () => { order.push('redis') },
      destroyDb: async () => { order.push('db') },
      onError: (code, count) => { reported.push({ code, count }) },
    })

    expect(result).toEqual({ ok: false })
    expect(order).toEqual(['worker-start', 'worker-stop', 'adapters', 'app', 'redis', 'db'])
    expect(reported).toEqual([{ code: 'keyword_runtime_start_failed', count: 1 }])
    const serializedReport = JSON.stringify(reported)
    for (const sentinel of sensitiveSentinels) {
      expect(serializedReport).not.toContain(sentinel)
    }
  })

  it('重复同类或异类信号都复用同一个清理 Promise 且只退出一次', async () => {
    const order: string[] = []
    let releaseRuntimeStop: (() => void) | undefined
    const runtimeStopped = new Promise<void>(resolve => { releaseRuntimeStop = resolve })
    const lifecycle = createKeywordAlertServerLifecycle({
      runtime: {
        stop: () => {
          order.push('runtime')
          return runtimeStopped
        },
      },
      stopAdapters: async () => { order.push('adapters') },
      closeApp: async () => { order.push('app') },
      quitRedis: async () => { order.push('redis') },
      destroyDb: async () => { order.push('db') },
      onError: () => undefined,
    })
    const receivedSignals: string[] = []
    const exitCodes: number[] = []
    const handleSignal = createKeywordAlertShutdownSignalHandler({
      lifecycle,
      onSignal: signal => { receivedSignals.push(signal) },
      exit: code => { exitCodes.push(code) },
    })

    handleSignal('SIGINT')
    handleSignal('SIGINT')
    handleSignal('SIGTERM')
    await Promise.resolve()
    const firstShutdown = lifecycle.shutdown()
    const secondShutdown = lifecycle.shutdown()

    expect(secondShutdown).toBe(firstShutdown)
    expect(order).toEqual(['runtime'])
    const release = releaseRuntimeStop
    if (release === undefined) throw new Error('expected runtime stop release')
    release()
    await firstShutdown
    await Promise.resolve()

    expect(order).toEqual(['runtime', 'adapters', 'app', 'redis', 'db'])
    expect(receivedSignals).toEqual(['SIGINT'])
    expect(exitCodes).toEqual([0])
  })

  it('runtime stop 失败仍完成其余清理并只报告固定错误', async () => {
    const sensitiveSentinels = [
      'BODY-MUST-NOT-LEAK',
      'PATTERN-MUST-NOT-LEAK',
      'ACCOUNT-ID-MUST-NOT-LEAK',
      'RECIPIENT-ID-MUST-NOT-LEAK',
    ]
    const order: string[] = []
    const reported: Array<{ code: string; count: number }> = []
    const lifecycle = createKeywordAlertServerLifecycle({
      runtime: {
        stop: async () => {
          order.push('runtime')
          throw new Error(sensitiveSentinels.join(' '))
        },
      },
      stopAdapters: async () => { order.push('adapters') },
      closeApp: async () => {
        order.push('app')
        throw new Error(sensitiveSentinels.join(' '))
      },
      quitRedis: async () => { order.push('redis') },
      destroyDb: async () => { order.push('db') },
      onError: (code, count) => { reported.push({ code, count }) },
    })
    const exitCodes: number[] = []
    const handleSignal = createKeywordAlertShutdownSignalHandler({
      lifecycle,
      onSignal: () => undefined,
      exit: code => { exitCodes.push(code) },
    })

    handleSignal('SIGTERM')
    await Promise.resolve()
    const shutdown = lifecycle.shutdown()

    await expect(shutdown).rejects.toThrow('keyword_alert_server_shutdown_failed')
    await Promise.resolve()
    expect(order).toEqual(['runtime', 'adapters', 'app', 'redis', 'db'])
    expect(reported).toEqual([
      { code: 'keyword_runtime_stop_failed', count: 1 },
      { code: 'app_close_failed', count: 1 },
    ])
    expect(exitCodes).toEqual([1])
    const serializedReport = JSON.stringify(reported)
    for (const sentinel of sensitiveSentinels) {
      expect(serializedReport).not.toContain(sentinel)
    }
  })

  it('等待所有适配器断连并将拒绝数聚合为固定生命周期失败', async () => {
    const sensitiveSentinels = [
      'BODY-MUST-NOT-LEAK',
      'PATTERN-MUST-NOT-LEAK',
      'ACCOUNT-ID-MUST-NOT-LEAK',
      'ADAPTER-ID-MUST-NOT-LEAK',
    ]
    const order: string[] = []
    const reported: Array<{ code: string; count: number }> = []
    let adapterFailure: unknown
    let startedCount = 0
    let resolveAllStarted: (() => void) | undefined
    const allStarted = new Promise<void>(resolve => { resolveAllStarted = resolve })
    let releaseLastDisconnect: (() => void) | undefined
    const recordStarted = (name: string): void => {
      order.push(name)
      startedCount += 1
      if (startedCount !== 3) return
      const resolve = resolveAllStarted
      if (resolve === undefined) throw new Error('expected all-started resolver')
      resolve()
    }
    const lifecycle = createKeywordAlertServerLifecycle({
      runtime: { stop: async () => { order.push('runtime') } },
      stopAdapters: async () => {
        try {
          await stopKeywordAlertAdapters([
            async () => {
              recordStarted('adapter-1')
              throw new Error(`${sensitiveSentinels[0]} ${sensitiveSentinels[2]}`)
            },
            async () => {
              recordStarted('adapter-2')
              throw new Error(`${sensitiveSentinels[1]} ${sensitiveSentinels[3]}`)
            },
            () => {
              recordStarted('adapter-3')
              return new Promise<void>(resolve => {
                releaseLastDisconnect = () => {
                  order.push('adapter-3-finished')
                  resolve()
                }
              })
            },
          ])
        } catch (error) {
          adapterFailure = error
          throw error
        }
      },
      closeApp: async () => { order.push('app') },
      quitRedis: async () => { order.push('redis') },
      destroyDb: async () => { order.push('db') },
      onError: (code, count) => { reported.push({ code, count }) },
    })
    const exitCodes: number[] = []
    const handleSignal = createKeywordAlertShutdownSignalHandler({
      lifecycle,
      onSignal: () => undefined,
      exit: code => { exitCodes.push(code) },
    })

    handleSignal('SIGTERM')
    const shutdown = lifecycle.shutdown()
    const firstOutcome = await Promise.race([
      allStarted.then(() => 'all-started' as const),
      shutdown.then(
        () => 'shutdown-settled' as const,
        () => 'shutdown-settled' as const,
      ),
    ])

    expect(firstOutcome).toBe('all-started')
    expect(order).toEqual(['runtime', 'adapter-1', 'adapter-2', 'adapter-3'])
    const release = releaseLastDisconnect
    if (release === undefined) throw new Error('expected last disconnect release')
    release()

    let shutdownFailure: unknown
    try {
      await shutdown
    } catch (error) {
      shutdownFailure = error
    }
    await Promise.resolve()

    expect(String(shutdownFailure)).toBe('Error: keyword_alert_server_shutdown_failed')
    expect(String(adapterFailure)).toBe('Error: adapter_disconnect_failed')
    expect(order).toEqual([
      'runtime',
      'adapter-1',
      'adapter-2',
      'adapter-3',
      'adapter-3-finished',
      'app',
      'redis',
      'db',
    ])
    expect(reported).toEqual([{ code: 'adapter_disconnect_failed', count: 2 }])
    expect(exitCodes).toEqual([1])
    const serializedOutcome = [
      String(shutdownFailure),
      String(adapterFailure),
      JSON.stringify(adapterFailure),
      JSON.stringify(reported),
    ].join(' ')
    for (const sentinel of sensitiveSentinels) {
      expect(serializedOutcome).not.toContain(sentinel)
    }
  })

  it('所有适配器断连成功时聚合正常完成', async () => {
    const completed: string[] = []

    await expect(stopKeywordAlertAdapters([
      async () => { completed.push('adapter-1') },
      async () => { completed.push('adapter-2') },
    ])).resolves.toBeUndefined()

    expect(completed).toEqual(['adapter-1', 'adapter-2'])
  })
})
