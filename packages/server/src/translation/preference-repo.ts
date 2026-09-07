import type { TranslationProviderName } from '@im-hub/shared'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types.js'

export interface TranslationPreferenceRepo {
  get(userId: string): Promise<TranslationProviderName>
  set(userId: string, provider: TranslationProviderName): Promise<void>
}

export class KyselyTranslationPreferenceRepo implements TranslationPreferenceRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async get(userId: string): Promise<TranslationProviderName> {
    const row = await this.db.selectFrom('users')
      .select('preferred_translation_provider')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow()
    return row.preferred_translation_provider
  }

  async set(userId: string, provider: TranslationProviderName): Promise<void> {
    await this.db.updateTable('users')
      .set({ preferred_translation_provider: provider })
      .where('id', '=', userId)
      .execute()
  }
}
