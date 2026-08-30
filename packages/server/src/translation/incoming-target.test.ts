import { describe, expect, it } from 'vitest'
import { incomingTranslationTarget } from './incoming-target.js'

describe('incomingTranslationTarget', () => {
  it('中文正文译成英文', () => {
    expect(incomingTranslationTarget('ZH')).toBe('en')
    expect(incomingTranslationTarget('zh-CN')).toBe('en')
  })

  it('英文正文译成中文', () => {
    expect(incomingTranslationTarget('en')).toBe('zh')
  })

  it('未知语言和带汉字的日文都保持译成中文', () => {
    expect(incomingTranslationTarget(null)).toBe('zh')
    expect(incomingTranslationTarget('ja')).toBe('zh')
  })
})
