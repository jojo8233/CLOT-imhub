import type {
  TranslationProviderName,
  TranslationResultMeta,
} from '@im-hub/shared'

const PROVIDER_LABEL: Record<TranslationProviderName, string> = {
  deepl: 'DeepL',
  claude: 'Claude',
  openai: 'OpenAI',
}

export function translationProviderLabel(provider: TranslationProviderName): string {
  return PROVIDER_LABEL[provider]
}

export function translationProviderNotice(meta: TranslationResultMeta): string | null {
  if (!meta.downgraded) return null
  return `${translationProviderLabel(meta.requestedProvider)} 暂时不可用，本次已由 ${translationProviderLabel(meta.provider)} 完成`
}
