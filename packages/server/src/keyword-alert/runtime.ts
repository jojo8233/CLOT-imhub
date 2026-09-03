import type { WsKeywordAlertEvent } from '@im-hub/shared'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types.js'
import { KyselyKeywordAlertScanRepo } from './scan-repo.js'
import { KeywordAlertWorker, type KeywordAlertWorkerOptions } from './worker.js'

export interface KeywordAlertWorkerLifecycle {
  stop(): Promise<void>
}

export interface KeywordAlertRuntimeOptions {
  db: Kysely<Database>
  publish(userId: string, event: WsKeywordAlertEvent): void
  createWorker?: (
    options: KeywordAlertWorkerOptions,
  ) => Pick<KeywordAlertWorker, 'start' | 'stop'>
}

export function startKeywordAlertRuntime(
  options: KeywordAlertRuntimeOptions,
): KeywordAlertWorkerLifecycle {
  const createWorker = options.createWorker
    ?? (workerOptions => new KeywordAlertWorker(workerOptions))
  const worker = createWorker({
    repo: new KyselyKeywordAlertScanRepo(options.db),
    publish: options.publish,
  })
  worker.start()

  return {
    stop: () => worker.stop(),
  }
}
