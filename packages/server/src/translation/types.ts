export const PROVIDER_NAMES = ['deepl', 'openai', 'claude'] as const
export type ProviderName = (typeof PROVIDER_NAMES)[number]

export interface TranslationOutput {
  text: string
  detectedLang: string
}

export interface TranslationProvider {
  readonly name: ProviderName
  translate(text: string, from: string, to: string): Promise<TranslationOutput>
}

export class ProviderFailedError extends Error {
  constructor(readonly provider: ProviderName, readonly reason: unknown) {
    super(`translation provider ${provider} failed`)
  }
}
