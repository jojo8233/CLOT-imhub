import type { TranslationPreference, TranslationProviderName } from '@im-hub/shared'
import { describe, expect, it, vi } from 'vitest'
import {
  translatePreviewForProvider,
  translationProviderNotice,
} from './Composer.js'

describe('Composer per-translation provider', () => {
  it('只在实际降级时显示简短提示', () => {
    expect(translationProviderNotice({
      requestedProvider: 'claude',
      provider: 'deepl',
      downgraded: true,
    })).toBe('Claude 暂时不可用，本次已由 DeepL 完成')

    expect(translationProviderNotice({
      requestedProvider: 'deepl',
      provider: 'deepl',
      downgraded: false,
    })).toBeNull()
  })

  it('本次选择 OpenAI 会传入请求，但不会改写员工保存的默认值', async () => {
    const preference: TranslationPreference = {
      companyDefault: 'deepl',
      userDefault: 'claude',
      providers: [
        { provider: 'deepl', available: true },
        { provider: 'claude', available: true },
        { provider: 'openai', available: true },
      ],
    }
    const translatePreview = vi.fn(async (
      _conversationId: string,
      _text: string,
      _provider?: TranslationProviderName,
    ) => ({
      translated: 'hello',
      backTranslated: '你好',
      targetLang: 'en',
      requestedProvider: 'openai' as const,
      provider: 'openai' as const,
      downgraded: false,
    }))

    await translatePreviewForProvider(
      { translatePreview },
      'conversation-1',
      '你好',
      'openai',
    )

    expect(translatePreview).toHaveBeenCalledWith('conversation-1', '你好', 'openai')
    expect(preference.userDefault).toBe('claude')
  })
})
