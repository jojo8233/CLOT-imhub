import {
  normalizeSignalPersonId,
  parseSignalMessageKey,
  type NativeMessageTranslation,
} from '@im-hub/shared'
import {
  readSignalDesktopAci,
  type SignalDesktopModelLike,
  type SignalDesktopWindowLike,
} from './signal-desktop-message.js'

type TranslationListener = () => void

export interface SignalDesktopTranslationRenderApi {
  get(localMessageId: string): string | null
  subscribe(listener: TranslationListener): () => void
}

export interface SignalDesktopTranslationWindowLike extends SignalDesktopWindowLike {
  __imHubSignalResolveMessageForTranslation?(
    senderExternalId: string,
    sentAtMs: number,
  ): Promise<SignalDesktopModelLike | null | undefined>
  __imHubSignalTranslations?: SignalDesktopTranslationRenderApi
}

function attribute(message: SignalDesktopModelLike, key: string): unknown {
  try {
    return message.get?.(key) ?? message.attributes?.[key]
  } catch {
    return message.attributes?.[key]
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function revision(message: SignalDesktopModelLike): string | null {
  const editedAt = attribute(message, 'editMessageTimestamp')
  if (editedAt === undefined || editedAt === null) return 'initial'
  if (!Number.isSafeInteger(editedAt) || (editedAt as number) < 0) return null
  const date = new Date(editedAt as number)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function matchesCanonicalMessage(
  message: SignalDesktopModelLike,
  senderExternalId: string,
  sentAtMs: number,
  signalWindow: SignalDesktopTranslationWindowLike,
): boolean {
  const direction = attribute(message, 'type')
  let normalizedSource: string | null = null
  if (direction === 'incoming') {
    const source = nonEmptyString(attribute(message, 'sourceServiceId'))
      ?? nonEmptyString(attribute(message, 'source'))
    if (!source) return false
    try {
      normalizedSource = normalizeSignalPersonId(source)
    } catch {
      return false
    }
  } else if (direction === 'outgoing') {
    normalizedSource = readSignalDesktopAci(signalWindow)
  } else {
    return false
  }
  return normalizedSource === senderExternalId && attribute(message, 'sent_at') === sentAtMs
}

export class SignalDesktopTranslationStore {
  private readonly byLocalMessageId = new Map<string, {
    platformMessageId: string
    revision: string
    translatedText: string
  }>()
  private readonly listeners = new Set<TranslationListener>()

  readonly renderApi: SignalDesktopTranslationRenderApi = {
    get: localMessageId => this.byLocalMessageId.get(localMessageId)?.translatedText ?? null,
    subscribe: listener => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }

  constructor(private readonly signalWindow: SignalDesktopTranslationWindowLike) {
    signalWindow.__imHubSignalTranslations = this.renderApi
  }

  async applyBatch(translations: NativeMessageTranslation[]): Promise<void> {
    for (const translation of translations) await this.apply(translation)
  }

  clear(message: SignalDesktopModelLike): void {
    const localMessageId = nonEmptyString(attribute(message, 'id'))
    if (!localMessageId || !this.byLocalMessageId.delete(localMessageId)) return
    this.notify()
  }

  private async apply(translation: NativeMessageTranslation): Promise<void> {
    const key = parseSignalMessageKey(translation.platformMessageId)
    const resolveMessage = this.signalWindow.__imHubSignalResolveMessageForTranslation
    if (!key || !resolveMessage) return

    let message: SignalDesktopModelLike | null | undefined
    try {
      message = await resolveMessage(key.senderId, key.sentAtMs)
    } catch {
      return
    }
    if (!message || !matchesCanonicalMessage(
      message, key.senderId, key.sentAtMs, this.signalWindow,
    )) return
    if (revision(message) !== translation.revision) return
    const localMessageId = nonEmptyString(attribute(message, 'id'))
    if (!localMessageId) return

    const current = this.byLocalMessageId.get(localMessageId)
    if (current?.platformMessageId === translation.platformMessageId
      && current.revision === translation.revision
      && current.translatedText === translation.translatedText) return
    this.byLocalMessageId.set(localMessageId, translation)
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
