import { describe, expect, it, vi } from 'vitest'
import {
  parseTelegramTdlibShadowAccountIds,
  TelegramTdlibIngestGate,
} from './rollout.js'
import type { TelegramShadowObservation } from './telegram.js'

const accountId = '10000000-0000-4000-8000-000000000001'
const observation: TelegramShadowObservation = {
  accountId,
  source: 'tdlib',
  eventType: 'delete',
  factKey: 'delete:6639331234:3502',
  semanticHash: 'hash',
}

describe('TelegramTdlibIngestGate', () => {
  it('keeps TDLib central ingest active by default', async () => {
    const record = vi.fn().mockResolvedValue(undefined)
    const activeIngest = vi.fn().mockResolvedValue(undefined)

    await new TelegramTdlibIngestGate([], { record }).route(observation, activeIngest)

    expect(activeIngest).toHaveBeenCalledOnce()
    expect(record).not.toHaveBeenCalled()
  })

  it('records the real TDLib observation without central ingest for a canary account', async () => {
    const record = vi.fn().mockResolvedValue(undefined)
    const activeIngest = vi.fn().mockResolvedValue(undefined)

    await new TelegramTdlibIngestGate([accountId], { record }).route(observation, activeIngest)

    expect(record).toHaveBeenCalledWith(observation)
    expect(activeIngest).not.toHaveBeenCalled()
  })

  it('does not hide recorder failures during a canary', async () => {
    const failure = new Error('shadow ledger unavailable')
    const record = vi.fn().mockRejectedValue(failure)

    await expect(new TelegramTdlibIngestGate([accountId], { record }).route(
      observation,
      vi.fn().mockResolvedValue(undefined),
    )).rejects.toBe(failure)
  })
})

describe('parseTelegramTdlibShadowAccountIds', () => {
  it('parses, trims, and deduplicates the comma-separated canary allowlist', () => {
    expect(parseTelegramTdlibShadowAccountIds(` ${accountId},${accountId}, `)).toEqual([accountId])
    expect(parseTelegramTdlibShadowAccountIds('')).toEqual([])
  })

  it('rejects invalid account ids instead of broadening the rollout', () => {
    expect(() => parseTelegramTdlibShadowAccountIds('all')).toThrow()
  })
})
