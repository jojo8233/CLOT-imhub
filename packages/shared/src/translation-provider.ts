export const TRANSLATION_PROVIDERS = ['deepl', 'claude', 'openai'] as const

export type TranslationProviderName = (typeof TRANSLATION_PROVIDERS)[number]

export interface TranslationProviderAvailability {
  provider: TranslationProviderName
  available: boolean
}

export interface TranslationPreference {
  companyDefault: TranslationProviderName
  userDefault: TranslationProviderName
  providers: TranslationProviderAvailability[]
}

export interface TranslationResultMeta {
  requestedProvider: TranslationProviderName
  provider: TranslationProviderName
  downgraded: boolean
}
