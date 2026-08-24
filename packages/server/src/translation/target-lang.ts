/** 客户语言未知时的兜底。改这个值等于改变所有新会话的默认行为。 */
export const FALLBACK_TARGET_LANG = 'en'

export interface TargetLangSource {
  lockedLang: string | null
  latestInboundLang: string | null
}

/**
 * 决定回复该用什么语言。
 *
 * 优先级：员工锁定 > 客户最近一条消息的语言 > 兜底。
 * 'und' 视为未知——那是模型没能识别时的占位值，不是一种语言。
 * 空字符串也不算锁定——它不是任何一种真实语言代码，按"没锁定"处理。
 */
export function resolveTargetLang(src: TargetLangSource): string {
  if (src.lockedLang) return src.lockedLang
  if (src.latestInboundLang && src.latestInboundLang !== 'und') return src.latestInboundLang
  return FALLBACK_TARGET_LANG
}
