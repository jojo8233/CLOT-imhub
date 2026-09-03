import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import type { Role } from '@im-hub/shared'
import type { Database } from '../db/types.js'
import { testDatabaseUrl } from '../db/test-db.js'
import { CustomerProfileCursorError } from './library-query.js'
import { ScopedCustomerProfileRepo } from './repo.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: testDatabaseUrl() }),
  }),
})

const primaryConversationId = '00000000-0000-4000-8000-000000000101'
const percentConversationId = '00000000-0000-4000-8000-000000000102'
const underscoreConversationId = '00000000-0000-4000-8000-000000000103'
const emptyConversationId = '00000000-0000-4000-8000-000000000104'
const missingProfileConversationId = '00000000-0000-4000-8000-000000000105'
const contactExternalToken = `external-contact-${randomUUID()}`
const conversationExternalToken = `external-conversation-${randomUUID()}`
const accountExternalToken = `external-account-${randomUUID()}`
const messageBodyOnlyToken = `message-body-${randomUUID()}`

let ownerRepo: ScopedCustomerProfileRepo
let auditorRepo: ScopedCustomerProfileRepo
let leadManagerRepo: ScopedCustomerProfileRepo
let unrelatedManagerRepo: ScopedCustomerProfileRepo
let firstAgentRepo: ScopedCustomerProfileRepo
let secondAccountId: string

async function createUser(role: Role, label: string): Promise<string> {
  return (await db.insertInto('users').values({
    email: `${label}-${randomUUID()}@example.test`,
    display_name: `Synthetic ${label}`,
    role,
    password_hash: 'x',
  }).returning('id').executeTakeFirstOrThrow()).id
}

beforeEach(async () => {
  await db.deleteFrom('message_translations').execute()
  await db.deleteFrom('message_reactions').execute()
  await db.deleteFrom('message_id_aliases').execute()
  await db.deleteFrom('messages').execute()
  await db.deleteFrom('customer_profiles').execute()
  await db.deleteFrom('conversations').execute()
  await db.deleteFrom('accounts').execute()
  await db.deleteFrom('team_members').execute()
  await db.deleteFrom('teams').execute()
  await db.deleteFrom('users').execute()

  const firstTeamId = (await db.insertInto('teams').values({
    name: `Profile team one ${randomUUID()}`,
  }).returning('id').executeTakeFirstOrThrow()).id
  const secondTeamId = (await db.insertInto('teams').values({
    name: `Profile team two ${randomUUID()}`,
  }).returning('id').executeTakeFirstOrThrow()).id
  const unrelatedTeamId = (await db.insertInto('teams').values({
    name: `Profile unrelated team ${randomUUID()}`,
  }).returning('id').executeTakeFirstOrThrow()).id

  const ownerId = await createUser('owner', 'owner')
  const auditorId = await createUser('auditor', 'auditor')
  const firstAgentId = await createUser('agent', 'agent-one')
  const secondAgentId = await createUser('agent', 'agent-two')
  const thirdAgentId = await createUser('agent', 'agent-three')

  const firstAccountId = (await db.insertInto('accounts').values({
    platform: 'telegram',
    owner_user_id: firstAgentId,
    team_id: firstTeamId,
    display_name: 'Visible AccountMarker',
    status: 'connected',
    platform_account_external_id: accountExternalToken,
  }).returning('id').executeTakeFirstOrThrow()).id
  secondAccountId = (await db.insertInto('accounts').values({
    platform: 'telegram',
    owner_user_id: secondAgentId,
    team_id: secondTeamId,
    display_name: 'Synthetic second account',
    status: 'connected',
  }).returning('id').executeTakeFirstOrThrow()).id
  const thirdAccountId = (await db.insertInto('accounts').values({
    platform: 'whatsapp',
    owner_user_id: thirdAgentId,
    team_id: null,
    display_name: 'Synthetic third account',
    status: 'connected',
  }).returning('id').executeTakeFirstOrThrow()).id

  await db.insertInto('conversations').values([
    {
      id: primaryConversationId,
      account_id: firstAccountId,
      platform_conversation_id: conversationExternalToken,
      contact_external_id: contactExternalToken,
      contact_display_name: 'Visible ConversationMarker',
    },
    {
      id: percentConversationId,
      account_id: secondAccountId,
      platform_conversation_id: `percent-conversation-${randomUUID()}`,
      contact_external_id: `percent-contact-${randomUUID()}`,
      contact_display_name: 'Synthetic percent customer',
    },
    {
      id: underscoreConversationId,
      account_id: thirdAccountId,
      platform_conversation_id: `underscore-conversation-${randomUUID()}`,
      contact_external_id: `underscore-contact-${randomUUID()}`,
      contact_display_name: 'Synthetic underscore customer',
    },
    {
      id: emptyConversationId,
      account_id: firstAccountId,
      platform_conversation_id: `empty-conversation-${randomUUID()}`,
      contact_external_id: `empty-contact-${randomUUID()}`,
      contact_display_name: 'Empty profile conversation',
    },
    {
      id: missingProfileConversationId,
      account_id: firstAccountId,
      platform_conversation_id: `missing-conversation-${randomUUID()}`,
      contact_external_id: `missing-contact-${randomUUID()}`,
      contact_display_name: 'Missing profile conversation',
    },
  ]).execute()

  const sharedTimestamp = new Date('2026-09-02T00:00:00.000Z')
  await db.insertInto('customer_profiles').values([
    {
      conversation_id: primaryConversationId,
      name: 'ProfileNameMarker',
      age_location: 'LocationMarker',
      occupation: 'OccupationMarker',
      family: 'FamilyMarker',
      interests: 'InterestMarker',
      other: 'OtherMarker',
      revision: 1,
      updated_by_user_id: firstAgentId,
      created_at: sharedTimestamp,
      updated_at: sharedTimestamp,
    },
    {
      conversation_id: percentConversationId,
      name: 'Percent customer',
      age_location: null,
      occupation: null,
      family: null,
      interests: null,
      other: 'Discount 50% and Path\\Literal',
      revision: 1,
      updated_by_user_id: secondAgentId,
      created_at: sharedTimestamp,
      updated_at: sharedTimestamp,
    },
    {
      conversation_id: underscoreConversationId,
      name: 'Underscore customer',
      age_location: null,
      occupation: null,
      family: null,
      interests: null,
      other: 'Under_score literal',
      revision: 1,
      updated_by_user_id: thirdAgentId,
      created_at: new Date('2026-09-01T00:00:00.000Z'),
      updated_at: new Date('2026-09-01T00:00:00.000Z'),
    },
    {
      conversation_id: emptyConversationId,
      name: null,
      age_location: null,
      occupation: null,
      family: null,
      interests: null,
      other: null,
      revision: 1,
      updated_by_user_id: firstAgentId,
      created_at: sharedTimestamp,
      updated_at: sharedTimestamp,
    },
  ]).execute()

  await db.insertInto('messages').values({
    conversation_id: primaryConversationId,
    account_id: firstAccountId,
    platform: 'telegram',
    platform_message_id: `profile-library-message-${randomUUID()}`,
    direction: 'in',
    sender_external_id: contactExternalToken,
    body: messageBodyOnlyToken,
    sent_at: sharedTimestamp,
    media_refs: JSON.stringify([]),
    raw: JSON.stringify({}),
  }).execute()

  ownerRepo = new ScopedCustomerProfileRepo(db, { kind: 'all' })
  auditorRepo = new ScopedCustomerProfileRepo(db, { kind: 'all' })
  leadManagerRepo = new ScopedCustomerProfileRepo(db, {
    kind: 'teams',
    teamIds: [firstTeamId],
  })
  unrelatedManagerRepo = new ScopedCustomerProfileRepo(db, {
    kind: 'teams',
    teamIds: [unrelatedTeamId],
  })
  firstAgentRepo = new ScopedCustomerProfileRepo(db, {
    kind: 'self',
    userId: firstAgentId,
  })

  expect(ownerId).not.toBe(auditorId)
})

afterAll(async () => db.destroy())

describe('ScopedCustomerProfileRepo.list', () => {
  it('applies owner, auditor, team, and self account scopes before returning profiles', async () => {
    await expect(ownerRepo.list({})).resolves.toMatchObject({ items: expect.any(Array) })
    await expect(auditorRepo.list({})).resolves.toMatchObject({ items: expect.any(Array) })

    const ownerPage = await ownerRepo.list({})
    const auditorPage = await auditorRepo.list({})
    const leadManagerPage = await leadManagerRepo.list({})
    const unrelatedManagerPage = await unrelatedManagerRepo.list({})
    const firstAgentPage = await firstAgentRepo.list({})

    expect(ownerPage.items).toHaveLength(3)
    expect(auditorPage.items).toHaveLength(3)
    expect(leadManagerPage.items.map(item => item.conversationId)).toEqual([primaryConversationId])
    expect(unrelatedManagerPage.items).toEqual([])
    expect(firstAgentPage.items.map(item => item.conversationId)).toEqual([primaryConversationId])
  })

  it.each([
    'profilenameMarker',
    'locationmarker',
    'occupationmarker',
    'familymarker',
    'interestmarker',
    'othermarker',
    'visible conversationmarker',
    'visible accountmarker',
  ])('searches the approved profile and display fields case-insensitively: %s', async (q) => {
    const page = await ownerRepo.list({ q })

    expect(page.items.map(item => item.conversationId)).toEqual([primaryConversationId])
  })

  it('does not search or return platform identifiers or message bodies', async () => {
    for (const q of [
      contactExternalToken,
      conversationExternalToken,
      accountExternalToken,
      messageBodyOnlyToken,
    ]) {
      await expect(ownerRepo.list({ q })).resolves.toEqual({ items: [], nextCursor: null })
    }

    const [item] = (await ownerRepo.list({ q: 'ProfileNameMarker' })).items
    expect(Object.keys(item ?? {}).sort()).toEqual([
      'accountDisplayName',
      'accountId',
      'conversationDisplayName',
      'conversationId',
      'platform',
      'profile',
    ])
    expect(Object.keys(item?.profile ?? {}).sort()).toEqual([
      'ageLocation',
      'conversationId',
      'family',
      'interests',
      'name',
      'occupation',
      'other',
      'revision',
      'updatedAt',
    ])
  })

  it.each([
    ['%', percentConversationId],
    ['_', underscoreConversationId],
    ['\\', percentConversationId],
  ])('treats SQL LIKE metacharacter %s as a literal', async (q, expectedConversationId) => {
    const page = await ownerRepo.list({ q })

    expect(page.items.map(item => item.conversationId)).toEqual([expectedConversationId])
  })

  it('combines platform and account filters with the caller scope', async () => {
    await expect(ownerRepo.list({ platform: 'whatsapp' })).resolves.toMatchObject({
      items: [{ conversationId: underscoreConversationId }],
    })
    await expect(ownerRepo.list({ accountId: secondAccountId })).resolves.toMatchObject({
      items: [{ conversationId: percentConversationId }],
    })
    await expect(firstAgentRepo.list({ accountId: secondAccountId })).resolves.toEqual({
      items: [],
      nextCursor: null,
    })
  })

  it('excludes blank or missing profiles and paginates equal timestamps by conversation id', async () => {
    const firstPage = await ownerRepo.list({ limit: 1 })
    expect(firstPage.items.map(item => item.conversationId)).toEqual([percentConversationId])
    expect(firstPage.nextCursor).not.toBeNull()

    const secondPage = await ownerRepo.list({ limit: 1, cursor: firstPage.nextCursor ?? undefined })
    expect(secondPage.items.map(item => item.conversationId)).toEqual([primaryConversationId])
    expect(secondPage.nextCursor).not.toBeNull()

    const thirdPage = await ownerRepo.list({ limit: 1, cursor: secondPage.nextCursor ?? undefined })
    expect(thirdPage.items.map(item => item.conversationId)).toEqual([underscoreConversationId])
    expect(thirdPage.nextCursor).toBeNull()

    expect([
      ...firstPage.items,
      ...secondPage.items,
      ...thirdPage.items,
    ].map(item => item.conversationId)).not.toContain(emptyConversationId)
    expect([
      ...firstPage.items,
      ...secondPage.items,
      ...thirdPage.items,
    ].map(item => item.conversationId)).not.toContain(missingProfileConversationId)
  })

  it('paginates profiles whose timestamps differ only below JavaScript millisecond precision', async () => {
    await db.updateTable('customer_profiles')
      .set({
        updated_at: sql<Date>`${'2026-09-02T00:00:00.123456Z'}::timestamptz`,
      })
      .where('conversation_id', '=', percentConversationId)
      .execute()
    await db.updateTable('customer_profiles')
      .set({
        updated_at: sql<Date>`${'2026-09-02T00:00:00.123123Z'}::timestamptz`,
      })
      .where('conversation_id', '=', primaryConversationId)
      .execute()

    const firstPage = await ownerRepo.list({ platform: 'telegram', limit: 1 })
    const secondPage = await ownerRepo.list({
      platform: 'telegram',
      limit: 1,
      cursor: firstPage.nextCursor ?? undefined,
    })

    expect(firstPage.items.map(item => item.conversationId)).toEqual([percentConversationId])
    expect(secondPage.items.map(item => item.conversationId)).toEqual([primaryConversationId])
    expect(secondPage.nextCursor).toBeNull()
  })

  it('rejects a cursor when the search filters change', async () => {
    const firstPage = await ownerRepo.list({ limit: 1 })

    await expect(ownerRepo.list({ q: 'ProfileNameMarker', cursor: firstPage.nextCursor ?? undefined }))
      .rejects.toBeInstanceOf(CustomerProfileCursorError)
  })

  it('keeps later pages inside the first-page snapshot', async () => {
    const firstPage = await ownerRepo.list({ platform: 'telegram', limit: 1 })
    expect(firstPage.items.map(item => item.conversationId)).toEqual([percentConversationId])

    await db.updateTable('customer_profiles')
      .set({ updated_at: new Date(Date.now() + 60_000) })
      .where('conversation_id', '=', primaryConversationId)
      .execute()

    await expect(ownerRepo.list({
      platform: 'telegram',
      limit: 1,
      cursor: firstPage.nextCursor ?? undefined,
    })).resolves.toEqual({ items: [], nextCursor: null })
  })
})
