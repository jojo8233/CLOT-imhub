import type { TranslationProviderName } from '@im-hub/shared'
import { describe, expect, it } from 'vitest'
import {
  TranslationPreferenceService,
  type TranslationPreferenceRepo,
} from './preference-service.js'

class MemoryPreferenceRepo implements TranslationPreferenceRepo {
  constructor(private value: TranslationProviderName) {}

  async get(_userId: string): Promise<TranslationProviderName> {
    return this.value
  }

  async set(_userId: string, provider: TranslationProviderName): Promise<void> {
    this.value = provider
  }
}

describe('TranslationPreferenceService', () => {
  it('resolves explicit override before saved and company defaults', async () => {
    const service = new TranslationPreferenceService(
      new MemoryPreferenceRepo('claude'),
      ['deepl', 'claude', 'openai'],
      'deepl',
    )

    await expect(service.resolve('user-1', 'openai')).resolves.toBe('openai')
    await expect(service.resolve('user-1')).resolves.toBe('claude')
  })

  it('falls back when a saved provider is unavailable without changing storage', async () => {
    const repo = new MemoryPreferenceRepo('claude')
    const service = new TranslationPreferenceService(repo, ['deepl', 'openai'], 'deepl')

    await expect(service.resolve('user-1')).resolves.toBe('deepl')
    await expect(repo.get('user-1')).resolves.toBe('claude')
  })

  it('reports stable availability and persists the caller default', async () => {
    const repo = new MemoryPreferenceRepo('deepl')
    const service = new TranslationPreferenceService(repo, ['deepl', 'claude'], 'deepl')

    await expect(service.set('user-1', 'claude')).resolves.toEqual({
      companyDefault: 'deepl',
      userDefault: 'claude',
      providers: [
        { provider: 'deepl', available: true },
        { provider: 'claude', available: true },
        { provider: 'openai', available: false },
      ],
    })
  })
})
