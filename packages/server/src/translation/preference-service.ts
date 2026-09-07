import {
  TRANSLATION_PROVIDERS,
  type TranslationPreference,
  type TranslationProviderName,
} from '@im-hub/shared'
import type { TranslationPreferenceRepo } from './preference-repo.js'

export type { TranslationPreferenceRepo } from './preference-repo.js'

export class TranslationPreferenceService {
  private readonly available: ReadonlySet<TranslationProviderName>

  constructor(
    private readonly repo: TranslationPreferenceRepo,
    available: readonly TranslationProviderName[],
    private readonly companyDefault: TranslationProviderName,
  ) {
    this.available = new Set(available)
  }

  async get(userId: string): Promise<TranslationPreference> {
    return this.preference(await this.repo.get(userId))
  }

  async set(
    userId: string,
    provider: TranslationProviderName,
  ): Promise<TranslationPreference> {
    await this.repo.set(userId, provider)
    return this.get(userId)
  }

  async resolve(
    userId: string,
    override?: TranslationProviderName,
  ): Promise<TranslationProviderName> {
    if (override && this.available.has(override)) return override
    const saved = await this.repo.get(userId)
    return this.available.has(saved) ? saved : this.companyDefault
  }

  private preference(userDefault: TranslationProviderName): TranslationPreference {
    return {
      companyDefault: this.companyDefault,
      userDefault,
      providers: TRANSLATION_PROVIDERS.map(provider => ({
        provider,
        available: this.available.has(provider),
      })),
    }
  }
}
