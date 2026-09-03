import { sql, type Kysely, type Selectable } from 'kysely'
import {
  CUSTOMER_PROFILE_FIELDS,
  CUSTOMER_PROFILE_SEARCH_DEFAULT_LIMIT,
  emptyCustomerProfile,
  type CustomerProfile,
  type CustomerProfileField,
  type CustomerProfileListItem,
  type CustomerProfileListPage,
  type CustomerProfileSearchRequest,
  type CustomerProfileUpdate,
} from '@im-hub/shared'
import type { CustomerProfilesTable, Database } from '../db/types.js'
import type { ScopeFilter } from '@im-hub/shared'
import { applyAccountScope } from '../rbac/apply.js'
import {
  customerProfileFilterFingerprint,
  decodeCustomerProfileCursor,
  encodeCustomerProfileCursor,
  escapeCustomerProfileLikeLiteral,
} from './library-query.js'

export type SaveCustomerProfileResult =
  | { kind: 'not_found' }
  | { kind: 'conflict'; currentRevision: number }
  | { kind: 'saved'; profile: CustomerProfile }

type CustomerProfileRow = Selectable<CustomerProfilesTable>

const preciseUtcTimestamp = sql<string>`
  to_char(
    statement_timestamp() at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  )
`

function preciseUtcTimestampFor(reference: string) {
  return sql<string>`
    to_char(
      ${sql.ref(reference)} at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  `
}

function timestampParameter(value: string) {
  return sql<Date>`cast(${value} as timestamptz)`
}

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

  async list(request: CustomerProfileSearchRequest): Promise<CustomerProfileListPage> {
    const q = request.q?.trim() || null
    const platform = request.platform ?? null
    const accountId = request.accountId ?? null
    const limit = request.limit ?? CUSTOMER_PROFILE_SEARCH_DEFAULT_LIMIT
    const fingerprint = customerProfileFilterFingerprint({ q, platform, accountId })
    const cursor = request.cursor
      ? decodeCustomerProfileCursor(request.cursor, fingerprint)
      : null
    const snapshotAt = cursor?.snapshotAt ?? (await this.db
      .selectNoFrom(preciseUtcTimestamp.as('snapshot_at'))
      .executeTakeFirstOrThrow()).snapshot_at

    let query = applyAccountScope(
      this.db.selectFrom('accounts')
        .innerJoin('conversations', 'conversations.account_id', 'accounts.id')
        .innerJoin(
          'customer_profiles',
          'customer_profiles.conversation_id',
          'conversations.id',
        ),
      this.scope,
    )
      .where(({ eb, or }) => or([
        eb('customer_profiles.name', 'is not', null),
        eb('customer_profiles.age_location', 'is not', null),
        eb('customer_profiles.occupation', 'is not', null),
        eb('customer_profiles.family', 'is not', null),
        eb('customer_profiles.interests', 'is not', null),
        eb('customer_profiles.other', 'is not', null),
      ]))
      .where('customer_profiles.updated_at', '<=', timestampParameter(snapshotAt))

    if (platform) query = query.where('accounts.platform', '=', platform)
    if (accountId) query = query.where('accounts.id', '=', accountId)

    if (q) {
      const pattern = `%${escapeCustomerProfileLikeLiteral(q)}%`
      query = query.where(({ or }) => or([
        sql<boolean>`${sql.ref('customer_profiles.name')} ilike ${pattern} escape '\\'`,
        sql<boolean>`${sql.ref('customer_profiles.age_location')} ilike ${pattern} escape '\\'`,
        sql<boolean>`${sql.ref('customer_profiles.occupation')} ilike ${pattern} escape '\\'`,
        sql<boolean>`${sql.ref('customer_profiles.family')} ilike ${pattern} escape '\\'`,
        sql<boolean>`${sql.ref('customer_profiles.interests')} ilike ${pattern} escape '\\'`,
        sql<boolean>`${sql.ref('customer_profiles.other')} ilike ${pattern} escape '\\'`,
        sql<boolean>`${sql.ref('conversations.contact_display_name')} ilike ${pattern} escape '\\'`,
        sql<boolean>`${sql.ref('accounts.display_name')} ilike ${pattern} escape '\\'`,
      ]))
    }

    if (cursor) {
      query = query.where(({ and, eb, or }) => or([
        eb('customer_profiles.updated_at', '<', timestampParameter(cursor.updatedAt)),
        and([
          eb('customer_profiles.updated_at', '=', timestampParameter(cursor.updatedAt)),
          eb('conversations.id', '<', cursor.conversationId),
        ]),
      ]))
    }

    const rows = await query
      .select([
        'accounts.id as account_id',
        'accounts.platform',
        'accounts.display_name as account_display_name',
        'conversations.id as conversation_id',
        'conversations.contact_display_name as conversation_display_name',
        'customer_profiles.name',
        'customer_profiles.age_location',
        'customer_profiles.occupation',
        'customer_profiles.family',
        'customer_profiles.interests',
        'customer_profiles.other',
        'customer_profiles.revision',
        'customer_profiles.updated_at',
        preciseUtcTimestampFor('customer_profiles.updated_at').as('updated_at_cursor'),
      ])
      .orderBy('customer_profiles.updated_at', 'desc')
      .orderBy('conversations.id', 'desc')
      .limit(limit + 1)
      .execute()

    const retainedRows = rows.slice(0, limit)
    const items: CustomerProfileListItem[] = retainedRows.map(row => ({
      conversationId: row.conversation_id,
      accountId: row.account_id,
      platform: row.platform,
      accountDisplayName: row.account_display_name,
      conversationDisplayName: row.conversation_display_name,
      profile: {
        conversationId: row.conversation_id,
        name: row.name,
        ageLocation: row.age_location,
        occupation: row.occupation,
        family: row.family,
        interests: row.interests,
        other: row.other,
        revision: row.revision,
        updatedAt: timestampToIso(row.updated_at),
      },
    }))
    const lastRow = retainedRows.at(-1)
    const nextCursor = rows.length > limit && lastRow
      ? encodeCustomerProfileCursor({
        snapshotAt,
        updatedAt: lastRow.updated_at_cursor,
        conversationId: lastRow.conversation_id,
        fingerprint,
      })
      : null

    return { items, nextCursor }
  }

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
