import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  TRANSLATION_PROVIDERS,
  type NativeTranslationBatchInput,
  type TranslationProviderName,
} from './index.js'

describe('translation provider contract', () => {
  it('keeps the production provider order stable', () => {
    expect(TRANSLATION_PROVIDERS).toEqual(['deepl', 'claude', 'openai'])
  })

  it('allows a typed one-request native override', () => {
    const input: NativeTranslationBatchInput = {
      texts: ['synthetic'],
      targetLang: 'zh',
      provider: 'claude',
    }
    expectTypeOf(input.provider).toEqualTypeOf<TranslationProviderName | undefined>()
  })
})
