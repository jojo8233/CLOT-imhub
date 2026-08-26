import type { Platform } from './platform.js'

export const NATIVE_CONTROL_AUTH_SCHEME = 'NativeGrant' as const
export const NATIVE_CONTROL_GRANT_TTL_SECONDS = 5 * 60

export interface NativeControlGrantResponse {
  grant: string
  expiresAt: string
}

export interface NativeControlGrantVerification {
  accountId: string
  platform: Platform
  expectedPlatformAccountExternalId: string
  expiresAt: string
}

export type NativeControlState = 'waiting' | 'ready' | 'blocked'

export interface NativeControlStateUpdate {
  accountId: string
  state: NativeControlState
  message: string | null
  expiresAt: string | null
}

export interface NativeTranslationBatchInput {
  texts: string[]
  targetLang: string
  sourceLang?: string
}

export interface NativeTranslationBatchResult {
  translated: string
  detectedLang: string
  provider: string
  failed: boolean
}
