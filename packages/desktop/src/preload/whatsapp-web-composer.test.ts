import { describe, expect, it, vi } from 'vitest'
import { replaceWhatsAppComposerText } from './whatsapp-web-composer.js'

describe('WhatsApp Web composer writer', () => {
  it('只执行一次正文插入，让浏览器产生唯一一组原生编辑事件', () => {
    let visibleDraft = '旧草稿'
    const insertText = vi.fn((text: string) => {
      visibleDraft = text
      return true
    })

    expect(replaceWhatsAppComposerText({
      focus: vi.fn(),
      selectContents: vi.fn(() => { visibleDraft = '' }),
      insertText,
      readText: () => visibleDraft,
    }, 'translated text')).toBe(true)

    expect(insertText).toHaveBeenCalledTimes(1)
    expect(insertText).toHaveBeenCalledWith('translated text')
    expect(visibleDraft).toBe('translated text')
  })

  it('在浏览器没有返回 inserted 标记时按实际可见草稿确认', () => {
    let visibleDraft = ''

    expect(replaceWhatsAppComposerText({
      focus: vi.fn(),
      selectContents: vi.fn(),
      insertText: vi.fn((text: string) => {
        visibleDraft = `  ${text}\u00a0 `
        return false
      }),
      readText: () => visibleDraft.replace(/\u00a0/g, ' ').trim(),
    }, 'translated text')).toBe(true)
  })
})
