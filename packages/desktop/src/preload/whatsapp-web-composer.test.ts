import { describe, expect, it, vi } from 'vitest'
import {
  replaceWhatsAppComposerText,
  waitForWhatsAppComposerFocus,
} from './whatsapp-web-composer.js'

describe('WhatsApp Web composer writer', () => {
  it('即使 composer DOM 已聚焦也先等待 Lexical 完成一轮焦点处理', async () => {
    const order: string[] = []

    await expect(waitForWhatsAppComposerFocus({
      focus: () => { order.push('focus') },
      hasFocus: () => {
        order.push('has-focus')
        return true
      },
    }, async () => { order.push('settle') })).resolves.toBe(true)

    expect(order).toEqual(['focus', 'has-focus', 'settle', 'has-focus'])
  })

  it('activeElement 在稳定周期内丢失时拒绝后续编辑', async () => {
    let focused = true

    await expect(waitForWhatsAppComposerFocus({
      focus: vi.fn(),
      hasFocus: () => focused,
    }, async () => { focused = false })).resolves.toBe(false)
  })

  it('等待延迟到达的 composer DOM 焦点后再留一轮稳定周期', async () => {
    let checks = 0
    const pause = vi.fn(async () => {})

    await expect(waitForWhatsAppComposerFocus({
      focus: vi.fn(),
      hasFocus: () => {
        checks += 1
        return checks >= 2
      },
    }, pause)).resolves.toBe(true)

    expect(pause).toHaveBeenCalledTimes(2)
  })

  it('只执行一次正文插入，让浏览器产生唯一一组原生编辑事件', () => {
    let visibleDraft = '旧草稿'
    const insertText = vi.fn((text: string) => {
      visibleDraft = text
      return true
    })

    expect(replaceWhatsAppComposerText({
      focus: vi.fn(() => true),
      selectContents: vi.fn(() => {
        visibleDraft = ''
        return true
      }),
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
      focus: vi.fn(() => true),
      selectContents: vi.fn(() => true),
      insertText: vi.fn((text: string) => {
        visibleDraft = `  ${text}\u00a0 `
        return false
      }),
      readText: () => visibleDraft.replace(/\u00a0/g, ' ').trim(),
    }, 'translated text')).toBe(true)
  })

  it('原生编辑器没有确认全选时拒绝插入正文', () => {
    const insertText = vi.fn(() => true)

    expect(replaceWhatsAppComposerText({
      focus: vi.fn(() => true),
      selectContents: vi.fn(() => false),
      insertText,
      readText: () => 'existing draft',
    }, 'translated text')).toBe(false)

    expect(insertText).not.toHaveBeenCalled()
  })

  it('composer 没有成为 activeElement 时不全选也不插入', () => {
    const selectContents = vi.fn(() => true)
    const insertText = vi.fn(() => true)

    expect(replaceWhatsAppComposerText({
      focus: vi.fn(() => false),
      selectContents,
      insertText,
      readText: () => 'existing draft',
    }, 'translated text')).toBe(false)

    expect(selectContents).not.toHaveBeenCalled()
    expect(insertText).not.toHaveBeenCalled()
  })
})
