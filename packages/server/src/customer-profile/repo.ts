import type { Kysely, Selectable } from 'kysely'
import {
  CUSTOMER_PROFILE_FIELDS,
  emptyCustomerProfile,
  type CustomerProfile,
  type CustomerProfileField,
  type CustomerProfileUpdate,
} from '@im-hub/shared'
import type { CustomerProfilesTable, Database } from '../db/types.js'
import type { ScopeFilter } from '@im-hub/shared'
import { applyAccountScope } from '../rbac/apply.js'

export type SaveCustomerProfileResult =
  | { kind: 'not_found' }
  | { kind: 'conflict'; currentRevision: number }
  | { kind: 'saved'; profile: CustomerProfile }

type CustomerProfileRow = Selectable<CustomerProfilesTable>

function timestampToIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString()
}

function rowToProfile(row: CustomerProfileRow): CustomerProfile {
  return {
    conversationId: row.conversation_id,
    name: row.name,
    ageLocation: row.age_location,
    occupation: row.occupation,
    family: row.family,
    interests: row.interests,
    other: row.other,
    revision: row.revision,
    updatedAt: timestampToIso(row.updated_at),
  }
}

function valuesFromRow(row: CustomerProfileRow | undefined): Record<CustomerProfileField, string | null> {
  if (!row) {
    return {
      name: null,
      ageLocation: null,
      occupation: null,
      family: null,
      interests: null,
      other: null,
    }
  }
  return {
    name: row.name,
    ageLocation: row.age_location,
    occupation: row.occupation,
    family: row.family,
    interests: row.interests,
    other: row.other,
  }
}

export class ScopedCustomerProfileRepo {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly scope: ScopeFilter,
  ) {}

  async get(conversationId: string): Promise<CustomerProfile | null> {
    const visible = await applyAccountScope(
      this.db.selectFrom('accounts')
        .innerJoin('conversations', 'conversations.account_id', 'accounts.id'),
      this.scope,
    )
      .select('conversations.id as conversation_id')
      .where('conversations.id', '=', conversationId)
      .executeTakeFirst()
    if (!visible) return null

    const row = await this.db.selectFrom('customer_profiles')
      .selectAll()
      .where('conversation_id', '=', visible.conversation_id)
      .executeTakeFirst()
    return row ? rowToProfile(row) : emptyCustomerProfile(visible.conversation_id)
  }

  async save(
    conversationId: string,
    actorUserId: string,
    update: CustomerProfileUpdate,
  ): Promise<SaveCustomerProfileResult> {
    return this.db.transaction().execute(async (trx) => {
      const visible = await applyAccountScope(
        trx.selectFrom('accounts')
          .innerJoin('conversations', 'conversations.account_id', 'accounts.id'),
        this.scope,
      )
        .select('conversations.id as conversation_id')
        .where('conversations.id', '=', conversationId)
        .forUpdate('conversations')
        .executeTakeFirst()
      if (!visible) return { kind: 'not_found' }

      const current = await trx.selectFrom('customer_profiles')
        .selectAll()
        .where('conversation_id', '=', visible.conversation_id)
        .executeTakeFirst()
      const currentRevision = current?.revision ?? 0
      if (update.expectedRevision !== currentRevision) {
        return { kind: 'conflict', currentRevision }
      }

      const currentValues = valuesFromRow(current)
      const hasChanges = CUSTOMER_PROFILE_FIELDS.some(
        field => currentValues[field] !== update[field],
      )
      if (!hasChanges) {
        return {
          kind: 'saved',
          profile: current ? rowToProfile(current) : emptyCustomerProfile(conversationId),
        }
      }

      const values = {
        name: update.name,
        age_location: update.ageLocation,
        occupation: update.occupation,
        family: update.family,
        interests: update.interests,
        other: update.other,
        revision: currentRevision + 1,
        updated_by_user_id: actorUserId,
      }
      const saved = current
        ? await trx.updateTable('customer_profiles')
          .set({ ...values, updated_at: new Date() })
          .where('conversation_id', '=', visible.conversation_id)
          .returningAll()
          .executeTakeFirstOrThrow()
        : await trx.insertInto('customer_profiles')
          .values({ conversation_id: visible.conversation_id, ...values })
          .returningAll()
          .executeTakeFirstOrThrow()

      return { kind: 'saved', profile: rowToProfile(saved) }
    })
  }
}
