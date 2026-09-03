import type { WsKeywordAlertEvent } from '@im-hub/shared'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types.js'
import { KyselyKeywordAlertScanRepo } from './scan-repo.js'
import { KeywordAlertWorker, type KeywordAlertWorkerOptions } from './worker.js'

export interface KeywordAlertWorkerLifecycle {
  stop(): Promise<void>
}

export type KeywordAlertLifecycleErrorCode =
  | 'keyword_runtime_start_failed'
  | 'keyword_runtime_stop_failed'
  | 'adapter_disconnect_failed'
  | 'app_close_failed'
  | 'redis_quit_failed'
  | 'db_destroy_failed'

export interface KeywordAlertServerLifecycle {
  shutdown(): Promise<void>
}

export interface KeywordAlertServerLifecycleOptions {
  runtime: KeywordAlertWorkerLifecycle
  stopAdapters(): Promise<unknown>
  closeApp(): Promise<unknown>
  quitRedis(): Promise<unknown>
  destroyDb(): Promise<unknown>
  onError(code: KeywordAlertLifecycleErrorCode, count: number): void
}

export interface KeywordAlertServerStartOptions
  extends Omit<KeywordAlertServerLifecycleOptions, 'runtime'> {
  startRuntime(): KeywordAlertWorkerLifecycle | Promise<KeywordAlertWorkerLifecycle>
}

export type KeywordAlertServerStartResult =
  | { ok: true; lifecycle: KeywordAlertServerLifecycle }
  | { ok: false }

export interface KeywordAlertShutdownSignalHandlerOptions {
  lifecycle: KeywordAlertServerLifecycle
  onSignal(signal: 'SIGINT' | 'SIGTERM'): void
  exit(code: 0 | 1): void
}

export interface KeywordAlertRuntimeOptions {
  db: Kysely<Database>
  publish(userId: string, event: WsKeywordAlertEvent): void
  createWorker?: (
    options: KeywordAlertWorkerOptions,
  ) => Pick<KeywordAlertWorker, 'start' | 'stop'>
}

export async function startKeywordAlertRuntime(
  options: KeywordAlertRuntimeOptions,
): Promise<KeywordAlertWorkerLifecycle> {
  const createWorker = options.createWorker
    ?? (workerOptions => new KeywordAlertWorker(workerOptions))
  const worker = createWorker({
    repo: new KyselyKeywordAlertScanRepo(options.db),
    publish: options.publish,
  })
  try {
    worker.start()
  } catch {
    try {
      await worker.stop()
    } catch {
      // 宿主生命周期只接收固定启动失败，不传播 worker 错误正文。
    }
    throw new Error('keyword_alert_runtime_start_failed')
  }

  return {
    stop: () => worker.stop(),
  }
}

export async function startKeywordAlertServerLifecycle(
  options: KeywordAlertServerStartOptions,
): Promise<KeywordAlertServerStartResult> {
  try {
    const runtime = await options.startRuntime()
    return {
      ok: true,
      lifecycle: createKeywordAlertServerLifecycle({ ...options, runtime }),
    }
  } catch {
    reportLifecycleError(options.onError, 'keyword_runtime_start_failed', 1)
    const cleanup = createKeywordAlertServerLifecycle({
      ...options,
      runtime: { stop: async () => undefined },
    })
    try {
      await cleanup.shutdown()
    } catch {
      // 每个清理失败已经通过固定 code/count 上报。
    }
    return { ok: false }
  }
}

export function createKeywordAlertServerLifecycle(
  options: KeywordAlertServerLifecycleOptions,
): KeywordAlertServerLifecycle {
  let shutdownPromise: Promise<void> | undefined

  return {
    shutdown: () => {
      shutdownPromise ??= runKeywordAlertServerShutdown(options)
      return shutdownPromise
    },
  }
}

export function createKeywordAlertShutdownSignalHandler(
  options: KeywordAlertShutdownSignalHandlerOptions,
): (signal: 'SIGINT' | 'SIGTERM') => void {
  let handling = false

  return signal => {
    if (handling) return
    handling = true
    options.onSignal(signal)
    const handled = options.lifecycle.shutdown().then(
      () => { options.exit(0) },
      () => { options.exit(1) },
    )
    void handled.catch(() => undefined)
  }
}

async function runKeywordAlertServerShutdown(
  options: KeywordAlertServerLifecycleOptions,
): Promise<void> {
  const steps: ReadonlyArray<{
    code: Exclude<KeywordAlertLifecycleErrorCode, 'keyword_runtime_start_failed'>
    run(): Promise<unknown>
  }> = [
    { code: 'keyword_runtime_stop_failed', run: () => options.runtime.stop() },
    { code: 'adapter_disconnect_failed', run: () => options.stopAdapters() },
    { code: 'app_close_failed', run: () => options.closeApp() },
    { code: 'redis_quit_failed', run: () => options.quitRedis() },
    { code: 'db_destroy_failed', run: () => options.destroyDb() },
  ]
  let failureCount = 0

  for (const step of steps) {
    try {
      await step.run()
    } catch {
      failureCount += 1
      reportLifecycleError(options.onError, step.code, 1)
    }
  }

  if (failureCount > 0) throw new Error('keyword_alert_server_shutdown_failed')
}

function reportLifecycleError(
  onError: KeywordAlertServerLifecycleOptions['onError'],
  code: KeywordAlertLifecycleErrorCode,
  count: number,
): void {
  try {
    onError(code, count)
  } catch {
    // 错误上报本身不能中断资源释放。
  }
}
