import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from '../db/types.js'
import { testDatabaseUrl } from '../db/test-db.js'
import { KyselyWhatsAppCloudRepo, WHATSAPP_ACCESS_TOKEN_PURPOSE } from './repo.js'
import { SecretCipher } from './secret-cipher.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})
const repo = new KyselyWhatsAppCloudRepo(db)
const cipher = new SecretCipher(randomBytes(32))

let userId: string
let accountId: string
let conversationId: string

beforeEach(async () => {
  await db.deleteFrom('accounts').execute()
  await db.deleteFrom('users').execute()
  userId = (await db.insertInto('users').values({
    email: `cloud-repo-${randomUUID()}@example.test`,
    display_name: 'Cloud owner', role: 'owner', password_hash: 'x',
  }).returning('id').executeTakeFirstOrThrow()).id
  accountId = randomUUID()
  const secretId = randomUUID()
  await repo.createAccount({
    accountId,
    secretId,
    ownerUserId: userId,
    teamId: null,
    displayName: 'Cloud account',
    wabaId: '100001',
    phoneNumberId: '200001',
    graphApiVersion: 'v25.0',
    encryptedToken: cipher.encrypt(accountId, WHATSAPP_ACCESS_TOKEN_PURPOSE, 'opaque-token'),
    linkedAt: new Date('2026-08-31T00:00:00Z'),
  })
  conversationId = (await db.insertInto('conversations').values({
    account_id: accountId,
    platform_conversation_id: 'u:customer',
    contact_external_id: 'customer',
    contact_display_name: 'Customer',
  }).returning('id').executeTakeFirstOrThrow()).id
})

afterAll(async () => db.destroy())

describe('KyselyWhatsAppCloudRepo', () => {
  it('账号只保存 secret reference，token 密文可按账号 AAD 解密', async () => {
    const account = await db.selectFrom('accounts')
      .select(['connection_mode', 'status', 'credentials_ref'])
      .where('id', '=', accountId)
      .executeTakeFirstOrThrow()
    expect(account).toMatchObject({ connection_mode: 'cloud_api', status: 'connected' })
    expect(account.credentials_ref).toMatch(/^db-secret:/)

    const loaded = await repo.findByWebhookIdentity('100001', '200001')
    expect(loaded?.accountId).toBe(accountId)
    expect(cipher.decrypt(
      accountId,
      WHATSAPP_ACCESS_TOKEN_PURPOSE,
      loaded?.encryptedToken ?? { ciphertext: '', iv: '', authTag: '' },
    )).toBe('opaque-token')
    expect(loaded?.encryptedToken.ciphertext).not.toContain('opaque-token')
  })

  it('同一 attempt 只建一次，最终 wamid、出站消息和 accepted 状态原子落库', async () => {
    const attemptId = randomUUID()
    const attempt = {
      attemptId,
      accountId,
      conversationId,
      actorUserId: userId,
      targetExternalId: 'customer',
      bodySha256: 'a'.repeat(64),
      authorizationRevision: 1,
    }
    expect((await repo.startAttempt(attempt)).created).toBe(true)
    expect((await repo.startAttempt(attempt)).created).toBe(false)

    const stored = await repo.completeAccepted({
      attemptId,
      accountId,
      conversationId,
      platformMessageId: 'wamid.final-test',
      senderExternalId: '200001',
      targetExternalId: 'customer',
      body: 'sent body',
      sentAt: new Date('2026-08-31T00:01:00Z'),
    })
    const message = await db.selectFrom('messages')
      .select(['id', 'platform_message_id', 'direction'])
      .where('id', '=', stored.messageId)
      .executeTakeFirstOrThrow()
    expect(message).toEqual({
      id: stored.messageId, platform_message_id: 'wamid.final-test', direction: 'out',
    })
    const finalAttempt = await db.selectFrom('whatsapp_send_attempts')
      .select(['state', 'platform_message_id'])
      .where('attempt_id', '=', attemptId)
      .executeTakeFirstOrThrow()
    expect(finalAttempt).toEqual({ state: 'accepted', platform_message_id: 'wamid.final-test' })
  })

  it('乱序状态不倒退，同时间戳只允许 sent → delivered → read 前进', async () => {
    const at = new Date('2026-08-31T00:02:00Z')
    expect(await repo.saveStatus({
      accountId, platformMessageId: 'wamid.status-test', status: 'delivered',
      statusAt: at, errorCode: null,
    })).toBe(true)
    expect(await repo.saveStatus({
      accountId, platformMessageId: 'wamid.status-test', status: 'sent',
      statusAt: at, errorCode: null,
    })).toBe(false)
    expect(await repo.saveStatus({
      accountId, platformMessageId: 'wamid.status-test', status: 'read',
      statusAt: at, errorCode: null,
    })).toBe(true)
    const row = await db.selectFrom('whatsapp_message_statuses')
      .select('status')
      .where('account_id', '=', accountId)
      .where('platform_message_id', '=', 'wamid.status-test')
      .executeTakeFirstOrThrow()
    expect(row.status).toBe('read')
  })

  it('Embedded Signup ticket 只能在有效期内 claim 一次', async () => {
    const id = randomUUID()
    await repo.createOnboardingSession({
      id,
      ownerUserId: userId,
      teamId: null,
      displayName: 'Cloud account 2',
      ticketSha256: 'b'.repeat(64),
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    })
    const claimed = await repo.claimOnboardingSession('b'.repeat(64), new Date('2026-08-31T00:00:00Z'))
    expect(claimed).toMatchObject({ id, ownerUserId: userId, state: 'processing' })
    expect(await repo.claimOnboardingSession('b'.repeat(64), new Date('2026-08-31T00:00:01Z')))
      .toBeNull()
  })
})
