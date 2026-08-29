import { describe, expect, it } from 'vitest'
import type { NormalizedMessage } from '@im-hub/shared'
import {
  buildTelegramDeleteObservation,
  buildTelegramRemapObservation,
  buildTelegramUpsertObservation,
} from './telegram.js'

function message(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    platform: 'telegram',
    accountId: 'account-1',
    platformConversationId: '-100123',
    platformMessageId: '-100123:42',
    direction: 'in',
    senderExternalId: '777',
    senderDisplayName: 'Jane',
    conversationDisplayName: 'Support',
    body: 'hello',
    mediaRefs: [],
    replyToPlatformMessageId: null,
    editedAt: null,
    editVersion: null,
    sentAt: new Date('2026-08-29T00:00:00.000Z'),
    raw: { source: 'tdlib' },
    ...overrides,
  }
}

describe('Telegram shadow observations', () => {
  it('ignores source-specific display, raw, and remote media references', () => {
    const tdlib = buildTelegramUpsertObservation('tdlib', message({
      senderDisplayName: null,
      conversationDisplayName: null,
      mediaRefs: [{
        kind: 'file', remoteId: 'tdlib-file-id', fileName: 'invoice.pdf',
        mimeType: 'application/pdf', sizeBytes: 120,
      }],
      raw: { _: 'updateNewMessage' },
    }))
    const telegramTt = buildTelegramUpsertObservation('telegram-tt', message({
      senderDisplayName: 'Jane Doe',
      conversationDisplayName: 'Sales',
      mediaRefs: [{
        kind: 'file', remoteId: 'mtp-document-reference', fileName: 'invoice.pdf',
        mimeType: 'application/pdf', sizeBytes: 120,
      }],
      raw: { _: 'newMessage' },
    }))

    expect(tdlib.factKey).toBe('upsert:-100123:42:base')
    expect(telegramTt.factKey).toBe(tdlib.factKey)
    expect(telegramTt.semanticHash).toBe(tdlib.semanticHash)
  })

  it('detects semantic body and media-shape differences', () => {
    const base = buildTelegramUpsertObservation('tdlib', message())
    const changedBody = buildTelegramUpsertObservation('telegram-tt', message({ body: 'changed' }))
    const changedMedia = buildTelegramUpsertObservation('telegram-tt', message({
      mediaRefs: [{ kind: 'image', remoteId: 'ignored', sizeBytes: 10 }],
    }))

    expect(changedBody.semanticHash).not.toBe(base.semanticHash)
    expect(changedMedia.semanticHash).not.toBe(base.semanticHash)
  })

  it('uses source-independent editedAt for edit facts and ignores transport edit versions', () => {
    const telegramTt = buildTelegramUpsertObservation('telegram-tt', message({
      editedAt: new Date('2026-08-29T00:01:00.000Z'), editVersion: 9,
    }))
    const tdlib = buildTelegramUpsertObservation('tdlib', message({
      editedAt: new Date('2026-08-29T00:01:00.000Z'), editVersion: null,
    }))

    expect(telegramTt.factKey)
      .toBe('upsert:-100123:42:edited-at:2026-08-29T00:01:00.000Z')
    expect(tdlib.factKey).toBe(telegramTt.factKey)
    expect(tdlib.semanticHash).toBe(telegramTt.semanticHash)
  })

  it('builds source-independent delete and remap facts', () => {
    const deleted = buildTelegramDeleteObservation('account-1', 'tdlib', '-100123:42')
    const remapped = buildTelegramRemapObservation(
      'account-1', 'telegram-tt', '-100123:temp:telegram-tt:abc:1', '-100123:42',
    )

    expect(deleted).toMatchObject({
      eventType: 'delete', factKey: 'delete:-100123:42', source: 'tdlib',
    })
    expect(remapped).toMatchObject({
      eventType: 'remap',
      factKey: 'remap:-100123:temp:telegram-tt:abc:1:-100123:42',
      source: 'telegram-tt',
    })
  })
})
