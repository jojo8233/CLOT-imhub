import type { AccountStatus, Platform } from './platform.js'

export interface WsMessageEvent {
  type: 'message'
  messageId: string
  conversationId: string
  accountId: string
  platform: Platform
  direction: 'in' | 'out'
  body: string
  translatedBody: string | null
  sentAt: string
}

export interface WsAccountStatusEvent {
  type: 'account_status'
  accountId: string
  status: AccountStatus
}

export interface WsTranslationEvent {
  type: 'translation'
  messageId: string
  targetLang: string
  translatedText: string
  provider: string
}

export type WsServerEvent = WsMessageEvent | WsAccountStatusEvent | WsTranslationEvent
