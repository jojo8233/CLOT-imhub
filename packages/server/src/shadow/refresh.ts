import type { NormalizedMessage } from '@im-hub/shared'
import type { AdapterManager } from '../adapters/manager.js'

interface ShadowRefreshIngestor {
  ingestDetailed(
    message: NormalizedMessage,
    onStored: undefined,
    shadowSource: 'tdlib',
  ): Promise<unknown>
}

export interface TelegramShadowRefreshResult {
  requested: number
  found: number
  recorded: number
  unavailable: number
  unsupported: number
  failed: number
}

export class TelegramShadowRefresher {
  constructor(
    private readonly adapters: Pick<AdapterManager, 'fetchCurrentMessages'>,
    private readonly ingestor: ShadowRefreshIngestor,
  ) {}

  async refreshTdlib(
    accountId: string,
    platformMessageIds: string[],
  ): Promise<TelegramShadowRefreshResult> {
    const uniqueIds = [...new Set(platformMessageIds)]
    if (uniqueIds.length < 1 || uniqueIds.length > 10) {
      throw new Error('TDLib shadow refresh requires between 1 and 10 unique message ids')
    }
    const fetched = await this.adapters.fetchCurrentMessages(accountId, uniqueIds)
    const result: TelegramShadowRefreshResult = {
      requested: uniqueIds.length,
      found: 0,
      recorded: 0,
      unavailable: 0,
      unsupported: 0,
      failed: 0,
    }

    for (const [index, item] of fetched.entries()) {
      switch (item.status) {
        case 'unavailable':
          result.unavailable += 1
          continue
        case 'unsupported':
          result.unsupported += 1
          continue
        case 'found':
          result.found += 1
          try {
            // 只有实际 TDLib getMessage 返回的快照才能以 tdlib 来源写入。
            // 这里不接受调用方传 source，避免把中央库行或 telegram-tt 行伪造成 TDLib 事实。
            await this.ingestor.ingestDetailed(item.message, undefined, 'tdlib')
            result.recorded += 1
          } catch {
            console.error(
              `[shadow-refresh] 账号 ${accountId} 写入 TDLib 当前快照失败（${index + 1}/${fetched.length}）`,
            )
            result.failed += 1
          }
      }
    }
    return result
  }
}
