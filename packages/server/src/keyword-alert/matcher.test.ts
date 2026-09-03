import { describe, expect, it } from 'vitest'
import {
  AhoCorasickKeywordMatcher,
  KeywordPatternError,
  keywordAlertExcerpt,
  normalizeKeywordPattern,
  normalizeKeywordText,
} from './matcher.js'

describe('keyword pattern normalization', () => {
  it('修剪、NFKC 归一化并以不依赖 locale 的方式转小写', () => {
    expect(normalizeKeywordPattern('  ＲＥＦＵＮＤ  ')).toBe('refund')
    expect(normalizeKeywordText('Ｆｕｌｌｗｉｄｔｈ ＦＦＩ: ﬃ')).toBe('fullwidth ffi: ffi')
  })

  it('拒绝原始值中即使可被修剪的控制字符', () => {
    expect(() => normalizeKeywordPattern('line\nbreak')).toThrow(KeywordPatternError)
    expect(() => normalizeKeywordPattern('\ntrimmed control')).toThrow(KeywordPatternError)
  })

  it('在 NFKC 归一化后以 code point 限制模式长度', () => {
    expect(() => normalizeKeywordPattern('x'.repeat(101))).toThrow(KeywordPatternError)
    expect(() => normalizeKeywordPattern('\ufb03'.repeat(34))).toThrow(KeywordPatternError)
    expect(normalizeKeywordPattern('😀'.repeat(100))).toBe('😀'.repeat(100))
    expect(() => normalizeKeywordPattern('😀'.repeat(101))).toThrow(KeywordPatternError)
  })
})

describe('AhoCorasickKeywordMatcher', () => {
  it('返回构造顺序中的重叠规则，并使用归一化正文匹配', () => {
    const matcher = new AhoCorasickKeywordMatcher([
      { id: 'r1', normalizedPattern: 'refund' },
      { id: 'r2', normalizedPattern: 'fund' },
      { id: 'r3', normalizedPattern: '退款' },
    ])

    expect(matcher.matchRuleIds('REFUND refund 退款')).toEqual(['r1', 'r2', 'r3'])
    expect(matcher.matchRuleIds('no match')).toEqual([])
  })

  it('按规则构造顺序返回命中，而非按正文中首次命中的位置', () => {
    const matcher = new AhoCorasickKeywordMatcher([
      { id: 'later-rule', normalizedPattern: 'later' },
      { id: 'earlier-rule', normalizedPattern: 'earlier' },
      { id: 'overlap', normalizedPattern: 'ear' },
    ])

    expect(matcher.matchRuleIds('earlier later')).toEqual([
      'later-rule',
      'earlier-rule',
      'overlap',
    ])
  })

  it('同一规则多次出现时只返回一次 ID', () => {
    const matcher = new AhoCorasickKeywordMatcher([
      { id: 'r1', normalizedPattern: 'refund' },
      { id: 'r2', normalizedPattern: 'fund' },
    ])

    expect(matcher.matchRuleIds('refund refund refund')).toEqual(['r1', 'r2'])
  })

  it('空规则集不命中任何规则', () => {
    const matcher = new AhoCorasickKeywordMatcher([])

    expect(matcher.matchRuleIds('refund')).toEqual([])
  })
})

describe('keywordAlertExcerpt', () => {
  it('正文短于窗口时返回完整当前正文', () => {
    expect(keywordAlertExcerpt('short current body', 'current', false)).toBe('short current body')
  })

  it('删除的消息不返回摘录', () => {
    expect(keywordAlertExcerpt('body hidden after deletion', 'hidden', true)).toBeNull()
  })

  it('围绕命中位置截取最多 160 个 code point 的当前正文', () => {
    const excerpt = keywordAlertExcerpt('前'.repeat(200) + '命中词' + '后'.repeat(200), '命中词', false)

    expect(Array.from(excerpt ?? '')).toHaveLength(160)
    expect(excerpt).toContain('命中词')
  })

  it('将 NFKC 和大小写归一化的命中映射回当前原文', () => {
    expect(keywordAlertExcerpt('前'.repeat(200) + 'ＲＥＦＵＮＤ' + '后'.repeat(200), 'refund', false))
      .toContain('ＲＥＦＵＮＤ')
  })

  it('无关位置跨字符 NFKC 归一化时仍围绕远处命中截取当前原文', () => {
    const currentBody = 'e\u0301' + '前'.repeat(200) + 'ＲＥＦＵＮＤ' + '后'.repeat(200)

    expect(keywordAlertExcerpt(currentBody, 'refund', false))
      .toBe('前'.repeat(77) + 'ＲＥＦＵＮＤ' + '后'.repeat(77))
  })

  it('编辑后当前正文不再含旧字面量时只回退到当前正文前缀', () => {
    expect(keywordAlertExcerpt('edited body without old literal', 'old literal', false))
      .toBe('edited body without old literal')
  })
})
