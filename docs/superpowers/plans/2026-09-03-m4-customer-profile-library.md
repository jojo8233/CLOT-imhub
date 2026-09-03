# Searchable Customer Profile Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cancelled audit slice with an RBAC-scoped, searchable, directly editable customer profile library and remove the misleading translation-history entry without touching native platform behavior.

**Architecture:** Add shared search/page contracts, remove the obsolete audit schema and scope signal with a forward migration, and extend `ScopedCustomerProfileRepo` with a scope-first keyset query. Expose the query through a POST JSON search endpoint so sensitive search text never enters the URL, then add a reducer-backed desktop master/detail view that reuses the existing M4-1 profile editor.

**Tech Stack:** Node.js 22+, pnpm 10, TypeScript ESM, Fastify 5, Zod, Kysely/PostgreSQL, React 19, Zustand, Vitest, Electron 33/electron-vite.

**Spec:** `docs/superpowers/specs/2026-09-03-m4-customer-profile-library-design.md`

## Global Constraints

- Work only in the existing isolated worktree `/private/tmp/im-hub-m3-outbox` on branch `codex/m4-customer-profile-library`; do not create another worktree or modify the main checkout.
- Before implementation, read `AGENTS.md`, `docs/superpowers/specs/2026-08-25-native-client-pivot.md`, and the linked spec completely.
- Use Node.js 22+ and pnpm 10; do not create npm or yarn lockfiles.
- Keep strict TypeScript ESM conventions: relative source imports use `.js`, type-only imports use `import type`, and do not add `any`, `@ts-ignore`, or non-null assertions.
- Business reads must enter through `req.scoped`/`ScopedDb`; routes must not import the global `db`.
- `auditor` remains a globally visible but read-only compatibility role; owner is global read/write, manager is lead-team read/write, and agent is self-owned-account read/write.
- Search only the six customer-profile fields plus account and conversation display names. Never search or return message bodies, translations, external account/contact/conversation IDs, platform message IDs, or media references.
- Search text must travel in POST JSON, not URL query parameters, and must not be written to console, server logs, cursors, or user-visible errors.
- Do not read, print, or commit `.env`, platform profile/session data, database customer/message bodies, account identifiers, concrete message keys, media references, tokens, QR codes, or secrets.
- Do not modify Telegram, Signal, WhatsApp guest/preload code, translation coordinators, composers, send attempts, native message bridges, or platform message-ID algorithms.
- Do not perform real Telegram, Signal, or WhatsApp sends, and do not repeat already accepted platform translation/lifecycle matrices.
- Database tests use only the fixed isolated `_test` database. The approved forward migration permanently deletes existing `audit_logs`; do not rewrite migration `0013_customer_profiles.ts`.
- Keep PR #19 open and unmerged, and keep Issue #12 open.
- Every implementation task follows red-green TDD and ends in a focused commit.

---

## File Map

### Shared contracts

- Modify `packages/shared/src/customer-profile.ts`: search request, list item/page types, search limit constants.
- Modify `packages/shared/src/customer-profile.test.ts`: runtime contract constants and representative typed page fixture.
- `packages/shared/src/index.ts` already exports `customer-profile.ts`; verify no additional export is necessary.

### Audit removal and RBAC cleanup

- Create `packages/server/src/db/migrations/0014_customer_profile_library.ts`: drop `audit_logs`, add profile keyset index, development-only schema down path.
- Create `packages/server/src/db/migrations/0014_customer_profile_library.test.ts`: exercise up/down in a random isolated test schema.
- Modify `packages/server/src/db/types.ts`: remove `AuditLogsTable` and `Database.audit_logs`.
- Modify `packages/shared/src/rbac.ts`: remove `requiresAudit` from `ScopeFilter`.
- Modify `packages/server/src/rbac/scope.ts` and `scope.test.ts`: retain role visibility, remove audit signal and pending audit test.
- Modify `packages/server/src/rbac/scoped-db.ts`, `scoped-db.test.ts`, and `apply.test.ts`: construct simplified scopes and keep the scoped repository boundary.
- Modify `packages/server/src/customer-profile/repo.ts` and `repo.test.ts`: remove audit writes/results while preserving no-op, transaction, lock, and revision semantics.
- Modify `packages/server/src/api/routes/customer-profile.test.ts`: remove audit assertions and preserve API/RBAC/concurrency assertions.

### Search domain and server API

- Create `packages/server/src/customer-profile/library-query.ts`: literal LIKE escaping, normalized filter fingerprint, versioned cursor codec and cursor error.
- Create `packages/server/src/customer-profile/library-query.test.ts`: pure cursor/escaping tests.
- Modify `packages/server/src/customer-profile/repo.ts`: add scope-first `list()`.
- Create `packages/server/src/customer-profile/library-repo.test.ts`: database search, RBAC, non-searchable fields, ordering and paging.
- Create `packages/server/src/api/routes/customer-profiles.ts`: strict POST body parsing and safe error mapping.
- Create `packages/server/src/api/routes/customer-profiles.test.ts`: authenticated search API matrix.
- Modify `packages/server/src/api/server.ts`: register the route.
- Modify `packages/desktop/src/renderer/api/client.ts` and `client.test.ts`: typed cancellable POST search call.

### Desktop state and UI

- Create `packages/desktop/src/renderer/customer-profile-library.ts`: pure reducer, deduplication and selected-item consistency.
- Create `packages/desktop/src/renderer/customer-profile-library.test.ts`: stale request, replace/append, selection and save-refresh state tests.
- Create `packages/desktop/src/renderer/components/CustomerProfileLibraryView.tsx`: debounced filters, request cancellation, master/detail rendering and retry flows.
- Create `packages/desktop/src/renderer/components/CustomerProfileLibraryView.test.tsx`: pure content rendering for ready/empty/error/loading-more states.
- Modify `packages/desktop/src/renderer/components/CustomerProfileSection.tsx` and its test: optional successful-save callback.
- Modify `packages/desktop/src/renderer/components/FunctionCenter.tsx`; create `FunctionCenter.test.tsx`: wire profile library and remove translation history.
- Modify `packages/desktop/src/renderer/App.tsx`: render chat, accounts and customer profile library as distinct views.

### Documentation and release evidence

- Modify current product/spec/feature docs and `docs/RUNBOOK.md` listed in Task 8.
- Update the M4-2 spec with an implementation checkpoint only after verification passes.
- If a real UI package is required, generate `/private/tmp/Signal-imhub-integrated-a55.app` from official Signal Desktop and the opaque a54 profile source, then perform only profile-library acceptance.

---

### Task 1: Add the Shared Customer Profile Library Contract

**Files:**

- Modify: `packages/shared/src/customer-profile.ts`
- Modify: `packages/shared/src/customer-profile.test.ts`
- Verify: `packages/shared/src/index.ts`

**Interfaces:**

- Consumes: existing `Platform`, `CustomerProfile`, and `CustomerProfileValues`.
- Produces: `CUSTOMER_PROFILE_SEARCH_DEFAULT_LIMIT`, `CUSTOMER_PROFILE_SEARCH_MAX_LIMIT`, `CustomerProfileSearchRequest`, `CustomerProfileListItem`, and `CustomerProfileListPage`.

- [ ] **Step 1: Write the failing shared-contract test**

Add these imports and assertions to `packages/shared/src/customer-profile.test.ts`:

```ts
import {
  CUSTOMER_PROFILE_SEARCH_DEFAULT_LIMIT,
  CUSTOMER_PROFILE_SEARCH_MAX_LIMIT,
  type CustomerProfileListPage,
  type CustomerProfileSearchRequest,
} from './customer-profile.js'

it('固定档案库搜索上限和跨端分页形状', () => {
  expect(CUSTOMER_PROFILE_SEARCH_DEFAULT_LIMIT).toBe(50)
  expect(CUSTOMER_PROFILE_SEARCH_MAX_LIMIT).toBe(100)

  const request: CustomerProfileSearchRequest = {
    q: 'Synthetic query',
    platform: 'telegram',
    accountId: '00000000-0000-4000-8000-000000000001',
    limit: 50,
  }
  const page: CustomerProfileListPage = {
    items: [],
    nextCursor: null,
  }
  expect(request.limit).toBe(50)
  expect(page).toEqual({ items: [], nextCursor: null })
})
```

- [ ] **Step 2: Run the test and typecheck to verify RED**

Run:

```bash
pnpm exec vitest run packages/shared/src/customer-profile.test.ts
pnpm --filter @im-hub/shared exec tsc --noEmit
```

Expected: the test module or TypeScript compile fails because the new constants and types are not exported.

- [ ] **Step 3: Add the minimal shared contract**

At the top of `customer-profile.ts`, import `Platform` as a type, then add:

```ts
import type { Platform } from './platform.js'

export const CUSTOMER_PROFILE_SEARCH_DEFAULT_LIMIT = 50
export const CUSTOMER_PROFILE_SEARCH_MAX_LIMIT = 100

export interface CustomerProfileSearchRequest {
  q?: string
  platform?: Platform
  accountId?: string
  limit?: number
  cursor?: string
}

export interface CustomerProfileListItem {
  conversationId: string
  accountId: string
  platform: Platform
  accountDisplayName: string
  conversationDisplayName: string | null
  profile: CustomerProfile
}

export interface CustomerProfileListPage {
  items: CustomerProfileListItem[]
  nextCursor: string | null
}
```

Keep the existing `export * from './customer-profile.js'` in `packages/shared/src/index.ts`; do not duplicate it.

- [ ] **Step 4: Run focused verification**

Run:

```bash
pnpm exec vitest run packages/shared/src/customer-profile.test.ts
pnpm --filter @im-hub/shared exec tsc --noEmit
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit the shared contract**

```bash
git add packages/shared/src/customer-profile.ts packages/shared/src/customer-profile.test.ts
git commit -m "feat(shared): add customer profile library contract"
```

---

### Task 2: Remove the Audit Data Path Without Weakening Profile Consistency

**Files:**

- Create: `packages/server/src/db/migrations/0014_customer_profile_library.ts`
- Create: `packages/server/src/db/migrations/0014_customer_profile_library.test.ts`
- Modify: `packages/server/src/db/types.ts`
- Modify: `packages/shared/src/rbac.ts`
- Modify: `packages/server/src/rbac/scope.ts`
- Modify: `packages/server/src/rbac/scope.test.ts`
- Modify: `packages/server/src/rbac/scoped-db.ts`
- Modify: `packages/server/src/rbac/scoped-db.test.ts`
- Modify: `packages/server/src/rbac/apply.test.ts`
- Modify: `packages/server/src/customer-profile/repo.ts`
- Modify: `packages/server/src/customer-profile/repo.test.ts`
- Modify: `packages/server/src/api/routes/customer-profile.test.ts`

**Interfaces:**

- Consumes: existing `CustomerProfileUpdate`, `ScopeFilter`, M4-1 transaction and optimistic-lock behavior.
- Produces: simplified `ScopeFilter`, audit-free `SaveCustomerProfileResult`, and migration `0014_customer_profile_library`.

- [ ] **Step 1: Rewrite the behavior tests first**

Change `scope.test.ts` expectations to the audit-free shapes and delete the pending audit test:

```ts
expect(resolveScope({ ...base, role: 'owner' })).toEqual({ kind: 'all' })
expect(resolveScope({ ...base, role: 'auditor' })).toEqual({ kind: 'all' })
expect(resolveScope({ ...base, role: 'manager', leadTeamIds: ['t1', 't2'] }))
  .toEqual({ kind: 'teams', teamIds: ['t1', 't2'] })
expect(resolveScope({ ...base, role: 'agent', userId: 'u9' }))
  .toEqual({ kind: 'self', userId: 'u9' })
```

In `repo.test.ts`, remove all direct `audit_logs` cleanup/assertions and require exact audit-free save results:

```ts
expect(await saveSyntheticProfile(ownerRepo, conversationId, ownerId, 0)).toEqual({
  kind: 'saved',
  profile: expect.objectContaining({ revision: 1 }),
})

const second = await saveSyntheticProfile(ownerRepo, conversationId, ownerId, 1)
expect(second).toEqual({
  kind: 'saved',
  profile: expect.objectContaining({ revision: 1 }),
})
```

Retain and rename tests for stale revision, simultaneous revision-0 creation, unknown actor rollback, invisible conversation, and conversation cascade deletion. In `customer-profile.test.ts`, remove audit table assertions while retaining the exact RBAC and `409` response checks.

Create `0014_customer_profile_library.test.ts` before the migration exists. Use the same fixed `_test` connection pattern as adjacent database tests, create a unique schema, and keep every DDL operation inside that schema:

```ts
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import type { Database } from '../types.js'
import { testDatabaseUrl } from '../test-db.js'
import { down, up } from './0014_customer_profile_library.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})

afterAll(async () => db.destroy())

describe('0014_customer_profile_library', () => {
  it('drops audit logs, adds the paging index, and has a schema-only down path', async () => {
    const schema = `m4_library_${randomUUID().replaceAll('-', '')}`
    await sql`create schema ${sql.id(schema)}`.execute(db)
    const isolated = db.withSchema(schema)
    try {
      await isolated.schema.createTable('users')
        .addColumn('id', 'uuid', column => column.primaryKey()).execute()
      await isolated.schema.createTable('accounts')
        .addColumn('id', 'uuid', column => column.primaryKey()).execute()
      await isolated.schema.createTable('conversations')
        .addColumn('id', 'uuid', column => column.primaryKey()).execute()
      await isolated.schema.createTable('customer_profiles')
        .addColumn('conversation_id', 'uuid', column => column.primaryKey())
        .addColumn('updated_at', 'timestamptz', column => column.notNull())
        .execute()
      await isolated.schema.createTable('audit_logs')
        .addColumn('id', 'uuid', column => column.primaryKey()).execute()

      await up(isolated)
      const afterUp = await sql<{ auditTable: string | null; profileIndex: string | null }>`
        select
          to_regclass(${`${schema}.audit_logs`})::text as "auditTable",
          to_regclass(${`${schema}.customer_profiles_updated_conversation_idx`})::text as "profileIndex"
      `.execute(db)
      expect(afterUp.rows[0]).toEqual({
        auditTable: null,
        profileIndex: `${schema}.customer_profiles_updated_conversation_idx`,
      })

      await down(isolated)
      const afterDown = await sql<{ auditTable: string | null; profileIndex: string | null }>`
        select
          to_regclass(${`${schema}.audit_logs`})::text as "auditTable",
          to_regclass(${`${schema}.customer_profiles_updated_conversation_idx`})::text as "profileIndex"
      `.execute(db)
      expect(afterDown.rows[0]).toEqual({ auditTable: `${schema}.audit_logs`, profileIndex: null })
    } finally {
      await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db)
    }
  })
})
```

- [ ] **Step 2: Run focused tests to verify RED**

Run:

```bash
pnpm exec vitest run packages/server/src/db/migrations/0014_customer_profile_library.test.ts packages/server/src/rbac/scope.test.ts packages/server/src/rbac/scoped-db.test.ts packages/server/src/customer-profile/repo.test.ts packages/server/src/api/routes/customer-profile.test.ts
```

Expected: scope shapes still contain `requiresAudit`, and save results still contain `changedFields`.

- [ ] **Step 3: Add the forward migration**

Create `0014_customer_profile_library.ts` with the full forward/down schema operations:

```ts
import { sql, type Kysely } from 'kysely'
import type { Database } from '../types.js'

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('audit_logs').ifExists().execute()
  await db.schema.createIndex('customer_profiles_updated_conversation_idx')
    .on('customer_profiles')
    .columns(['updated_at', 'conversation_id'])
    .execute()
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropIndex('customer_profiles_updated_conversation_idx').ifExists().execute()
  await db.schema.createTable('audit_logs')
    .addColumn('id', 'uuid', c => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('actor_user_id', 'uuid', c => c.references('users.id').onDelete('set null'))
    .addColumn('account_id', 'uuid', c => c.notNull().references('accounts.id').onDelete('cascade'))
    .addColumn('conversation_id', 'uuid', c => c.notNull()
      .references('conversations.id').onDelete('cascade'))
    .addColumn('action', 'text', c => c.notNull())
    .addColumn('changed_fields', 'jsonb', c => c.notNull())
    .addColumn('created_at', 'timestamptz', c => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('audit_logs_action_check', sql`action = 'customer_profile.updated'`)
    .addCheckConstraint(
      'audit_logs_changed_fields_check',
      sql`jsonb_typeof(changed_fields) = 'array' and jsonb_array_length(changed_fields) > 0`,
    )
    .execute()
  await db.schema.createIndex('audit_logs_account_created_idx')
    .on('audit_logs')
    .columns(['account_id', 'created_at'])
    .execute()
}
```

Do not edit migration `0013_customer_profiles.ts`. The `down()` path recreates only schema and cannot restore deleted rows.

- [ ] **Step 4: Remove audit types, signals, writes and result fields**

Change `ScopeFilter` to:

```ts
export type ScopeFilter =
  | { kind: 'all' }
  | { kind: 'teams'; teamIds: string[] }
  | { kind: 'self'; userId: string }
```

Change `resolveScope()` to return `{ kind: 'all' }`, `{ kind: 'teams', teamIds }`, or `{ kind: 'self', userId }` while preserving the exhaustive switch. Remove the audit comment from `ScopedDb`, but keep its readonly `scope` field and `customerProfiles()` factory.

Remove `AuditLogsTable` and `audit_logs` from `Database`. Change the saved result to:

```ts
export type SaveCustomerProfileResult =
  | { kind: 'not_found' }
  | { kind: 'conflict'; currentRevision: number }
  | { kind: 'saved'; profile: CustomerProfile }
```

In `save()`, keep the field comparison solely for no-op detection:

```ts
const hasChanges = CUSTOMER_PROFILE_FIELDS.some(
  field => currentValues[field] !== update[field],
)
if (!hasChanges) {
  return {
    kind: 'saved',
    profile: current ? rowToProfile(current) : emptyCustomerProfile(conversationId),
  }
}
```

Select only `conversations.id as conversation_id` in the locked visibility query, delete the `audit_logs` insert, and return `{ kind: 'saved', profile: rowToProfile(saved) }`. Keep `actorUserId` because `updated_by_user_id` still records the current editor and its foreign key still protects rollback behavior.

Update every source/test scope literal under `packages/` to the simplified union. Do not mass-rewrite historical plan documents in this task.

- [ ] **Step 5: Run the focused audit-removal tests and typecheck**

Run:

```bash
pnpm exec vitest run packages/server/src/db/migrations/0014_customer_profile_library.test.ts packages/server/src/rbac/scope.test.ts packages/server/src/rbac/scoped-db.test.ts packages/server/src/rbac/apply.test.ts packages/server/src/customer-profile/repo.test.ts packages/server/src/api/routes/customer-profile.test.ts
pnpm typecheck
```

Expected: all focused tests pass, no pending audit test remains, and typecheck exits 0.

- [ ] **Step 6: Apply the approved migration to the configured development database**

Run in an environment where `DATABASE_URL` is already set; do not source or print `.env`:

```bash
pnpm db:migrate
```

Expected: migration `0014_customer_profile_library` reports success. Do not query or print audit rows before deletion.

- [ ] **Step 7: Commit the audit removal**

```bash
git add packages/shared/src/rbac.ts packages/server/src/db/migrations/0014_customer_profile_library.ts packages/server/src/db/migrations/0014_customer_profile_library.test.ts packages/server/src/db/types.ts packages/server/src/rbac/scope.ts packages/server/src/rbac/scope.test.ts packages/server/src/rbac/scoped-db.ts packages/server/src/rbac/scoped-db.test.ts packages/server/src/rbac/apply.test.ts packages/server/src/customer-profile/repo.ts packages/server/src/customer-profile/repo.test.ts packages/server/src/api/routes/customer-profile.test.ts
git commit -m "refactor(server): remove cancelled audit data path"
```

---

### Task 3: Implement Scope-Safe Search and Cursor Pagination

**Files:**

- Create: `packages/server/src/customer-profile/library-query.ts`
- Create: `packages/server/src/customer-profile/library-query.test.ts`
- Modify: `packages/server/src/customer-profile/repo.ts`
- Create: `packages/server/src/customer-profile/library-repo.test.ts`

**Interfaces:**

- Consumes: `CustomerProfileSearchRequest`, `CustomerProfileListPage`, `ScopeFilter`, `applyAccountScope`.
- Produces: `CustomerProfileCursorError`, `escapeCustomerProfileLikeLiteral()`, `ScopedCustomerProfileRepo.list(request)`.

- [ ] **Step 1: Write failing pure cursor and escaping tests**

Create `library-query.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  CustomerProfileCursorError,
  decodeCustomerProfileCursor,
  encodeCustomerProfileCursor,
  escapeCustomerProfileLikeLiteral,
  customerProfileFilterFingerprint,
} from './library-query.js'

describe('customer profile library query helpers', () => {
  it('escapes LIKE metacharacters as literal text', () => {
    expect(escapeCustomerProfileLikeLiteral('50%_off\\code'))
      .toBe('50\\%\\_off\\\\code')
  })

  it('round-trips a versioned cursor without storing the raw query', () => {
    const fingerprint = customerProfileFilterFingerprint({
      q: 'Sensitive synthetic phrase', platform: 'telegram', accountId: null,
    })
    const cursor = encodeCustomerProfileCursor({
      snapshotAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      conversationId: '00000000-0000-4000-8000-000000000001',
      fingerprint,
    })
    expect(cursor).not.toContain('Sensitive')
    expect(decodeCustomerProfileCursor(cursor, fingerprint)).toMatchObject({
      updatedAt: '2026-09-02T00:00:00.000Z',
      conversationId: '00000000-0000-4000-8000-000000000001',
    })
  })

  it('rejects malformed and cross-filter cursors', () => {
    expect(() => decodeCustomerProfileCursor('bad', 'a'.repeat(64)))
      .toThrow(CustomerProfileCursorError)
    const cursor = encodeCustomerProfileCursor({
      snapshotAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      conversationId: '00000000-0000-4000-8000-000000000001',
      fingerprint: 'a'.repeat(64),
    })
    expect(() => decodeCustomerProfileCursor(cursor, 'b'.repeat(64)))
      .toThrow(CustomerProfileCursorError)
  })
})
```

- [ ] **Step 2: Run the helper tests to verify RED**

```bash
pnpm exec vitest run packages/server/src/customer-profile/library-query.test.ts
```

Expected: FAIL because `library-query.ts` does not exist.

- [ ] **Step 3: Implement the pure query helpers**

Create `library-query.ts` with a Zod-validated internal cursor and a SHA-256 filter fingerprint:

```ts
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Platform } from '@im-hub/shared'

const cursorSchema = z.object({
  v: z.literal(1),
  snapshotAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  conversationId: z.string().uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export interface CustomerProfileFilterIdentity {
  q: string | null
  platform: Platform | null
  accountId: string | null
}

export interface CustomerProfileCursorPosition {
  snapshotAt: string
  updatedAt: string
  conversationId: string
  fingerprint: string
}

export class CustomerProfileCursorError extends Error {
  constructor() {
    super('invalid customer profile cursor')
    this.name = 'CustomerProfileCursorError'
  }
}

export function escapeCustomerProfileLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`)
}

export function customerProfileFilterFingerprint(filters: CustomerProfileFilterIdentity): string {
  return createHash('sha256')
    .update(JSON.stringify([filters.q, filters.platform, filters.accountId]))
    .digest('hex')
}

export function encodeCustomerProfileCursor(position: CustomerProfileCursorPosition): string {
  return Buffer.from(JSON.stringify({ v: 1, ...position }), 'utf8').toString('base64url')
}

export function decodeCustomerProfileCursor(
  encoded: string,
  expectedFingerprint: string,
): CustomerProfileCursorPosition {
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')))
    if (parsed.fingerprint !== expectedFingerprint) throw new CustomerProfileCursorError()
    return {
      snapshotAt: parsed.snapshotAt,
      updatedAt: parsed.updatedAt,
      conversationId: parsed.conversationId,
      fingerprint: parsed.fingerprint,
    }
  } catch (error) {
    if (error instanceof CustomerProfileCursorError) throw error
    throw new CustomerProfileCursorError()
  }
}
```

- [ ] **Step 4: Run the helper tests to verify GREEN**

```bash
pnpm exec vitest run packages/server/src/customer-profile/library-query.test.ts
```

Expected: all helper tests pass.

- [ ] **Step 5: Write failing repository search tests**

Create `library-repo.test.ts` with synthetic owner, auditor, two agents, a lead manager, an unrelated manager, two teams, three accounts, conversations, profile rows, and one message whose body contains a query token not present in any profile/display name. The test database setup must use `testDatabaseUrl()` and only synthetic strings.

Add these discrete cases:

```ts
it('applies owner/auditor global, lead-manager team, and agent self scopes', async () => {
  expect((await ownerRepo.list({ limit: 50 })).items).toHaveLength(3)
  expect((await auditorRepo.list({ limit: 50 })).items).toHaveLength(3)
  expect((await leadManagerRepo.list({ limit: 50 })).items.map(item => item.accountId))
    .toEqual([teamAccountId])
  expect((await unrelatedManagerRepo.list({ limit: 50 })).items).toEqual([])
  expect((await agentRepo.list({ limit: 50 })).items.map(item => item.accountId))
    .toEqual([agentAccountId])
})

it('searches six profile fields and display names but not external ids or messages', async () => {
  for (const q of ['Synthetic Name', 'Phnom Penh', 'Designer', 'Family Note', 'Cycling', 'Other Note', 'Visible Conversation', 'Visible Account']) {
    expect((await ownerRepo.list({ q, limit: 50 })).items).toHaveLength(1)
  }
  expect((await ownerRepo.list({ q: externalContactToken, limit: 50 })).items).toEqual([])
  expect((await ownerRepo.list({ q: externalConversationToken, limit: 50 })).items).toEqual([])
  expect((await ownerRepo.list({ q: messageBodyOnlyToken, limit: 50 })).items).toEqual([])
})

it('treats percent and underscore as literal characters', async () => {
  expect((await ownerRepo.list({ q: '%', limit: 50 })).items.map(item => item.conversationId))
    .toEqual([percentConversationId])
  expect((await ownerRepo.list({ q: '_', limit: 50 })).items.map(item => item.conversationId))
    .toEqual([underscoreConversationId])
})

it('filters platform/account, excludes all-empty profiles, and paginates equal timestamps', async () => {
  const first = await ownerRepo.list({ platform: 'telegram', limit: 1 })
  expect(first.items).toHaveLength(1)
  expect(first.nextCursor).toEqual(expect.any(String))
  const second = await ownerRepo.list({ platform: 'telegram', limit: 1, cursor: first.nextCursor ?? undefined })
  expect(second.items).toHaveLength(1)
  expect(new Set([...first.items, ...second.items].map(item => item.conversationId)).size).toBe(2)
  expect(second.items.every(item => item.platform === 'telegram')).toBe(true)
})
```

Assert every returned object with `Object.keys()` or `toEqual()` so no external ID or message field can leak into the result.

- [ ] **Step 6: Run repository tests to verify RED**

```bash
pnpm exec vitest run packages/server/src/customer-profile/library-repo.test.ts
```

Expected: FAIL because `ScopedCustomerProfileRepo.list()` does not exist.

- [ ] **Step 7: Implement normalized list input and the scoped query**

Add this method contract to `ScopedCustomerProfileRepo`:

```ts
async list(request: CustomerProfileSearchRequest): Promise<CustomerProfileListPage>
```

Normalize inside the method:

```ts
const q = request.q?.trim() || null
const platform = request.platform ?? null
const accountId = request.accountId ?? null
const limit = request.limit ?? CUSTOMER_PROFILE_SEARCH_DEFAULT_LIMIT
const fingerprint = customerProfileFilterFingerprint({ q, platform, accountId })
const cursor = request.cursor
  ? decodeCustomerProfileCursor(request.cursor, fingerprint)
  : null
const snapshotAt = cursor?.snapshotAt ?? new Date().toISOString()
```

Build one query from `accounts INNER JOIN conversations INNER JOIN customer_profiles`, immediately wrap it with `applyAccountScope`, then select only:

```ts
[
  'conversations.id as conversation_id',
  'accounts.id as account_id',
  'accounts.platform as platform',
  'accounts.display_name as account_display_name',
  'conversations.contact_display_name as conversation_display_name',
  'customer_profiles.name as name',
  'customer_profiles.age_location as age_location',
  'customer_profiles.occupation as occupation',
  'customer_profiles.family as family',
  'customer_profiles.interests as interests',
  'customer_profiles.other as other',
  'customer_profiles.revision as revision',
  'customer_profiles.updated_at as updated_at',
]
```

Apply explicit OR predicates for the six non-null profile fields, optional platform/account equality, and the eight allowed ILIKE columns. Use one escaped pattern:

```ts
const pattern = q === null ? null : `%${escapeCustomerProfileLikeLiteral(q)}%`
```

Each text predicate must use `ILIKE` with an explicit backslash escape through Kysely `sql<boolean>`. Do not concatenate SQL identifiers or raw user text. Apply `updated_at <= snapshotAt`; when a cursor exists, seek where `updated_at < cursor.updatedAt OR (updated_at = cursor.updatedAt AND conversation_id < cursor.conversationId)`.

Order descending by both fields, fetch `limit + 1`, map timestamps with the existing `timestampToIso()`, construct `CustomerProfileListItem` without external IDs, and encode the next cursor from the last retained row when an extra row exists.

- [ ] **Step 8: Run repository and helper tests to verify GREEN**

```bash
pnpm exec vitest run packages/server/src/customer-profile/library-query.test.ts packages/server/src/customer-profile/library-repo.test.ts packages/server/src/customer-profile/repo.test.ts
pnpm --filter @im-hub/server exec tsc --noEmit
```

Expected: all tests and server typecheck pass.

- [ ] **Step 9: Commit the search domain**

```bash
git add packages/server/src/customer-profile/library-query.ts packages/server/src/customer-profile/library-query.test.ts packages/server/src/customer-profile/repo.ts packages/server/src/customer-profile/library-repo.test.ts
git commit -m "feat(server): add scoped customer profile search"
```

---

### Task 4: Expose the Safe Search API and Typed Desktop Client

**Files:**

- Create: `packages/server/src/api/routes/customer-profiles.ts`
- Create: `packages/server/src/api/routes/customer-profiles.test.ts`
- Modify: `packages/server/src/api/server.ts`
- Modify: `packages/desktop/src/renderer/api/client.ts`
- Modify: `packages/desktop/src/renderer/api/client.test.ts`

**Interfaces:**

- Consumes: `ScopedCustomerProfileRepo.list()`, shared request/page types, global HTTP authentication.
- Produces: `POST /api/customer-profiles/search` and `api.searchCustomerProfiles(request, signal)`.

- [ ] **Step 1: Write failing route tests**

Create an authenticated synthetic fixture matching the role matrix from Task 3. Add these cases:

```ts
it('requires authentication and rejects query-string search', async () => {
  expect((await app.inject({ method: 'POST', url: '/api/customer-profiles/search', payload: {} })).statusCode)
    .toBe(401)
  expect((await app.inject({
    method: 'GET',
    url: '/api/customer-profiles/search?q=must-not-enter-url',
    headers: auth(ownerToken),
  })).statusCode).toBe(404)
})

it('returns only scoped internal/display/profile fields for all four roles', async () => {
  for (const [token, expectedCount] of [[ownerToken, 3], [auditorToken, 3], [managerToken, 2], [agentToken, 1]] as const) {
    const response = await app.inject({
      method: 'POST', url: '/api/customer-profiles/search', headers: auth(token), payload: {},
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.items).toHaveLength(expectedCount)
    expect(response.body).not.toContain(externalContactToken)
    expect(response.body).not.toContain(messageBodyOnlyToken)
  }
})

it.each([
  ['extra key', { unexpected: true }],
  ['bad account', { accountId: 'not-a-uuid' }],
  ['bad limit', { limit: 101 }],
  ['long q', { q: 'x'.repeat(101) }],
  ['bad cursor', { cursor: 'invalid' }],
])('%s returns 400 without echoing the request body', async (_label, payload) => {
  const response = await app.inject({
    method: 'POST', url: '/api/customer-profiles/search', headers: auth(ownerToken), payload,
  })
  expect(response.statusCode).toBe(400)
  expect(response.body).toBe('{"error":"客户档案库查询无效"}')
})
```

Also assert an invisible `accountId` returns `200` with an empty page, not `404`, and auditor still receives `403` from the existing profile PUT route.

- [ ] **Step 2: Run the route test to verify RED**

```bash
pnpm exec vitest run packages/server/src/api/routes/customer-profiles.test.ts
```

Expected: FAIL because the route is not registered.

- [ ] **Step 3: Implement strict body parsing and safe error mapping**

Create `customer-profiles.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import {
  CUSTOMER_PROFILE_SEARCH_MAX_LIMIT,
  PLATFORMS,
  customerProfileCodePointLength,
} from '@im-hub/shared'
import { z } from 'zod'
import { CustomerProfileCursorError } from '../../customer-profile/library-query.js'

const searchBody = z.object({
  q: z.string().transform(value => value.trim()).refine(
    value => customerProfileCodePointLength(value) <= 100,
  ).optional(),
  platform: z.enum(PLATFORMS).optional(),
  accountId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(CUSTOMER_PROFILE_SEARCH_MAX_LIMIT).optional(),
  cursor: z.string().min(1).max(2_048).optional(),
}).strict()

export async function customerProfileLibraryRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/customer-profiles/search', async (req, reply) => {
    const parsed = searchBody.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: '客户档案库查询无效' })
    try {
      return await req.scoped.customerProfiles().list(parsed.data)
    } catch (error) {
      if (error instanceof CustomerProfileCursorError) {
        return reply.code(400).send({ error: '客户档案库查询无效' })
      }
      req.log.error({ err: error, code: 'customer_profile_library_failed' }, '客户档案库查询失败')
      return reply.code(500).send({ error: '客户档案库加载失败，请稍后重试' })
    }
  })
}
```

Register `customerProfileLibraryRoutes` next to `conversationRoutes` in `server.ts`. Never include `req.body`, parsed filters, or raw `q` in logging fields.

- [ ] **Step 4: Run route tests to verify GREEN**

```bash
pnpm exec vitest run packages/server/src/api/routes/customer-profiles.test.ts packages/server/src/api/routes/customer-profile.test.ts
```

Expected: all route tests pass.

- [ ] **Step 5: Write the failing desktop-client test**

Extend `client.test.ts`:

```ts
it('档案库搜索只把关键词放进 POST JSON 并支持取消', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({
      token: 'test-token',
      user: { id: 'user-1', role: 'owner', displayName: 'Test' },
    }))
    .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }))
  vi.stubGlobal('fetch', fetchMock)
  const controller = new AbortController()

  await api.login('owner@example.test', 'synthetic-password')
  await api.searchCustomerProfiles({ q: 'Synthetic query', limit: 50 }, controller.signal)

  expect(fetchMock.mock.calls[1]?.[0]).toContain('/api/customer-profiles/search')
  expect(fetchMock.mock.calls[1]?.[0]).not.toContain('Synthetic')
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', signal: controller.signal })
  expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
    q: 'Synthetic query', limit: 50,
  })
})
```

- [ ] **Step 6: Run the client test to verify RED**

```bash
pnpm exec vitest run packages/desktop/src/renderer/api/client.test.ts
```

Expected: FAIL because `api.searchCustomerProfiles` does not exist.

- [ ] **Step 7: Add the typed cancellable client method**

Import `CustomerProfileListPage` and `CustomerProfileSearchRequest` from shared and add:

```ts
searchCustomerProfiles: (search: CustomerProfileSearchRequest, signal?: AbortSignal) =>
  request<CustomerProfileListPage>('/api/customer-profiles/search', {
    method: 'POST',
    body: JSON.stringify(search),
    signal,
  }),
```

- [ ] **Step 8: Run API/client verification and commit**

```bash
pnpm exec vitest run packages/server/src/api/routes/customer-profiles.test.ts packages/desktop/src/renderer/api/client.test.ts
pnpm typecheck
git add packages/server/src/api/routes/customer-profiles.ts packages/server/src/api/routes/customer-profiles.test.ts packages/server/src/api/server.ts packages/desktop/src/renderer/api/client.ts packages/desktop/src/renderer/api/client.test.ts
git commit -m "feat(api): expose customer profile library search"
```

Expected: tests and typecheck pass before the commit is created.

---

### Task 5: Build the Desktop Library State Machine

**Files:**

- Create: `packages/desktop/src/renderer/customer-profile-library.ts`
- Create: `packages/desktop/src/renderer/customer-profile-library.test.ts`

**Interfaces:**

- Consumes: `CustomerProfileListItem`, `CustomerProfileListPage`, `CustomerProfile`.
- Produces: `CustomerProfileLibraryState`, `CustomerProfileLibraryAction`, `initialCustomerProfileLibraryState()`, and `reduceCustomerProfileLibrary()`.

- [ ] **Step 1: Write failing reducer tests**

Start `customer-profile-library.test.ts` with complete synthetic fixtures so every test is copy-runnable:

```ts
import {
  emptyCustomerProfile,
  type CustomerProfileListItem,
  type CustomerProfileListPage,
} from '@im-hub/shared'
import { describe, expect, it } from 'vitest'
import {
  initialCustomerProfileLibraryState,
  reduceCustomerProfileLibrary,
  type CustomerProfileLibraryState,
} from './customer-profile-library.js'

function item(conversationId: string, name: string): CustomerProfileListItem {
  return {
    conversationId,
    accountId: '00000000-0000-4000-8000-000000000010',
    platform: 'telegram',
    accountDisplayName: 'Synthetic Account',
    conversationDisplayName: name,
    profile: {
      ...emptyCustomerProfile(conversationId),
      name,
      revision: 1,
      updatedAt: '2026-09-03T00:00:00.000Z',
    },
  }
}

function page(
  items: CustomerProfileListItem[],
  nextCursor: string | null,
): CustomerProfileListPage {
  return { items, nextCursor }
}

function readyState(
  items: CustomerProfileListItem[],
  nextCursor: string | null,
): CustomerProfileLibraryState {
  return {
    ...initialCustomerProfileLibraryState(),
    items,
    nextCursor,
    hasLoaded: true,
  }
}

const oldItem = item('00000000-0000-4000-8000-000000000101', 'Old')
const newItem = item('00000000-0000-4000-8000-000000000102', 'New')
const firstItem = item('00000000-0000-4000-8000-000000000103', 'First')
const secondItem = item('00000000-0000-4000-8000-000000000104', 'Second')
```

Then add:

```ts
it('ignores a stale replacement response after a newer request starts', () => {
  let state = initialCustomerProfileLibraryState()
  state = reduceCustomerProfileLibrary(state, { type: 'load.started', requestId: 1, mode: 'replace' })
  state = reduceCustomerProfileLibrary(state, { type: 'load.started', requestId: 2, mode: 'replace' })
  state = reduceCustomerProfileLibrary(state, {
    type: 'load.succeeded', requestId: 1, mode: 'replace', page: page([oldItem], null),
  })
  expect(state.items).toEqual([])
  state = reduceCustomerProfileLibrary(state, {
    type: 'load.succeeded', requestId: 2, mode: 'replace', page: page([newItem], null),
  })
  expect(state.items).toEqual([newItem])
})

it('appends with conversation deduplication and preserves loaded rows on append failure', () => {
  let state = readyState([firstItem], 'cursor-2')
  state = reduceCustomerProfileLibrary(state, { type: 'load.started', requestId: 2, mode: 'append' })
  state = reduceCustomerProfileLibrary(state, {
    type: 'load.succeeded', requestId: 2, mode: 'append', page: page([firstItem, secondItem], null),
  })
  expect(state.items).toEqual([firstItem, secondItem])
  state = reduceCustomerProfileLibrary(state, { type: 'load.started', requestId: 3, mode: 'append' })
  state = reduceCustomerProfileLibrary(state, {
    type: 'load.failed', requestId: 3, mode: 'append', message: '连不上服务端，请稍后重试',
  })
  expect(state.items).toEqual([firstItem, secondItem])
  expect(state.appendError).toBe('连不上服务端，请稍后重试')
})

it('clears invalid selection and applies a successful profile save to the selected item', () => {
  let state = readyState([firstItem], null)
  state = reduceCustomerProfileLibrary(state, {
    type: 'selection.changed', conversationId: firstItem.conversationId,
  })
  state = reduceCustomerProfileLibrary(state, {
    type: 'profile.saved', profile: { ...firstItem.profile, name: 'Updated', revision: 2 },
  })
  expect(state.items[0]?.profile.name).toBe('Updated')
  state = reduceCustomerProfileLibrary(state, { type: 'filters.changed' })
  expect(state.selectedConversationId).toBeNull()
})
```

Also test replace failure, empty success, selection of an unknown conversation, and loading-more mutual exclusion.

- [ ] **Step 2: Run reducer tests to verify RED**

```bash
pnpm exec vitest run packages/desktop/src/renderer/customer-profile-library.test.ts
```

Expected: FAIL because the state module does not exist.

- [ ] **Step 3: Implement the pure state machine**

Use these state/action shapes:

```ts
export type CustomerProfileLibraryLoadMode = 'replace' | 'append'

export interface CustomerProfileLibraryState {
  items: CustomerProfileListItem[]
  nextCursor: string | null
  selectedConversationId: string | null
  activeLoad: { requestId: number; mode: CustomerProfileLibraryLoadMode } | null
  error: string | null
  appendError: string | null
  hasLoaded: boolean
}

export type CustomerProfileLibraryAction =
  | { type: 'filters.changed' }
  | { type: 'load.started'; requestId: number; mode: CustomerProfileLibraryLoadMode }
  | { type: 'load.succeeded'; requestId: number; mode: CustomerProfileLibraryLoadMode; page: CustomerProfileListPage }
  | { type: 'load.failed'; requestId: number; mode: CustomerProfileLibraryLoadMode; message: string }
  | { type: 'selection.changed'; conversationId: string | null }
  | { type: 'profile.saved'; profile: CustomerProfile }
```

Reducer requirements:

- only the exact active request may settle;
- replace swaps items and clears selection when it no longer exists;
- append deduplicates by `conversationId` while preserving server order;
- append failure keeps items/next cursor and sets only `appendError`;
- replace failure sets `error`, keeps `hasLoaded` false when there was no prior success, and clears active load;
- `filters.changed` clears items, cursor, selection and errors so old data cannot flash under new filters;
- `profile.saved` updates only a matching item and never inserts an out-of-scope item.

- [ ] **Step 4: Run reducer tests and desktop typecheck**

```bash
pnpm exec vitest run packages/desktop/src/renderer/customer-profile-library.test.ts
pnpm --filter @im-hub/desktop exec tsc --noEmit
```

Expected: all pass.

- [ ] **Step 5: Commit the state machine**

```bash
git add packages/desktop/src/renderer/customer-profile-library.ts packages/desktop/src/renderer/customer-profile-library.test.ts
git commit -m "feat(desktop): add profile library state machine"
```

---

### Task 6: Build the Searchable Master/Detail Profile Library View

**Files:**

- Create: `packages/desktop/src/renderer/components/CustomerProfileLibraryView.tsx`
- Create: `packages/desktop/src/renderer/components/CustomerProfileLibraryView.test.tsx`
- Modify: `packages/desktop/src/renderer/components/CustomerProfileSection.tsx`
- Modify: `packages/desktop/src/renderer/components/CustomerProfileSection.test.ts`

**Interfaces:**

- Consumes: `api.searchCustomerProfiles()`, Task 5 reducer, store accounts, `CustomerProfileSection`.
- Produces: `CustomerProfileLibraryView({ readOnly })` and optional `CustomerProfileSection.onSaved(profile)` callback.

- [ ] **Step 1: Add a failing successful-save callback test**

Extract a small exported helper from the save success boundary rather than mounting network hooks:

```ts
export function completeCustomerProfileSave(
  dispatch: (action: CustomerProfileEditorAction) => void,
  onSaved: ((profile: CustomerProfile) => void) | undefined,
  event: Extract<CustomerProfileEditorAction, { type: 'save.succeeded' }>,
): void {
  dispatch(event)
  onSaved?.(event.profile)
}
```

First add this test to `CustomerProfileSection.test.ts`:

```ts
it('保存成功时通知档案库刷新对应条目', () => {
  const dispatched: CustomerProfileEditorAction[] = []
  const saved: CustomerProfile[] = []
  const profile = { ...emptyCustomerProfile('c'), name: 'Updated', revision: 2 }
  completeCustomerProfileSave(
    action => { dispatched.push(action) },
    value => { saved.push(value) },
    { type: 'save.succeeded', conversationId: 'c', requestId: 2, profile },
  )
  expect(dispatched).toHaveLength(1)
  expect(saved).toEqual([profile])
})
```

- [ ] **Step 2: Run the callback test to verify RED, then implement it**

Run:

```bash
pnpm exec vitest run packages/desktop/src/renderer/components/CustomerProfileSection.test.ts
```

Expected: FAIL because the helper and prop do not exist.

Add `onSaved?: (profile: CustomerProfile) => void` to `CustomerProfileSection`, call the helper only after the existing conversation/request identity checks pass, and rerun the same test. Expected: PASS.

- [ ] **Step 3: Write failing pure view tests**

Export `CustomerProfileLibraryContent` as a stateless renderer with this exact boundary:

```ts
export interface CustomerProfileLibraryContentProps {
  state: CustomerProfileLibraryState
  selectedItem: CustomerProfileListItem | null
  queryInput: string
  platform: Platform | null
  accountId: string | null
  accounts: ReadonlyArray<Pick<AccountRow, 'id' | 'platform' | 'display_name'>>
  hasFilters: boolean
  detail: ReactNode
  onQueryInputChange(value: string): void
  onPlatformChange(value: Platform | null): void
  onAccountChange(value: string | null): void
  onRefresh(): void
  onSelect(conversationId: string): void
  onLoadMore(): void
  onRetry(): void
}
```

Import `ReactNode` with `import type`. Add a local test `renderContent()` helper that supplies `queryInput: ''`, null filters, `accounts: []`, `hasFilters: false`, `detail: null`, and no-op callbacks unless overridden. Define the test states with the exact Task 5 state shape. Use `renderToStaticMarkup` to cover:

```tsx
type ContentOverrides = Pick<CustomerProfileLibraryContentProps, 'state'>
  & Partial<Omit<CustomerProfileLibraryContentProps, 'state'>>

function renderContent(overrides: ContentOverrides): string {
  const props: CustomerProfileLibraryContentProps = {
    state: overrides.state,
    selectedItem: null,
    queryInput: '',
    platform: null,
    accountId: null,
    accounts: [],
    hasFilters: false,
    detail: null,
    onQueryInputChange: () => undefined,
    onPlatformChange: () => undefined,
    onAccountChange: () => undefined,
    onRefresh: () => undefined,
    onSelect: () => undefined,
    onLoadMore: () => undefined,
    onRetry: () => undefined,
    ...overrides,
  }
  return renderToStaticMarkup(<CustomerProfileLibraryContent {...props} />)
}

function viewState(
  overrides: Partial<CustomerProfileLibraryState> = {},
): CustomerProfileLibraryState {
  return { ...initialCustomerProfileLibraryState(), ...overrides }
}

const profileItem: CustomerProfileListItem = {
  conversationId: '00000000-0000-4000-8000-000000000201',
  accountId: '00000000-0000-4000-8000-000000000202',
  platform: 'telegram',
  accountDisplayName: 'Synthetic Account',
  conversationDisplayName: 'Synthetic Customer',
  profile: {
    ...emptyCustomerProfile('00000000-0000-4000-8000-000000000201'),
    name: 'Synthetic Customer',
    revision: 1,
    updatedAt: '2026-09-03T00:00:00.000Z',
  },
}

const readyState = (items: CustomerProfileListItem[], nextCursor: string | null) =>
  viewState({ items, nextCursor, hasLoaded: true })
const loadingState = () =>
  viewState({ activeLoad: { requestId: 1, mode: 'replace' } })
const emptyState = () => viewState({ hasLoaded: true })
const failedState = () =>
  viewState({ error: '客户档案库加载失败，请稍后重试' })
const appendFailedState = () => viewState({
  items: [profileItem],
  hasLoaded: true,
  appendError: '连不上服务端，请稍后重试',
})
```

Then add these assertions:

```ts
it('renders search controls, result metadata and selected profile detail', () => {
  const html = renderContent({
    state: readyState([profileItem], null),
    selectedItem: profileItem,
    detail: <div>Selected profile detail</div>,
  })
  expect(html).toContain('客户档案库')
  expect(html).toContain('搜索客户档案')
  expect(html).toContain('Synthetic Account')
  expect(html).toContain('Synthetic Customer')
  expect(html).toContain('Selected profile detail')
})

it('renders distinct initial, empty-filter, first-load-error and append-error states', () => {
  expect(renderContent({ state: loadingState(), selectedItem: null })).toContain('正在加载客户档案库')
  expect(renderContent({ state: emptyState(), selectedItem: null, hasFilters: false }))
    .toContain('还没有客户档案')
  expect(renderContent({ state: emptyState(), selectedItem: null, hasFilters: true }))
    .toContain('没有匹配的客户档案')
  expect(renderContent({ state: failedState(), selectedItem: null })).toContain('重试')
  expect(renderContent({ state: appendFailedState(), selectedItem: null })).toContain('重试加载更多')
})
```

Keep the existing `CustomerProfileSectionView` read-only test as the auditor edit-control regression. The library controller passes `readOnly` to the real `CustomerProfileSection`; the pure content test uses the `detail` slot and does not mount its network hooks.

- [ ] **Step 4: Run view tests to verify RED**

```bash
pnpm exec vitest run packages/desktop/src/renderer/components/CustomerProfileLibraryView.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 5: Implement the controller and stateless content**

`CustomerProfileLibraryView` must:

- read visible accounts from the existing Zustand store;
- keep raw input, debounced query, platform and account filters in local state;
- use a 300 ms timer to update the debounced query;
- reset an account filter when its account does not belong to the selected platform;
- keep one `AbortController` and monotonically increasing request ID;
- dispatch `filters.changed` only when filter values change; same-filter refresh, retry and save-refresh keep
  the current rows and selection until the replacement response decides whether the selection is still valid;
- call `api.searchCustomerProfiles({ q, platform, accountId, limit: 50, cursor }, signal)`;
- map `NetworkError` to `连不上服务端，请稍后重试` and all other non-401 failures to `客户档案库加载失败，请稍后重试`;
- ignore a settlement when its controller is already aborted, and let `UnauthorizedError` use the existing global sign-out listener without showing a transient library error;
- never put the search term into an error string or console call;
- append only when `nextCursor` exists and no request is active;
- abort on filter change and unmount;
- after `onSaved`, dispatch `profile.saved`, then start a new replacement load so server ordering is authoritative.

Pass all controller state and callbacks to `CustomerProfileLibraryContent`, including the actual detail node. Render a fixed-height flex master/detail surface. The list shows profile name when present, otherwise conversation display name, otherwise `未命名客户`; it also shows platform/account display names and a short preview chosen in field order without HTML. The detail pane renders:

```tsx
<CustomerProfileSection
  conversationId={selectedItem.conversationId}
  readOnly={readOnly}
  onSaved={handleProfileSaved}
/>
```

Do not call account selection, native control, guest context, platform window, message, or translation APIs from this component.

- [ ] **Step 6: Run desktop component/state tests and typecheck**

```bash
pnpm exec vitest run packages/desktop/src/renderer/components/CustomerProfileSection.test.ts packages/desktop/src/renderer/components/CustomerProfileLibraryView.test.tsx packages/desktop/src/renderer/customer-profile-library.test.ts
pnpm --filter @im-hub/desktop exec tsc --noEmit
```

Expected: all pass.

- [ ] **Step 7: Commit the profile library view**

```bash
git add packages/desktop/src/renderer/components/CustomerProfileLibraryView.tsx packages/desktop/src/renderer/components/CustomerProfileLibraryView.test.tsx packages/desktop/src/renderer/components/CustomerProfileSection.tsx packages/desktop/src/renderer/components/CustomerProfileSection.test.ts
git commit -m "feat(desktop): build searchable profile library view"
```

---

### Task 7: Wire Navigation and Remove Translation History

**Files:**

- Modify: `packages/desktop/src/renderer/components/FunctionCenter.tsx`
- Create: `packages/desktop/src/renderer/components/FunctionCenter.test.tsx`
- Modify: `packages/desktop/src/renderer/App.tsx`

**Interfaces:**

- Consumes: `CustomerProfileLibraryView`, current authenticated `SessionUser`.
- Produces: `ViewKey = 'chat' | 'accounts' | 'customerProfiles'`, a wired profile-library entry, and no translation-history entry.

- [ ] **Step 1: Write the failing navigation metadata test**

Export the entry list as `FUNCTION_CENTER_ENTRIES` and test it directly:

```ts
import { describe, expect, it } from 'vitest'
import { FUNCTION_CENTER_ENTRIES } from './FunctionCenter.js'

describe('FunctionCenter entries', () => {
  it('wires customer profiles and removes misleading translation history', () => {
    expect(FUNCTION_CENTER_ENTRIES).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '客户档案库', view: 'customerProfiles' }),
    ]))
    expect(FUNCTION_CENTER_ENTRIES.some(entry => entry.title === '翻译历史')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the navigation test to verify RED**

```bash
pnpm exec vitest run packages/desktop/src/renderer/components/FunctionCenter.test.tsx
```

Expected: FAIL because the list is not exported, the library is unwired, and translation history still exists.

- [ ] **Step 3: Wire the entry and render the new view**

Change the view union and entry list:

```ts
export type ViewKey = 'chat' | 'accounts' | 'customerProfiles'

export interface FunctionCenterEntry {
  glyph: string
  tint: string
  title: string
  desc: string
  view?: ViewKey
  action?: 'addAccount'
}

export const FUNCTION_CENTER_ENTRIES: FunctionCenterEntry[] = [
  { glyph: '+', tint: '#0a6fe8', title: '添加账号', desc: '接入新的聊天平台账号', action: 'addAccount' },
  { glyph: '话', tint: '#101a5c', title: '会话', desc: '平台原生界面、翻译与客户资料', view: 'chat' },
  { glyph: '号', tint: '#22b573', title: '账号状态', desc: '各账号在线情况与历史起点', view: 'accounts' },
  { glyph: '警', tint: '#e0364a', title: '关键词警报', desc: '命中敏感词时通知管理员' },
  { glyph: '词', tint: '#8b5cf6', title: '术语表', desc: '固定人名、品牌与产品译法' },
  { glyph: '档', tint: '#0891b2', title: '客户档案库', desc: '搜索并维护跨会话客户资料', view: 'customerProfiles' },
  { glyph: '搜', tint: '#64748b', title: '全局搜索', desc: '跨账号检索消息与联系人' },
]
```

Use this exported constant for both the ready count and button map. In `App.tsx`, import the library view and replace the broad `view !== 'chat'` accounts rendering with explicit branches:

```tsx
{view === 'accounts' && (
  <AccountsView
    onOpenChat={() => setView('chat')}
    onRelink={setRelinkAccount}
    onAddAccount={() => {
      setAddPlatform(activePlatform)
      setAddOpen(true)
    }}
  />
)}
{view === 'customerProfiles' && (
  <CustomerProfileLibraryView readOnly={user?.role === 'auditor'} />
)}
```

Keep the existing chat view mounted with `display: none` when inactive so native platform sessions and outboxes are not torn down.

- [ ] **Step 4: Run navigation/desktop verification**

```bash
pnpm exec vitest run packages/desktop/src/renderer/components/FunctionCenter.test.tsx packages/desktop/src/renderer/components/CustomerProfileLibraryView.test.tsx
pnpm --filter @im-hub/desktop exec tsc --noEmit
pnpm --filter @im-hub/desktop build
```

Expected: tests, typecheck and all three electron-vite build stages pass.

- [ ] **Step 5: Commit navigation**

```bash
git add packages/desktop/src/renderer/components/FunctionCenter.tsx packages/desktop/src/renderer/components/FunctionCenter.test.tsx packages/desktop/src/renderer/App.tsx
git commit -m "feat(desktop): wire customer profile library navigation"
```

---

### Task 8: Synchronize Product Documentation and Run Final Verification

**Files:**

- Modify: `docs/superpowers/specs/2026-08-26-m0-product-scope.md`
- Modify: `docs/superpowers/specs/2026-09-02-m4-customer-profile-design.md`
- Modify: `docs/superpowers/specs/2026-08-24-im-hub-design.md`
- Modify: `docs/features/05-权限与团队.md`
- Modify: `docs/features/06-需求缺口.md`
- Modify: `docs/features/README.md`
- Modify: `docs/RUNBOOK.md`
- Modify after verification: `docs/superpowers/specs/2026-09-03-m4-customer-profile-library-design.md`

**Interfaces:**

- Consumes: all verified code behavior and migration outcome.
- Produces: current documentation with no false audit/translation-history promises, final automated evidence, and an optional a55 manual-acceptance artifact.

- [ ] **Step 1: Update current product and runbook statements**

Make these exact semantic changes:

- M0/M4 roadmap: replace “审计日志” in the active M4 scope with “可检索客户档案库”; preserve keywords/team/admin as future slices.
- Main design: state that customer profiles are manually maintained and searchable under RBAC; remove active promises that auditor original-message reads are audited.
- M4-1 spec: append a 2026-09-03 correction explaining that its historical minimal audit write existed, then was removed by approved M4-2 migration; do not rewrite the historical implementation checkpoint as if it never happened.
- Permission feature doc: describe `auditor` as a global read-only compatibility role and remove `requiresAudit`/missing-audit warnings.
- Gap doc and feature README: mark searchable profile library complete only after tests pass; remove audit query from the active gap list.
- RUNBOOK: document the POST search endpoint, the four-role library matrix, the destructive audit removal, and the absence of a translation-history page.
- Function-center documentation: current translation still appears inline in conversations; `message_translations` remains, but there is no version-history page.

- [ ] **Step 2: Scan for stale current-code promises and sensitive/unrelated changes**

Run:

```bash
rg -n "requiresAudit" packages docs/RUNBOOK.md docs/features docs/superpowers/specs/2026-08-24-im-hub-design.md docs/superpowers/specs/2026-08-26-m0-product-scope.md docs/superpowers/specs/2026-09-02-m4-customer-profile-design.md
rg -n "翻译历史" packages/desktop/src docs/RUNBOOK.md docs/features docs/superpowers/specs/2026-08-24-im-hub-design.md docs/superpowers/specs/2026-08-26-m0-product-scope.md
git diff --check
git status --short
```

Expected: no `requiresAudit` remains in active code/current docs, no desktop “翻译历史” entry remains, `git diff --check` is empty, and status contains only the intended M4-2 files. Historical plans may still describe the old audit implementation and must not be bulk-rewritten.

- [ ] **Step 3: Run focused test suites**

```bash
pnpm exec vitest run packages/shared/src/customer-profile.test.ts packages/server/src/db/migrations/0014_customer_profile_library.test.ts packages/server/src/rbac/scope.test.ts packages/server/src/rbac/scoped-db.test.ts packages/server/src/rbac/apply.test.ts packages/server/src/customer-profile/library-query.test.ts packages/server/src/customer-profile/repo.test.ts packages/server/src/customer-profile/library-repo.test.ts packages/server/src/api/routes/customer-profile.test.ts packages/server/src/api/routes/customer-profiles.test.ts packages/desktop/src/renderer/api/client.test.ts packages/desktop/src/renderer/customer-profile-library.test.ts packages/desktop/src/renderer/customer-profile-library-controller.test.ts packages/desktop/src/renderer/components/CustomerProfileSection.test.ts packages/desktop/src/renderer/components/CustomerProfileLibraryView.test.tsx packages/desktop/src/renderer/components/FunctionCenter.test.tsx
```

Expected: all listed tests pass with zero failures.

- [ ] **Step 4: Run full repository verification**

Before claiming success, invoke `superpowers:verification-before-completion`, then run fresh commands:

```bash
pnpm typecheck
pnpm test
pnpm --filter @im-hub/desktop build
```

Expected: typecheck exits 0, full Vitest has zero failures and uses only the `_test` database, and electron-vite builds main/preload/renderer successfully. If PostgreSQL access fails with a sandbox `EPERM`, rerun the exact same test command with the required sandbox escalation; do not change the database target.

- [ ] **Step 5: Record the implementation checkpoint and commit docs**

Append only verified commit IDs, exact test counts, build results, migration status, and manual status to the M4-2 spec. Do not include profile values, search terms, actual account names/IDs, message keys, or platform session details.

```bash
git add docs/superpowers/specs/2026-08-26-m0-product-scope.md docs/superpowers/specs/2026-09-02-m4-customer-profile-design.md docs/superpowers/specs/2026-08-24-im-hub-design.md docs/superpowers/specs/2026-09-03-m4-customer-profile-library-design.md docs/features/05-权限与团队.md docs/features/06-需求缺口.md docs/features/README.md docs/RUNBOOK.md
git commit -m "docs: record searchable profile library"
```

- [ ] **Step 6: Build an optional a55 real-UI package without inspecting profiles**

Only if a real desktop acceptance package is needed, first verify exact sources without opening their contents:

```bash
test -d /Applications/Signal.app
test -d /private/tmp/Signal-imhub-integrated-a54.app
test ! -e /private/tmp/Signal-imhub-integrated-a55.app
```

Then run:

```bash
pnpm --filter @im-hub/desktop prepare:signal -- --source /Applications/Signal.app --output /private/tmp/Signal-imhub-integrated-a55.app --profile-source /private/tmp/Signal-imhub-integrated-a54.app
/usr/bin/codesign --verify --deep --strict /private/tmp/Signal-imhub-integrated-a55.app
```

Expected: preparation reports success and codesign exits 0. `--profile-source` is opaque byte copying; do not inspect or print its configuration. Restart only the im-hub server if required by the new endpoint, and do not restart Telegram separately.

- [ ] **Step 7: Run profile-library-only manual acceptance**

Open a55 only after automated verification and use existing non-sensitive/manual profile data without printing it to terminal output. Do not send platform messages. Ask the user to report only:

```text
档案库：可打开；管理员可见范围：正确；关键词检索：命中；平台/账号筛选：正常；详情：正确；编辑保存：成功；翻译历史：无；错误提示：无
```

If no real package is needed, record “未进行真实桌面验收” rather than implying acceptance.

- [ ] **Step 8: Review the complete branch and request code review**

Run:

```bash
git status --short --branch
git diff origin/main...HEAD --stat
git diff origin/main...HEAD --check
```

Expected: the branch contains only the design, plan and intended implementation/docs. Invoke `superpowers:requesting-code-review`, address only verified findings using `superpowers:receiving-code-review`, rerun affected tests, and do not push/create a PR until the user authorizes the GitHub step.

---

## Planned Commit Sequence

1. `feat(shared): add customer profile library contract`
2. `refactor(server): remove cancelled audit data path`
3. `feat(server): add scoped customer profile search`
4. `feat(api): expose customer profile library search`
5. `feat(desktop): add profile library state machine`
6. `feat(desktop): build searchable profile library view`
7. `feat(desktop): wire customer profile library navigation`
8. `docs: record searchable profile library`

The existing design commit `caffa6e` precedes this sequence. Do not amend or squash during implementation; each task remains independently reviewable.
