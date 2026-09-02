import { describe, expect, it, vi } from 'vitest'
import type { NormalizedMessage } from '@im-hub/shared'
import { TelegramShadowRefresher } from './refresh.js'

function message(platformMessageId: string): NormalizedMessage {
  return {
    platform: 'telegram',
    accountId: 'account-1',
    platformConversationId: '6639331234',
    platformMessageId,
    direction: 'in',
    senderExternalId: 'sender-1',
    senderDisplayName: null,
    conversationDisplayName: null,
    body: 'safe fixture',
    mediaRefs: [],
    replyToPlatformMessageId: null,
    editedAt: null,
    editVersion: null,
    sentAt: new Date('2026-08-29T00:00:00.000Z'),
    raw: {},
  }
}

describe('TelegramShadowRefresher', () => {
  it('only records snapshots actually returned by TDLib with the tdlib source', async () => {
    const found = message('6639331234:3502')
    const adapters = {
      fetchCurrentMessages: vi.fn(async () => [
        { platformMessageId: found.platformMessageId, status: 'found' as const, message: found },
        { platformMessageId: '6639331234:3503', status: 'unavailable' as const },
        { platformMessageId: '6639331234:3504', status: 'unsupported' as const },
      ]),
    }
    const ingestor = { ingestDetailed: vi.fn(async () => ({})) }
    const refresher = new TelegramShadowRefresher(adapters, ingestor)

    await expect(refresher.refreshTdlib('account-1', [
      '6639331234:3502', '6639331234:3503', '6639331234:3504',
    ])).resolves.toEqual({
      requested: 3,
      found: 1,
      recorded: 1,
      unavailable: 1,
      unsupported: 1,
      failed: 0,
    })
    expect(ingestor.ingestDetailed).toHaveBeenCalledWith(found, undefined, 'tdlib')
  })

  it('isolates one ingest failure and reports partial progress', async () => {
    const first = message('6639331234:3502')
    const second = message('6639331234:3503')
    const adapters = {
      fetchCurrentMessages: vi.fn(async () => [
        { platformMessageId: first.platformMessageId, status: 'found' as const, message: first },
        { platformMessageId: second.platformMessageId, status: 'found' as const, message: second },
      ]),
    }
    const ingestor = {
      ingestDetailed: vi.fn()
        .mockRejectedValueOnce(new Error('write failed'))
        .mockResolvedValueOnce({}),
    }

    await expect(new TelegramShadowRefresher(adapters, ingestor).refreshTdlib(
      'account-1',
      [first.platformMessageId, second.platformMessageId],
    )).resolves.toMatchObject({ found: 2, recorded: 1, failed: 1 })
    expect(ingestor.ingestDetailed).toHaveBeenCalledTimes(2)
  })

  it('deduplicates ids and enforces the ten-message ceiling before platform access', async () => {
    const adapters = { fetchCurrentMessages: vi.fn(async () => []) }
    const ingestor = { ingestDetailed: vi.fn(async () => ({})) }
    const refresher = new TelegramShadowRefresher(adapters, ingestor)

    await refresher.refreshTdlib('account-1', ['6639331234:3502', '6639331234:3502'])
    expect(adapters.fetchCurrentMessages).toHaveBeenCalledWith('account-1', ['6639331234:3502'])

    await expect(refresher.refreshTdlib(
      'account-1',
      Array.from({ length: 11 }, (_, index) => `6639331234:${3500 + index}`),
    )).rejects.toThrow('between 1 and 10')
    expect(adapters.fetchCurrentMessages).toHaveBeenCalledTimes(1)
  })
})
