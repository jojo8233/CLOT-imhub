import type { TranslationProviderName } from '@im-hub/shared'

export type ProviderName = TranslationProviderName

export interface TranslationOutput {
  text: string
  detectedLang: string
}

export interface TranslationProvider {
  readonly name: ProviderName
  translate(text: string, from: string, to: string): Promise<TranslationOutput>
}

export class ProviderFailedError extends Error {
  constructor(readonly provider: ProviderName, reason: unknown) {
    super(`translation provider ${provider} failed`, { cause: reason })
  }
}
