import { describe, expect, it } from 'vitest'
import { TranslationGateway } from '../gateway.js'
import { createConfiguredTranslationProviders } from './index.js'

describe('createConfiguredTranslationProviders', () => {
  it('omits only providers whose credential is blank', () => {
    const providers = createConfiguredTranslationProviders({
      DEEPL_API_KEY: 'synthetic-deepl-credential',
      DEEPL_ENDPOINT: 'https://example.test/deepl',
      OPENAI_API_KEY: '   ',
      ANTHROPIC_API_KEY: 'synthetic-anthropic-credential',
    })
    const gateway = new TranslationGateway(
      providers,
      { get: async () => null, set: async () => undefined } as never,
      ['deepl', 'claude', 'openai'],
    )

    expect(gateway.availableProviders()).toEqual(['deepl', 'claude'])
    expect(JSON.stringify(gateway.availableProviders())).not.toContain('credential')
  })

  it('leaves the gateway explicitly unavailable when every credential is blank', async () => {
    const gateway = new TranslationGateway(
      createConfiguredTranslationProviders({
        DEEPL_API_KEY: '',
        DEEPL_ENDPOINT: 'https://example.test/deepl',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      }),
      { get: async () => null, set: async () => undefined } as never,
      ['deepl', 'claude', 'openai'],
    )

    expect(gateway.availableProviders()).toEqual([])
    await expect(gateway.translate({
      text: 'synthetic', from: 'auto', to: 'zh', config: { global: 'deepl' },
    })).rejects.toThrow('all translation providers failed')
  })
})
