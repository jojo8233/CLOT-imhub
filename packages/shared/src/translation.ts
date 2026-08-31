/** 规范翻译引擎返回的语言代码；`und` 表示未知，不是一种可用语言。 */
export function normalizeTranslationLanguage(
  sourceLang: string | null | undefined,
): string | null {
  const normalized = sourceLang?.trim().toLowerCase().replaceAll('_', '-') ?? ''
  return normalized && normalized !== 'und' ? normalized : null
}

/** 客服工作台固定提供中英双语对照：中文译英文，其他语言译中文。 */
export function bilingualTranslationTarget(
  sourceLang: string | null | undefined,
): 'en' | 'zh' {
  const normalized = normalizeTranslationLanguage(sourceLang)
  return normalized === 'zh' || normalized?.startsWith('zh-') ? 'en' : 'zh'
}
