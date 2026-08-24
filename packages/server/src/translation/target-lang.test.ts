import { describe, expect, it } from 'vitest'
import { FALLBACK_TARGET_LANG, resolveTargetLang } from './target-lang.js'

describe('resolveTargetLang', () => {
  it('锁定优先于检测到的客户语言', () => {
    const lang = resolveTargetLang({ lockedLang: 'en', latestInboundLang: 'ja' })
    expect(lang).toBe('en')
  })

  it('没有锁定时用客户最近一条消息的检测语言', () => {
    const lang = resolveTargetLang({ lockedLang: null, latestInboundLang: 'ja' })
    expect(lang).toBe('ja')
  })

  it("'und' 视为未知，跳过并落到兜底", () => {
    const lang = resolveTargetLang({ lockedLang: null, latestInboundLang: 'und' })
    expect(lang).toBe(FALLBACK_TARGET_LANG)
  })

  it('锁定和检测都没有时落到兜底', () => {
    const lang = resolveTargetLang({ lockedLang: null, latestInboundLang: null })
    expect(lang).toBe(FALLBACK_TARGET_LANG)
  })

  it('锁定为空字符串时不算锁定，继续看检测语言', () => {
    const lang = resolveTargetLang({ lockedLang: '', latestInboundLang: 'ja' })
    expect(lang).toBe('ja')
  })

  it('锁定为空字符串且没有检测语言时落到兜底', () => {
    const lang = resolveTargetLang({ lockedLang: '', latestInboundLang: null })
    expect(lang).toBe(FALLBACK_TARGET_LANG)
  })
})
