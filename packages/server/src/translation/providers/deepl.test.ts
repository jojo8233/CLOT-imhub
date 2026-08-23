import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeeplProvider } from './deepl.js'
import { ProviderFailedError } from '../types.js'

afterEach(() => vi.restoreAllMocks())

function mockFetch(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  )
}

describe('DeeplProvider', () => {
  it('返回译文与识别出的源语言', async () => {
    mockFetch(200, { translations: [{ detected_source_language: 'ZH', text: 'Hello' }] })
    const p = new DeeplProvider('fake-key')
    expect(await p.translate('你好', 'auto', 'EN')).toEqual({ text: 'Hello', detectedLang: 'ZH' })
  })

  it('auto 时不发送 source_lang 参数', async () => {
    const spy = mockFetch(200, { translations: [{ detected_source_language: 'ZH', text: 'Hi' }] })
    await new DeeplProvider('fake-key').translate('你好', 'auto', 'EN')
    const body = String((spy.mock.calls[0]![1] as RequestInit).body)
    expect(body).not.toContain('source_lang')
  })

  it('指定源语言时发送 source_lang', async () => {
    const spy = mockFetch(200, { translations: [{ detected_source_language: 'ZH', text: 'Hi' }] })
    await new DeeplProvider('fake-key').translate('你好', 'zh', 'EN')
    expect(String((spy.mock.calls[0]![1] as RequestInit).body)).toContain('source_lang=ZH')
  })

  it('HTTP 错误抛 ProviderFailedError', async () => {
    mockFetch(456, { message: 'quota exceeded' })
    await expect(new DeeplProvider('fake-key').translate('你好', 'auto', 'EN'))
      .rejects.toBeInstanceOf(ProviderFailedError)
  })

  it('返回空译文列表时抛 ProviderFailedError', async () => {
    mockFetch(200, { translations: [] })
    await expect(new DeeplProvider('fake-key').translate('你好', 'auto', 'EN'))
      .rejects.toBeInstanceOf(ProviderFailedError)
  })
})
