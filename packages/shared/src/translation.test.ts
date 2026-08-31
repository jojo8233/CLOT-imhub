import { describe, expect, it } from 'vitest'
import { bilingualTranslationTarget, normalizeTranslationLanguage } from './translation.js'

describe('translation language policy', () => {
  it('规范语言代码并把未知语言收敛为 null', () => {
    expect(normalizeTranslationLanguage(' ZH_CN ')).toBe('zh-cn')
    expect(normalizeTranslationLanguage('und')).toBeNull()
    expect(normalizeTranslationLanguage('  ')).toBeNull()
    expect(normalizeTranslationLanguage(null)).toBeNull()
  })

  it('中文译英文，其他及未知语言译中文', () => {
    expect(bilingualTranslationTarget('zh')).toBe('en')
    expect(bilingualTranslationTarget('ZH-CN')).toBe('en')
    expect(bilingualTranslationTarget('ja')).toBe('zh')
    expect(bilingualTranslationTarget(undefined)).toBe('zh')
  })
})
