import { z } from 'zod'
import type { TelegramShadowObservation } from './telegram.js'

const shadowAccountIdsSchema = z.string()
  .transform(value => value
    .split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0))
  .pipe(z.array(z.string().uuid()))
  .transform(ids => [...new Set(ids)])

export function parseTelegramTdlibShadowAccountIds(value: string): string[] {
  return shadowAccountIdsSchema.parse(value)
}

interface TelegramShadowRecorder {
  record(observation: TelegramShadowObservation): Promise<void>
}

/**
 * Per-account TDLib central-ingest gate used during the Telegram shadow rollout.
 *
 * Accounts not in the allowlist keep the established behavior. Allowlisted accounts
 * keep TDLib connected and record its real observations, but only telegram-tt may
 * mutate the central message projection until the account is removed from the list.
 */
export class TelegramTdlibIngestGate {
  private readonly shadowAccountIds: Set<string>

  constructor(
    shadowAccountIds: readonly string[],
    private readonly recorder: TelegramShadowRecorder,
  ) {
    this.shadowAccountIds = new Set(shadowAccountIds)
  }

  isShadowOnly(accountId: string): boolean {
    return this.shadowAccountIds.has(accountId)
  }

  async route(
    observation: TelegramShadowObservation,
    activeIngest: () => Promise<void>,
  ): Promise<void> {
    if (!this.isShadowOnly(observation.accountId)) {
      await activeIngest()
      return
    }
    await this.recorder.record(observation)
  }
}
