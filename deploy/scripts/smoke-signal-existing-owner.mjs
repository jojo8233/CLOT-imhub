// Throwaway verification against a dedicated synthetic container database only.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

assert.equal(process.env.DATABASE_URL,
  'postgresql://postgres:synthetic-owner-probe-password@imhub-owner-pg-20260914-jbrjoa:5432/imhub_owner_probe')
const { db } = await import('/app/packages/server/src/db/client.ts')
const { signSession } = await import('/app/packages/server/src/auth/session.ts')
const ids = [randomUUID(), randomUUID()]
const identity = '11111111-2222-4333-8444-555555555555'
const endpoint = 'http://127.0.0.1:4000/api/accounts/signal-native/resolve-existing'
try {
  await db.insertInto('users').values(ids.map((id, index) => ({
    id, email: `probe-${id}@example.test`, display_name: 'Synthetic owner probe',
    role: index === 0 ? 'agent' : 'auditor', password_hash: 'synthetic-unusable',
  }))).execute()
  const token = await signSession({ userId: ids[0], sessionVersion: 1 },
    'signal-owner-container-synthetic-secret-20260914')
  const accountIds = [randomUUID(), randomUUID(), randomUUID()]
  await db.insertInto('accounts').values(accountIds.slice(0, 2).map((id, index) => ({
    id, owner_user_id: ids[0], display_name: 'Synthetic Signal', platform: 'signal',
    connection_mode: 'native_desktop', status: 'pending_auth',
    platform_account_external_id: index === 0 ? identity : null,
  }))).execute()
  const snapshot = () => db.selectFrom('accounts').selectAll()
    .where('owner_user_id', '=', ids[0]).orderBy('id').execute()
  const before = await snapshot()
  const request = async (authorization, body) => {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { authorization } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    })
    assert.equal(response.headers.get('cache-control'), 'no-store')
    return { status: response.status, body: await response.json() }
  }
  const found = await request(`Bearer ${token}`, { platformAccountExternalId: identity })
  assert.equal(found.status, 200)
  assert.deepEqual(found.body, { accountId: accountIds[0] })
  assert.equal((await request(`Bearer ${token}`, {
    platformAccountExternalId: '66666666-2222-4333-8444-555555555555',
  })).status, 404)
  assert.equal((await request(null, { platformAccountExternalId: identity })).status, 401)
  const auditorToken = await signSession({ userId: ids[1], sessionVersion: 1 },
    'signal-owner-container-synthetic-secret-20260914')
  assert.equal((await request(`Bearer ${auditorToken}`, { platformAccountExternalId: identity })).status, 403)
  assert.deepEqual(await snapshot(), before)
  await db.insertInto('accounts').values({ id: accountIds[2], owner_user_id: ids[0],
    display_name: 'Synthetic duplicate', platform: 'signal', connection_mode: 'native_desktop',
    status: 'pending_auth', platform_account_external_id: identity,
  }).execute()
  const ambiguousBefore = await snapshot()
  assert.equal((await request(`Bearer ${token}`, { platformAccountExternalId: identity })).status, 409)
  assert.deepEqual(await snapshot(), ambiguousBefore)
  console.log('PACKED_HTTP_OWNER_MATCH_PASSED; NO_BINDING_WRITES; AUTH_AND_AMBIGUITY_PASSED; SYNTHETIC_ONLY')
} finally {
  await db.deleteFrom('accounts').where('owner_user_id', 'in', ids).execute()
  await db.deleteFrom('users').where('id', 'in', ids).execute()
  await db.destroy()
}
