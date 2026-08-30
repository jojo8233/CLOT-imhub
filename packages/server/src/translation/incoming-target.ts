/**
 * 客服工作台固定提供中英双语对照：检测为中文时译成英文，否则译成中文。
 * 不能按“是否含汉字”猜测，否则带汉字的日文也会被错误地改译成英文。
 */
export function incomingTranslationTarget(sourceLang: string | null): 'en' | 'zh' {
  const normalized = sourceLang?.trim().toLowerCase().replace('_', '-') ?? ''
  return normalized === 'zh' || normalized.startsWith('zh-') ? 'en' : 'zh'
}
