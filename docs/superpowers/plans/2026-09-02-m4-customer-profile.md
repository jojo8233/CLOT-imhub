# M4-1 Customer Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让员工在三平台原生会话右侧读取、人工编辑并并发安全地保存客户档案，同时原子记录不含档案正文的最小审计事实。

**Architecture:** `packages/shared` 定义唯一字段契约与 Unicode 规范化；server 通过受 scope 约束的专用仓储在同一事务中锁定会话、更新档案并写审计；desktop 用 API client、纯 reducer 和独立档案区组件管理加载、编辑、冲突与迟到响应。平台 guest、翻译、composer、send attempt 与平台消息 ID 保持不变。

**Tech Stack:** Node.js 22+、pnpm 10、TypeScript ESM strict、Kysely/PostgreSQL、Fastify 5、Zod 3、Electron 33、React 19、zustand、Vitest 2。

**Spec:** `docs/superpowers/specs/2026-09-02-m4-customer-profile-design.md`

## Global Constraints

- 只使用现有 `/private/tmp/im-hub-m3-outbox` worktree 和 `codex/m4-customer-profile` 分支；不创建新 worktree，不修改主 checkout。
- 源码相对导入使用 `.js` 后缀，类型导入使用 `import type`；不使用 `any`、`@ts-ignore` 或非空断言绕过设计。
- 业务路由只能经 `req.scoped` 访问可见数据，不能直接 import 全局 `db`；auditor 固定只读。
- customer profile 与 `conversations.id` 一对一；同一客户跨平台、跨账号不自动合并。
- 人工资料是权威值；本计划不实现模型提取，不预建 suggestion 表。
- 审计只保存 actor、内部 account/conversation、action、字段名与时间，不保存旧值、新值、消息正文或平台标识。
- 不修改 Telegram、Signal、WhatsApp 的 guest、翻译、composer、send attempt 或平台消息 ID 逻辑，不进行真实平台发送。
- 不读取、打印或提交 `.env`、平台 profile/session、账号标识、消息正文、消息键、媒体引用、token、二维码、验证码或密钥。
- 数据库测试只连接现有固定 `_test` 库；不把 migration 或测试指向开发库、生产库。
- 每个任务严格走 RED → GREEN → 相关回归 → commit；提交前运行 `git diff --check`。

## File Responsibility Map

- `packages/shared/src/customer-profile.ts`：字段顺序、长度限制、共享 DTO、trim/null 与 code-point 辅助函数。
- `packages/server/src/db/migrations/0013_customer_profiles.ts`：`customer_profiles`、`audit_logs`、约束和索引。
- `packages/server/src/db/types.ts`：Kysely 两张新表的 TypeScript 映射。
- `packages/server/src/customer-profile/repo.ts`：scope-safe 读取、事务锁、乐观锁、差异字段和审计原子写入。
- `packages/server/src/rbac/scoped-db.ts`：唯一工厂入口 `customerProfiles()`，不暴露原始数据库。
- `packages/server/src/api/routes/conversations.ts`：GET/PUT 路由、Zod 校验、中文非敏感错误映射。
- `packages/desktop/src/renderer/api/client.ts`：typed customer profile HTTP client。
- `packages/desktop/src/renderer/customer-profile-editor.ts`：与 React 无关的编辑器 reducer，负责迟到响应和草稿保留。
- `packages/desktop/src/renderer/components/CustomerProfileSection.tsx`：档案副作用编排和纯展示组件。
- `packages/desktop/src/renderer/components/CustomerPanel.tsx`：现有互动信息与新档案区组合。
- `docs/RUNBOOK.md`：已完成能力、权限和仍未实现边界。

---

### Task 1: Shared Customer Profile Contract

**Files:**
- Create: `packages/shared/src/customer-profile.ts`
- Create: `packages/shared/src/customer-profile.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `CUSTOMER_PROFILE_FIELDS`、`CUSTOMER_PROFILE_MAX_CODE_POINTS`、`CustomerProfileField`、`CustomerProfileValues`、`CustomerProfile`、`CustomerProfileUpdate`、`normalizeCustomerProfileText()`、`customerProfileCodePointLength()`、`emptyCustomerProfile()`。

- [ ] **Step 1: Write the failing shared contract tests**

```ts
import { describe, expect, it } from 'vitest'
import {
  CUSTOMER_PROFILE_FIELDS,
  customerProfileCodePointLength,
  emptyCustomerProfile,
  normalizeCustomerProfileText,
} from './customer-profile.js'

describe('customer profile contract', () => {
  it('固定人工字段顺序，供审计和 UI 共用', () => {
    expect(CUSTOMER_PROFILE_FIELDS).toEqual([
      'name', 'ageLocation', 'occupation', 'family', 'interests', 'other',
    ])
  })

  it('只 trim 两端并把纯空白规范成 null', () => {
    expect(normalizeCustomerProfileText('  Alice  ')).toBe('Alice')
    expect(normalizeCustomerProfileText('  likes  tea  ')).toBe('likes  tea')
    expect(normalizeCustomerProfileText(' \n ')).toBeNull()
    expect(normalizeCustomerProfileText(null)).toBeNull()
  })

  it('用 Unicode code point 计数而不是 UTF-16 code unit', () => {
    expect('😀'.length).toBe(2)
    expect(customerProfileCodePointLength('😀')).toBe(1)
  })

  it('未建档案返回 revision 0 的全空快照', () => {
    expect(emptyCustomerProfile('conversation-1')).toEqual({
      conversationId: 'conversation-1',
      name: null,
      ageLocation: null,
      occupation: null,
      family: null,
      interests: null,
      other: null,
      revision: 0,
      updatedAt: null,
    })
  })
})
```

- [ ] **Step 2: Run the test to verify RED**

Run: `pnpm exec vitest run packages/shared/src/customer-profile.test.ts`

Expected: FAIL because `./customer-profile.js` does not exist.

- [ ] **Step 3: Implement the shared contract**

```ts
export const CUSTOMER_PROFILE_FIELDS = [
  'name',
  'ageLocation',
  'occupation',
  'family',
  'interests',
  'other',
] as const

export type CustomerProfileField = typeof CUSTOMER_PROFILE_FIELDS[number]

export const CUSTOMER_PROFILE_MAX_CODE_POINTS = {
  name: 200,
  ageLocation: 2_000,
  occupation: 2_000,
  family: 2_000,
  interests: 2_000,
  other: 2_000,
} satisfies Record<CustomerProfileField, number>

export interface CustomerProfileValues {
  name: string | null
  ageLocation: string | null
  occupation: string | null
  family: string | null
  interests: string | null
  other: string | null
}

export interface CustomerProfile extends CustomerProfileValues {
  conversationId: string
  revision: number
  updatedAt: string | null
}

export interface CustomerProfileUpdate extends CustomerProfileValues {
  expectedRevision: number
}

export function normalizeCustomerProfileText(value: string | null): string | null {
  if (value === null) return null
  const normalized = value.trim()
  return normalized === '' ? null : normalized
}

export function customerProfileCodePointLength(value: string): number {
  return Array.from(value).length
}

export function emptyCustomerProfile(conversationId: string): CustomerProfile {
  return {
    conversationId,
    name: null,
    ageLocation: null,
    occupation: null,
    family: null,
    interests: null,
    other: null,
    revision: 0,
    updatedAt: null,
  }
}
```

Add `export * from './customer-profile.js'` to `packages/shared/src/index.ts`.

- [ ] **Step 4: Run focused and shared type checks**

Run: `pnpm exec vitest run packages/shared/src/customer-profile.test.ts`

Expected: 4 tests PASS.

Run: `pnpm --filter @im-hub/shared exec tsc --noEmit`

Expected: exit 0.

- [ ] **Step 5: Check and commit**

Run: `git diff --check`

Expected: no output.

```bash
git add packages/shared/src/customer-profile.ts packages/shared/src/customer-profile.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): define customer profile contract"
```

---

### Task 2: Scoped Persistence, Optimistic Locking, and Audit

**Files:**
- Create: `packages/server/src/db/migrations/0013_customer_profiles.ts`
- Create: `packages/server/src/customer-profile/repo.ts`
- Create: `packages/server/src/customer-profile/repo.test.ts`
- Modify: `packages/server/src/db/types.ts`
- Modify: `packages/server/src/rbac/scoped-db.ts`
- Modify: `packages/server/src/rbac/scoped-db.test.ts`

**Interfaces:**
- Consumes: Task 1 shared customer profile types and helpers；现有 `applyAccountScope()` 与 `ScopeFilter`。
- Produces: `ScopedCustomerProfileRepo.get(conversationId)`、`ScopedCustomerProfileRepo.save(conversationId, actorUserId, update)`、`SaveCustomerProfileResult`、`ScopedDb.customerProfiles()`。

- [ ] **Step 1: Write failing scoped repository tests**

Create an integration fixture in `repo.test.ts` using the existing `testDatabaseUrl()` pattern. The synthetic profile values must not resemble real customer data.

Define these test-local helpers before the assertions so every later example is directly runnable:

```ts
function syntheticUpdate(expectedRevision: number): CustomerProfileUpdate {
  return {
    name: 'Synthetic Name',
    ageLocation: null,
    occupation: 'Synthetic Occupation',
    family: null,
    interests: null,
    other: null,
    expectedRevision,
  }
}

function saveSyntheticProfile(
  repo: ScopedCustomerProfileRepo,
  conversationId: string,
  actorUserId: string,
  expectedRevision: number,
) {
  return repo.save(conversationId, actorUserId, syntheticUpdate(expectedRevision))
}
```

```ts
it('可见但未建档案时返回 revision 0 空快照', async () => {
  const result = await ownerRepo.get(conversationId)
  expect(result).toEqual(emptyCustomerProfile(conversationId))
})

it('首建档案与字段名审计在同一结果中完成', async () => {
  const result = await ownerRepo.save(conversationId, ownerId, {
    name: 'Synthetic Name',
    ageLocation: null,
    occupation: 'Synthetic Occupation',
    family: null,
    interests: null,
    other: null,
    expectedRevision: 0,
  })
  expect(result).toMatchObject({ kind: 'saved', profile: { revision: 1 } })
  const audit = await db.selectFrom('audit_logs').selectAll().executeTakeFirstOrThrow()
  expect(audit.action).toBe('customer_profile.updated')
  expect(audit.changed_fields).toEqual(['name', 'occupation'])
  expect(JSON.stringify(audit)).not.toContain('Synthetic Name')
  expect(JSON.stringify(audit)).not.toContain('Synthetic Occupation')
})

it('相同内容重复保存不加 revision 且不制造审计', async () => {
  const first = await saveSyntheticProfile(ownerRepo, conversationId, ownerId, 0)
  expect(first.kind).toBe('saved')
  const second = await saveSyntheticProfile(ownerRepo, conversationId, ownerId, 1)
  expect(second).toMatchObject({ kind: 'saved', profile: { revision: 1 } })
  const count = await db.selectFrom('audit_logs').select(({ fn }) => fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow()
  expect(Number(count.count)).toBe(1)
})

it('修改已有档案只审计实际变化字段并增加 revision', async () => {
  await saveSyntheticProfile(ownerRepo, conversationId, ownerId, 0)
  const result = await ownerRepo.save(conversationId, ownerId, {
    ...syntheticUpdate(1),
    family: 'Synthetic Family Note',
  })
  expect(result).toMatchObject({
    kind: 'saved', profile: { revision: 2 }, changedFields: ['family'],
  })
  const audits = await db.selectFrom('audit_logs')
    .select('changed_fields').orderBy('created_at').execute()
  expect(audits.map(row => row.changed_fields)).toEqual([
    ['name', 'occupation'],
    ['family'],
  ])
})

it('旧 revision 返回冲突且不覆盖服务器档案', async () => {
  await saveSyntheticProfile(ownerRepo, conversationId, ownerId, 0)
  const result = await ownerRepo.save(conversationId, ownerId, {
    name: 'Stale Draft', ageLocation: null, occupation: null,
    family: null, interests: null, other: null, expectedRevision: 0,
  })
  expect(result).toEqual({ kind: 'conflict', currentRevision: 1 })
  expect((await ownerRepo.get(conversationId))?.name).toBe('Synthetic Name')
})

it('两个 expectedRevision 0 并发首建只有一个成功', async () => {
  const [left, right] = await Promise.all([
    saveSyntheticProfile(ownerRepo, conversationId, ownerId, 0),
    saveSyntheticProfile(ownerRepo, conversationId, ownerId, 0),
  ])
  expect([left.kind, right.kind].sort()).toEqual(['conflict', 'saved'])
})

it('不可见会话既读不到也写不入审计', async () => {
  expect(await outsiderRepo.get(conversationId)).toBeNull()
  expect(await outsiderRepo.save(conversationId, outsiderId, syntheticUpdate(0)))
    .toEqual({ kind: 'not_found' })
  expect(await db.selectFrom('audit_logs').selectAll().execute()).toEqual([])
})

it('写入步骤失败时整个事务回滚', async () => {
  const unknownActorId = '00000000-0000-4000-8000-000000000099'
  await expect(ownerRepo.save(conversationId, unknownActorId, syntheticUpdate(0)))
    .rejects.toThrow()
  expect(await ownerRepo.get(conversationId)).toEqual(emptyCustomerProfile(conversationId))
  expect(await db.selectFrom('audit_logs').selectAll().execute()).toEqual([])
})

it('删除会话会级联删除档案与最小审计', async () => {
  await saveSyntheticProfile(ownerRepo, conversationId, ownerId, 0)
  await db.deleteFrom('conversations').where('id', '=', conversationId).execute()
  expect(await db.selectFrom('customer_profiles').selectAll().execute()).toEqual([])
  expect(await db.selectFrom('audit_logs').selectAll().execute()).toEqual([])
})
```

Also add a `ScopedDb` unit assertion that `customerProfiles()` returns a repo closed over the same scope, without exposing `db`.

- [ ] **Step 2: Run the repository tests to verify RED**

Run: `pnpm exec vitest run packages/server/src/customer-profile/repo.test.ts packages/server/src/rbac/scoped-db.test.ts`

Expected: FAIL because the migration tables, repo, and `customerProfiles()` do not exist.

- [ ] **Step 3: Add migration and Kysely table types**

Migration requirements:

```ts
await db.schema.createTable('customer_profiles')
  .addColumn('conversation_id', 'uuid', c => c.primaryKey()
    .references('conversations.id').onDelete('cascade'))
  .addColumn('name', 'text')
  .addColumn('age_location', 'text')
  .addColumn('occupation', 'text')
  .addColumn('family', 'text')
  .addColumn('interests', 'text')
  .addColumn('other', 'text')
  .addColumn('revision', 'integer', c => c.notNull())
  .addColumn('updated_by_user_id', 'uuid', c => c.references('users.id').onDelete('set null'))
  .addColumn('created_at', 'timestamptz', c => c.notNull().defaultTo(sql`now()`))
  .addColumn('updated_at', 'timestamptz', c => c.notNull().defaultTo(sql`now()`))
  .addCheckConstraint('customer_profiles_revision_check', sql`revision > 0`)
  .addCheckConstraint('customer_profiles_name_length_check', sql`name is null or char_length(name) <= 200`)
  .addCheckConstraint('customer_profiles_age_location_length_check', sql`age_location is null or char_length(age_location) <= 2000`)
  .addCheckConstraint('customer_profiles_occupation_length_check', sql`occupation is null or char_length(occupation) <= 2000`)
  .addCheckConstraint('customer_profiles_family_length_check', sql`family is null or char_length(family) <= 2000`)
  .addCheckConstraint('customer_profiles_interests_length_check', sql`interests is null or char_length(interests) <= 2000`)
  .addCheckConstraint('customer_profiles_other_length_check', sql`other is null or char_length(other) <= 2000`)
  .execute()

await db.schema.createTable('audit_logs')
  .addColumn('id', 'uuid', c => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
  .addColumn('actor_user_id', 'uuid', c => c.references('users.id').onDelete('set null'))
  .addColumn('account_id', 'uuid', c => c.notNull().references('accounts.id').onDelete('cascade'))
  .addColumn('conversation_id', 'uuid', c => c.notNull().references('conversations.id').onDelete('cascade'))
  .addColumn('action', 'text', c => c.notNull())
  .addColumn('changed_fields', 'jsonb', c => c.notNull())
  .addColumn('created_at', 'timestamptz', c => c.notNull().defaultTo(sql`now()`))
  .addCheckConstraint('audit_logs_action_check', sql`action = 'customer_profile.updated'`)
  .addCheckConstraint('audit_logs_changed_fields_check', sql`jsonb_typeof(changed_fields) = 'array' and jsonb_array_length(changed_fields) > 0`)
  .execute()
```

Create index `audit_logs_account_created_idx` on `account_id, created_at`. `down()` must drop `audit_logs` before `customer_profiles`.

Add exact `CustomerProfilesTable` and `AuditLogsTable` interfaces to `db/types.ts`; declare `changed_fields` as `JSONColumnType<CustomerProfileField[]>`, then add both table keys to `Database`.

- [ ] **Step 4: Implement the scoped repository with a conversation row lock**

Expose these exact result types:

```ts
export type SaveCustomerProfileResult =
  | { kind: 'not_found' }
  | { kind: 'conflict'; currentRevision: number }
  | { kind: 'saved'; profile: CustomerProfile; changedFields: CustomerProfileField[] }

export class ScopedCustomerProfileRepo {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly scope: ScopeFilter,
  ) {}

  async get(conversationId: string): Promise<CustomerProfile | null>

  async save(
    conversationId: string,
    actorUserId: string,
    update: CustomerProfileUpdate,
  ): Promise<SaveCustomerProfileResult>
}
```

Inside `save()`, use one `db.transaction().execute()` callback. The first query must start from `accounts`, join `conversations`, apply `applyAccountScope`, filter the requested internal UUID, select account/conversation ids, and call `.forUpdate('conversations')`. Only after that lock is acquired may the repo read `customer_profiles`, compare `expectedRevision`, calculate fields changed in `CUSTOMER_PROFILE_FIELDS` order, insert/update the profile, and insert `audit_logs`.

Map PostgreSQL timestamps without assuming the driver always returns a `Date`:

```ts
function timestampToIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString()
}
```

Return `emptyCustomerProfile(conversationId)` for a visible conversation with no profile row. Never select or log platform contact identifiers.

Add to `ScopedDb`:

```ts
customerProfiles(): ScopedCustomerProfileRepo {
  return new ScopedCustomerProfileRepo(this.db, this.scope)
}
```

- [ ] **Step 5: Apply only the new migration to the fixed test database**

Run: `DATABASE_URL='postgres://imhub:imhub_dev@localhost:5432/imhub_test' REDIS_URL='redis://localhost:6379' JWT_SECRET='m4-customer-profile-test-secret-32c' pnpm db:migrate`

Expected: `Success: 0013_customer_profiles` and no development/production database access. These are synthetic test-only values; do not source `.env`.

- [ ] **Step 6: Run GREEN and adjacent persistence regressions**

Run: `pnpm exec vitest run packages/server/src/customer-profile/repo.test.ts packages/server/src/rbac/scoped-db.test.ts packages/server/src/ingest/repo.test.ts`

Expected: all tests PASS; the concurrent create test yields exactly one `saved` and one `conflict`.

- [ ] **Step 7: Check and commit**

Run: `git diff --check`

Expected: no output.

```bash
git add packages/server/src/db/migrations/0013_customer_profiles.ts packages/server/src/db/types.ts packages/server/src/customer-profile/repo.ts packages/server/src/customer-profile/repo.test.ts packages/server/src/rbac/scoped-db.ts packages/server/src/rbac/scoped-db.test.ts
git commit -m "feat(server): persist scoped customer profiles"
```

---

### Task 3: RBAC-Safe Customer Profile HTTP API

**Files:**
- Modify: `packages/server/src/api/routes/conversations.ts`
- Create: `packages/server/src/api/routes/customer-profile.test.ts`

**Interfaces:**
- Consumes: `req.scoped.customerProfiles()` and Task 1 shared limits/helpers.
- Produces: `GET /api/conversations/:id/customer-profile` and `PUT /api/conversations/:id/customer-profile`.

- [ ] **Step 1: Write failing route tests**

Build the fixture with owner, auditor, agent owner, outsider agent, manager leading the account team, and manager from another team. Use `ActorRepo.findMemberships()` to return current memberships per request.

After creating the fixture actors and conversation, define these test-local helpers (the token variables come from the synthetic fixture; never print them):

```ts
const profileUrl = `/api/conversations/${conversationId}/customer-profile`

function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` }
}

function validBody(expectedRevision: number): CustomerProfileUpdate {
  return {
    name: 'Synthetic Name',
    ageLocation: null,
    occupation: null,
    family: null,
    interests: null,
    other: null,
    expectedRevision,
  }
}

function putProfile(token: string, payload: CustomerProfileUpdate) {
  return app.inject({ method: 'PUT', url: profileUrl, headers: auth(token), payload })
}
```

Required assertions:

```ts
it('可见但尚未填写时 GET 返回 revision 0 空档案', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/conversations/${conversationId}/customer-profile`,
    headers: auth(ownerToken),
  })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual(emptyCustomerProfile(conversationId))
})

it('PUT trim 字段、首建 revision 1 且只审计字段名', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/api/conversations/${conversationId}/customer-profile`,
    headers: auth(agentToken),
    payload: {
      name: '  Synthetic Name  ', ageLocation: null, occupation: null,
      family: null, interests: ' Synthetic Interest ', other: null,
      expectedRevision: 0,
    },
  })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toMatchObject({ name: 'Synthetic Name', interests: 'Synthetic Interest', revision: 1 })
})

it.each([
  ['outsider agent', outsiderToken],
  ['unrelated manager', unrelatedManagerToken],
])('%s 对不可见会话 GET/PUT 均为 404', async (_label, token) => {
  const get = await app.inject({ method: 'GET', url: profileUrl, headers: auth(token) })
  const put = await app.inject({ method: 'PUT', url: profileUrl, headers: auth(token), payload: validBody(0) })
  expect([get.statusCode, put.statusCode]).toEqual([404, 404])
})

it('同团队 manager 可写，auditor 可读但 PUT 为 403', async () => {
  expect((await app.inject({ method: 'PUT', url: profileUrl, headers: auth(managerToken), payload: validBody(0) })).statusCode)
    .toBe(200)
  expect((await app.inject({ method: 'GET', url: profileUrl, headers: auth(auditorToken) })).statusCode)
    .toBe(200)
  expect((await app.inject({ method: 'PUT', url: profileUrl, headers: auth(auditorToken), payload: validBody(1) })).statusCode)
    .toBe(403)
})

it('旧 revision 返回 409 和 currentRevision，不回显服务器正文', async () => {
  await putProfile(ownerToken, validBody(0))
  const res = await putProfile(ownerToken, { ...validBody(0), name: 'Stale Draft' })
  expect(res.statusCode).toBe(409)
  expect(res.json()).toEqual({ error: '档案已被其他人更新', currentRevision: 1 })
  expect(res.body).not.toContain('Synthetic Name')
})
```

Also cover: no token `401`; malformed conversation UUID `400`; extra key `400`; negative/non-integer revision `400`; name 201 code points `400`; other 2,001 code points `400`; whitespace becomes `null`; a second identical PUT keeps revision and audit count unchanged.

- [ ] **Step 2: Run routes to verify RED**

Run: `pnpm exec vitest run packages/server/src/api/routes/customer-profile.test.ts`

Expected: FAIL with route `404` or missing helpers.

- [ ] **Step 3: Implement strict Zod normalization and routes**

Build each field schema from the shared helpers:

```ts
function profileText(max: number) {
  return z.union([z.string(), z.null()])
    .transform(normalizeCustomerProfileText)
    .refine(value => value === null || customerProfileCodePointLength(value) <= max)
}

const customerProfileBody = z.object({
  name: profileText(CUSTOMER_PROFILE_MAX_CODE_POINTS.name),
  ageLocation: profileText(CUSTOMER_PROFILE_MAX_CODE_POINTS.ageLocation),
  occupation: profileText(CUSTOMER_PROFILE_MAX_CODE_POINTS.occupation),
  family: profileText(CUSTOMER_PROFILE_MAX_CODE_POINTS.family),
  interests: profileText(CUSTOMER_PROFILE_MAX_CODE_POINTS.interests),
  other: profileText(CUSTOMER_PROFILE_MAX_CODE_POINTS.other),
  expectedRevision: z.number().int().min(0),
}).strict()

const customerProfileParams = z.object({ id: z.string().uuid() })
```

Route result mapping:

```ts
app.get('/api/conversations/:id/customer-profile', async (req, reply) => {
  const params = customerProfileParams.safeParse(req.params)
  if (!params.success) return reply.code(400).send({ error: '客户档案请求无效' })
  const { id } = params.data
  const profile = await req.scoped.customerProfiles().get(id)
  if (!profile) return reply.code(404).send({ error: 'not found' })
  return profile
})

app.put('/api/conversations/:id/customer-profile', async (req, reply) => {
  if (req.actor.role === 'auditor') {
    return reply.code(403).send({ error: '风控账号是只读的，不能修改客户档案' })
  }
  const parsed = customerProfileBody.safeParse(req.body)
  if (!parsed.success) return reply.code(400).send({ error: '客户档案内容无效' })
  const params = customerProfileParams.safeParse(req.params)
  if (!params.success) return reply.code(400).send({ error: '客户档案请求无效' })
  const { id } = params.data
  const result = await req.scoped.customerProfiles().save(id, req.actor.userId, parsed.data)
  if (result.kind === 'not_found') return reply.code(404).send({ error: 'not found' })
  if (result.kind === 'conflict') {
    return reply.code(409).send({ error: '档案已被其他人更新', currentRevision: result.currentRevision })
  }
  return result.profile
})
```

Do not log `req.body`, parsed field values, or repo rows.

- [ ] **Step 4: Run GREEN and CORS regression**

Run: `pnpm exec vitest run packages/server/src/api/routes/customer-profile.test.ts packages/server/src/api/routes/conversations.test.ts packages/server/src/api/server.test.ts`

Expected: all tests PASS, including existing explicit `PUT` CORS behavior.

- [ ] **Step 5: Check and commit**

Run: `git diff --check`

Expected: no output.

```bash
git add packages/server/src/api/routes/conversations.ts packages/server/src/api/routes/customer-profile.test.ts
git commit -m "feat(server): expose customer profile API"
```

---

### Task 4: Desktop API Contract and Pure Editor Reducer

**Files:**
- Modify: `packages/desktop/src/renderer/api/client.ts`
- Modify: `packages/desktop/src/renderer/api/client.test.ts`
- Create: `packages/desktop/src/renderer/customer-profile-editor.ts`
- Create: `packages/desktop/src/renderer/customer-profile-editor.test.ts`

**Interfaces:**
- Consumes: Task 1 `CustomerProfile`, `CustomerProfileField`, `CustomerProfileUpdate`, `CustomerProfileValues`.
- Produces: `api.getCustomerProfile()`、`api.updateCustomerProfile()`、`CustomerProfileEditorState`、`CustomerProfileEditorAction`、`initialCustomerProfileEditorState()`、`reduceCustomerProfileEditor()`。

- [ ] **Step 1: Write failing desktop API tests**

Extend the existing fetch mock test:

```ts
it('客户档案 GET 与 PUT 使用内部 conversation id 和完整 revision body', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({
      token: 'test-token',
      user: { id: 'user-1', role: 'agent', displayName: 'Test' },
    }))
    .mockResolvedValueOnce(jsonResponse(emptyCustomerProfile('conversation-1')))
    .mockResolvedValueOnce(jsonResponse({
      ...emptyCustomerProfile('conversation-1'),
      name: 'Synthetic Name', revision: 1, updatedAt: '2026-09-02T00:00:00.000Z',
    }))
  vi.stubGlobal('fetch', fetchMock)
  await api.login('agent@example.com', 'dev-password')
  await api.getCustomerProfile('conversation-1')
  await api.updateCustomerProfile('conversation-1', {
    name: 'Synthetic Name', ageLocation: null, occupation: null,
    family: null, interests: null, other: null, expectedRevision: 0,
  })
  expect(fetchMock.mock.calls[1]?.[0]).toContain('/api/conversations/conversation-1/customer-profile')
  expect(fetchMock.mock.calls[1]?.[1]?.method).toBeUndefined()
  expect(fetchMock.mock.calls[2]?.[1]?.method).toBe('PUT')
  expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
    name: 'Synthetic Name', expectedRevision: 0,
  })
})
```

- [ ] **Step 2: Write failing reducer tests**

Define these test-local state builders before the assertions:

```ts
function loadedEditorState(profile: CustomerProfile): CustomerProfileEditorState {
  let state = initialCustomerProfileEditorState()
  state = reduceCustomerProfileEditor(state, {
    type: 'conversation.changed', conversationId: profile.conversationId,
  })
  state = reduceCustomerProfileEditor(state, {
    type: 'load.started', conversationId: profile.conversationId, requestId: 1, mode: 'replace',
  })
  return reduceCustomerProfileEditor(state, {
    type: 'load.succeeded', conversationId: profile.conversationId,
    requestId: 1, mode: 'replace', profile,
  })
}

function editingState(name: string): CustomerProfileEditorState {
  const loaded = loadedEditorState({
    ...emptyCustomerProfile('c'), name: 'Server', revision: 1,
  })
  return reduceCustomerProfileEditor(
    reduceCustomerProfileEditor(loaded, { type: 'edit.started' }),
    { type: 'draft.changed', field: 'name', value: name },
  )
}
```

```ts
it('切会话后忽略旧会话迟到响应', () => {
  let state = initialCustomerProfileEditorState()
  state = reduceCustomerProfileEditor(state, { type: 'conversation.changed', conversationId: 'a' })
  state = reduceCustomerProfileEditor(state, { type: 'load.started', conversationId: 'a', requestId: 1, mode: 'replace' })
  state = reduceCustomerProfileEditor(state, { type: 'conversation.changed', conversationId: 'b' })
  state = reduceCustomerProfileEditor(state, {
    type: 'load.succeeded', conversationId: 'a', requestId: 1,
    mode: 'replace', profile: { ...emptyCustomerProfile('a'), name: 'Stale' },
  })
  expect(state.conversationId).toBe('b')
  expect(state.snapshot).toBeNull()
})

it('取消编辑恢复服务器 snapshot', () => {
  const loaded = loadedEditorState({ ...emptyCustomerProfile('c'), name: 'Server', revision: 1 })
  const editing = reduceCustomerProfileEditor(
    reduceCustomerProfileEditor(loaded, { type: 'edit.started' }),
    { type: 'draft.changed', field: 'name', value: 'Draft' },
  )
  const cancelled = reduceCustomerProfileEditor(editing, { type: 'edit.cancelled' })
  expect(cancelled.draft.name).toBe('Server')
  expect(cancelled.status).toBe('viewing')
})

it('保存网络失败保留草稿', () => {
  const saving = editingState('Draft')
  const failed = reduceCustomerProfileEditor(
    reduceCustomerProfileEditor(saving, { type: 'save.started' }),
    { type: 'save.failed', message: '连不上服务端，请稍后重试' },
  )
  expect(failed.status).toBe('editing')
  expect(failed.draft.name).toBe('Draft')
})

it('冲突刷新更新 snapshot/revision 但保留本地草稿', () => {
  let state = editingState('Local Draft')
  state = reduceCustomerProfileEditor(state, { type: 'load.started', conversationId: 'c', requestId: 9, mode: 'conflict' })
  state = reduceCustomerProfileEditor(state, {
    type: 'load.succeeded', conversationId: 'c', requestId: 9, mode: 'conflict',
    profile: { ...emptyCustomerProfile('c'), name: 'Remote Value', revision: 2 },
  })
  expect(state.snapshot?.revision).toBe(2)
  expect(state.snapshot?.name).toBe('Remote Value')
  expect(state.draft.name).toBe('Local Draft')
  expect(state.status).toBe('editing')
  expect(state.error).toContain('其他人更新')
})

it('冲突刷新失败保留草稿并记住重试模式', () => {
  let state = editingState('Local Draft')
  state = reduceCustomerProfileEditor(state, {
    type: 'load.started', conversationId: 'c', requestId: 10, mode: 'conflict',
  })
  state = reduceCustomerProfileEditor(state, {
    type: 'load.failed', conversationId: 'c', requestId: 10,
    mode: 'conflict', message: '连不上服务端，请稍后重试',
  })
  expect(state.status).toBe('editing')
  expect(state.draft.name).toBe('Local Draft')
  expect(state.retryLoadMode).toBe('conflict')
})
```

- [ ] **Step 3: Run both test files to verify RED**

Run: `pnpm exec vitest run packages/desktop/src/renderer/api/client.test.ts packages/desktop/src/renderer/customer-profile-editor.test.ts`

Expected: FAIL because the API methods and reducer module do not exist.

- [ ] **Step 4: Add typed API methods with optional AbortSignal**

```ts
getCustomerProfile: (conversationId: string, signal?: AbortSignal) =>
  request<CustomerProfile>(`/api/conversations/${conversationId}/customer-profile`, { signal }),

updateCustomerProfile: (conversationId: string, update: CustomerProfileUpdate) =>
  request<CustomerProfile>(`/api/conversations/${conversationId}/customer-profile`, {
    method: 'PUT',
    body: JSON.stringify(update),
  }),
```

Import the profile types with `import type` from `@im-hub/shared`. Keep `HttpError.status` as the conflict discriminator; the UI always refetches the current profile after `409`, so client code must not expose server field contents from an error.

- [ ] **Step 5: Implement the pure reducer**

Use these exact public shapes:

```ts
export type CustomerProfileEditorStatus =
  | 'idle' | 'loading' | 'viewing' | 'editing' | 'saving' | 'failed'

export interface CustomerProfileEditorState {
  conversationId: string | null
  activeLoad: { conversationId: string; requestId: number; mode: 'replace' | 'conflict' } | null
  retryLoadMode: 'replace' | 'conflict' | null
  snapshot: CustomerProfile | null
  draft: CustomerProfileValues
  status: CustomerProfileEditorStatus
  error: string | null
}

export type CustomerProfileEditorAction =
  | { type: 'conversation.changed'; conversationId: string | null }
  | { type: 'load.started'; conversationId: string; requestId: number; mode: 'replace' | 'conflict' }
  | { type: 'load.succeeded'; conversationId: string; requestId: number; mode: 'replace' | 'conflict'; profile: CustomerProfile }
  | { type: 'load.failed'; conversationId: string; requestId: number; mode: 'replace' | 'conflict'; message: string }
  | { type: 'edit.started' }
  | { type: 'draft.changed'; field: CustomerProfileField; value: string }
  | { type: 'edit.cancelled' }
  | { type: 'save.started' }
  | { type: 'save.succeeded'; profile: CustomerProfile }
  | { type: 'save.failed'; message: string }
```

Reducer invariants:

- `conversation.changed` resets snapshot, draft, activeLoad, retryLoadMode and error; null becomes `idle`, non-null waits in `loading`;
- a response applies only when conversation id, request id and mode all equal `activeLoad`;
- normal load replaces snapshot and draft; conflict load keeps the editor active, replaces only snapshot, preserves draft, and sets the non-sensitive “档案已被其他人更新，请对照最新版本后再保存” message;
- a failed normal load enters `failed`; a failed conflict reload returns to editing and preserves the draft; both store their mode in `retryLoadMode`, and a later `load.started` clears it;
- `draft.changed` only changes a known shared field while editing;
- save failure returns to editing and preserves draft;
- save success replaces snapshot and draft and returns to viewing;
- cancel restores `draft` from snapshot.

- [ ] **Step 6: Run GREEN**

Run: `pnpm exec vitest run packages/desktop/src/renderer/api/client.test.ts packages/desktop/src/renderer/customer-profile-editor.test.ts`

Expected: all tests PASS.

- [ ] **Step 7: Check and commit**

Run: `git diff --check`

Expected: no output.

```bash
git add packages/desktop/src/renderer/api/client.ts packages/desktop/src/renderer/api/client.test.ts packages/desktop/src/renderer/customer-profile-editor.ts packages/desktop/src/renderer/customer-profile-editor.test.ts
git commit -m "feat(desktop): add customer profile editor state"
```

---

### Task 5: Wire the Customer Profile Section into the Right Panel

**Files:**
- Create: `packages/desktop/src/renderer/components/CustomerProfileSection.tsx`
- Create: `packages/desktop/src/renderer/components/CustomerProfileSection.test.ts`
- Modify: `packages/desktop/src/renderer/components/CustomerPanel.tsx`

**Interfaces:**
- Consumes: Task 4 API methods and reducer；`getCurrentUser()`；`HttpError`、`NetworkError`；Task 1 field constants.
- Produces: `CustomerProfileSection` side-effect container and exported pure `CustomerProfileSectionView`.

- [ ] **Step 1: Write failing server-rendered view tests**

Use `renderToStaticMarkup` from `react-dom/server`; do not add a new test dependency.

Define the component-test state helpers through the public reducer API instead of constructing private state fields by hand:

```tsx
function loadedEditorState(profile: CustomerProfile): CustomerProfileEditorState {
  let state = initialCustomerProfileEditorState()
  state = reduceCustomerProfileEditor(state, {
    type: 'conversation.changed', conversationId: profile.conversationId,
  })
  state = reduceCustomerProfileEditor(state, {
    type: 'load.started', conversationId: profile.conversationId, requestId: 1, mode: 'replace',
  })
  return reduceCustomerProfileEditor(state, {
    type: 'load.succeeded', conversationId: profile.conversationId,
    requestId: 1, mode: 'replace', profile,
  })
}

function conflictEditorState(input: {
  localName: string
  remoteRevision: number
}): CustomerProfileEditorState {
  let state = loadedEditorState({
    ...emptyCustomerProfile('c'), name: 'Server', revision: 1,
  })
  state = reduceCustomerProfileEditor(state, { type: 'edit.started' })
  state = reduceCustomerProfileEditor(state, {
    type: 'draft.changed', field: 'name', value: input.localName,
  })
  state = reduceCustomerProfileEditor(state, {
    type: 'load.started', conversationId: 'c', requestId: 2, mode: 'conflict',
  })
  return reduceCustomerProfileEditor(state, {
    type: 'load.succeeded', conversationId: 'c', requestId: 2, mode: 'conflict',
    profile: {
      ...emptyCustomerProfile('c'), name: 'Remote Value', revision: input.remoteRevision,
    },
  })
}
```

```tsx
it('查看态显示服务器档案并为可写角色提供手动补充', () => {
  const html = renderToStaticMarkup(
    <CustomerProfileSectionView
      state={loadedEditorState({ ...emptyCustomerProfile('c'), name: 'Synthetic Name', revision: 1 })}
      readOnly={false}
      onEdit={() => {}}
      onCancel={() => {}}
      onSave={() => {}}
      onRetry={() => {}}
      onFieldChange={() => {}}
    />,
  )
  expect(html).toContain('Synthetic Name')
  expect(html).toContain('手动补充')
  expect(html).toContain('重新提取（后续 M4）')
})

it('auditor 查看态不渲染编辑入口', () => {
  const html = renderToStaticMarkup(
    <CustomerProfileSectionView
      state={loadedEditorState(emptyCustomerProfile('c'))}
      readOnly
      onEdit={() => {}}
      onCancel={() => {}}
      onSave={() => {}}
      onRetry={() => {}}
      onFieldChange={() => {}}
    />,
  )
  expect(html).not.toContain('手动补充')
  expect(html).toContain('只读')
})

it('编辑态保留冲突草稿并显示最新版本提示', () => {
  const state = conflictEditorState({ localName: 'Local Draft', remoteRevision: 2 })
  const html = renderToStaticMarkup(
    <CustomerProfileSectionView
      state={state}
      readOnly={false}
      onEdit={() => {}}
      onCancel={() => {}}
      onSave={() => {}}
      onRetry={() => {}}
      onFieldChange={() => {}}
    />,
  )
  expect(html).toContain('Local Draft')
  expect(html).toContain('其他人更新')
  expect(html).toContain('保存')
})
```

Also test loading, initial load failure with a “重试加载” button, conflict reload failure with the same retry action while the local draft remains visible, disabled buttons while saving or reloading a conflict, and “尚未填写” for null fields.

- [ ] **Step 2: Run the view tests to verify RED**

Run: `pnpm exec vitest run packages/desktop/src/renderer/components/CustomerProfileSection.test.ts`

Expected: FAIL because the component module does not exist.

- [ ] **Step 3: Implement side-effect orchestration**

`CustomerProfileSection` receives `{ conversationId: string; readOnly: boolean }`, owns `useReducer(reduceCustomerProfileEditor, initialCustomerProfileEditorState())`, an incrementing request id ref, an `activeConversationIdRef` updated on every render, and the current `AbortController`.

Extract one `loadProfile(targetConversationId, mode)` callback used by the conversation effect, the retry button, and conflict handling. It must abort the prior controller, create a new controller/request id, dispatch `load.started`, and then dispatch the matching success/failure action. `onRetry` calls it only when `state.retryLoadMode` is non-null and the active conversation still matches.

Conversation effect:

```ts
const loadProfile = useCallback((
  targetConversationId: string,
  mode: 'replace' | 'conflict',
) => {
  controllerRef.current?.abort()
  const controller = new AbortController()
  controllerRef.current = controller
  const requestId = ++requestIdRef.current
  dispatch({ type: 'load.started', conversationId: targetConversationId, requestId, mode })
  void api.getCustomerProfile(targetConversationId, controller.signal).then(profile => {
    dispatch({
      type: 'load.succeeded', conversationId: targetConversationId,
      requestId, mode, profile,
    })
  }).catch(error => {
    if (controller.signal.aborted) return
    dispatch({
      type: 'load.failed', conversationId: targetConversationId,
      requestId, mode, message: customerProfileErrorMessage(error),
    })
  })
}, [])

activeConversationIdRef.current = conversationId

useEffect(() => {
  dispatch({ type: 'conversation.changed', conversationId })
  loadProfile(conversationId, 'replace')
  return () => controllerRef.current?.abort()
}, [conversationId, loadProfile])
```

Save behavior:

1. Return immediately for readOnly, missing snapshot, non-editing state, saving state, or any active profile reload. This makes double-clicks and conflict-reload overlap no-ops.
2. Dispatch `save.started` and call `api.updateCustomerProfile(conversationId, { ...draft, expectedRevision: snapshot.revision })`.
3. On success dispatch `save.succeeded` only if `activeConversationIdRef.current === conversationId`.
4. On `HttpError` status 409, and only while that same guard still matches, start a new `mode:'conflict'` GET; conflict load preserves draft and replaces snapshot/revision.
5. On other errors dispatch `save.failed` only while the same guard matches; use a Chinese non-sensitive message and do not log draft or response body. This prevents a late save result from entering a newly selected conversation.

`customerProfileErrorMessage()` mapping:

```ts
if (error instanceof NetworkError) return '连不上服务端，请稍后重试'
if (error instanceof HttpError && error.status === 403) return '当前账号只有只读权限'
if (error instanceof HttpError && error.status === 404) return '当前会话不可见或已被删除'
return '客户档案操作失败，请稍后重试'
```

- [ ] **Step 4: Implement the pure view**

Keep UI field metadata local and derive keys from `CustomerProfileField`:

```ts
const PROFILE_FIELDS: ReadonlyArray<{
  key: CustomerProfileField
  label: string
  hint: string
  singleLine: boolean
}> = [
  { key: 'name', label: '姓名', hint: '客户自称或签名里出现的名字', singleLine: true },
  { key: 'ageLocation', label: '年龄 / 居住地', hint: '年龄段、城市、国家或时区', singleLine: false },
  { key: 'occupation', label: '职业 / 退休状况', hint: '在职、行业，或已退休', singleLine: false },
  { key: 'family', label: '家庭 / 婚姻状况', hint: '同住家人、子女、婚姻', singleLine: false },
  { key: 'interests', label: '兴趣', hint: '反复提到的爱好与话题', singleLine: false },
  { key: 'other', label: '其他', hint: '不属于以上几类但值得记的', singleLine: false },
]
```

Use `<input>` for `name`, `<textarea>` for the other five fields, controlled from `state.draft`. Apply `maxLength` only as a convenience; server code-point validation remains authoritative. Show snapshot values with `textContent` through normal React rendering, never `dangerouslySetInnerHTML`.

The view must expose:

- loading hint and a “重试加载” action whenever `retryLoadMode` is non-null;
- “尚未填写” for null viewing values;
- no edit button for auditor;
- “取消” and “保存” in editing mode;
- disabled save/cancel while saving or while a conflict reload is active;
- conflict/error message without server field contents;
- permanently disabled “重新提取（后续 M4）” button.

- [ ] **Step 5: Replace the placeholder block in `CustomerPanel`**

Import `getCurrentUser` and render:

```tsx
<CustomerProfileSection
  conversationId={conv.id}
  readOnly={getCurrentUser()?.role === 'auditor'}
/>
```

Remove the old local `PROFILE_FIELDS`, `NotWired` badge, explanatory “服务端目前没有存档案的表” card, and disabled “手动补充” button. Keep the identity and “互动情况” sections unchanged. Update the no-conversation native hint to “请先在原生客户端打开一个会话”。

- [ ] **Step 6: Run GREEN and desktop regressions**

Run: `pnpm exec vitest run packages/desktop/src/renderer/components/CustomerProfileSection.test.ts packages/desktop/src/renderer/customer-profile-editor.test.ts packages/desktop/src/renderer/api/client.test.ts packages/desktop/src/renderer/store.test.ts`

Expected: all tests PASS.

Run: `pnpm --filter @im-hub/desktop build`

Expected: main, preload, and renderer bundles build successfully.

- [ ] **Step 7: Check and commit**

Run: `git diff --check`

Expected: no output.

```bash
git add packages/desktop/src/renderer/components/CustomerProfileSection.tsx packages/desktop/src/renderer/components/CustomerProfileSection.test.ts packages/desktop/src/renderer/components/CustomerPanel.tsx
git commit -m "feat(desktop): wire customer profile panel"
```

---

### Task 6: Documentation, Full Verification, and Handoff

**Files:**
- Modify: `docs/RUNBOOK.md`
- Modify: `docs/superpowers/specs/2026-09-02-m4-customer-profile-design.md`
- Modify: `docs/superpowers/plans/2026-09-02-m4-customer-profile.md`

**Interfaces:**
- Consumes: Tasks 1–5 behavior and fresh verification evidence.
- Produces: accurate operational status, completion checkpoint, clean branch ready for review.

- [ ] **Step 1: Update RUNBOOK without overstating scope**

Add an M4 customer profile section recording:

- manual read/edit/save is wired to internal conversation UUIDs;
- owner/auditor/manager/agent visibility rules and auditor read-only behavior;
- optimistic `revision` conflict behavior;
- audit contains changed field names but no old/new values;
- automatic extraction, profile library, audit query UI, keyword alerts and management UI are still not implemented;
- WhatsApp Web DOM text is not centrally archived by this feature;
- no platform send or message ID behavior changed.

- [ ] **Step 2: Update the design status and append implementation evidence**

Change the spec header to `状态：已实现，待 PR 复核` only after all code and focused tests pass. Append a checkpoint section containing exact focused/full test counts from the fresh final runs, migration number, commit list, and sensitive-data boundary. Do not paste synthetic profile values from tests into the checkpoint.

- [ ] **Step 3: Run focused customer profile regression**

Run: `pnpm exec vitest run packages/shared/src/customer-profile.test.ts packages/server/src/customer-profile/repo.test.ts packages/server/src/api/routes/customer-profile.test.ts packages/desktop/src/renderer/api/client.test.ts packages/desktop/src/renderer/customer-profile-editor.test.ts packages/desktop/src/renderer/components/CustomerProfileSection.test.ts`

Expected: every customer profile test passes with zero failures.

- [ ] **Step 4: Run full typecheck**

Run: `pnpm typecheck`

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 5: Run complete test suite against only the fixed test database**

Run: `pnpm test`

Expected: all test files pass; the one existing `todo` may remain. If sandbox denies localhost PostgreSQL with `EPERM`, rerun the identical command with the already-approved local test-database permission; do not source `.env`.

- [ ] **Step 6: Run desktop production build**

Run: `pnpm --filter @im-hub/desktop build`

Expected: exit 0 for main, preload, and renderer bundles.

- [ ] **Step 7: Verify scope and sensitive files**

Run: `git status --short`

Expected: only intended source, test, migration, spec, plan, and RUNBOOK files.

Run: `git diff --check`

Expected: no output.

Run: `git diff --name-only origin/main...HEAD`

Expected: no `.env`, `data/`, `out/`, platform profile/session, generated app bundle, or unrelated platform patch files.

- [ ] **Step 8: Commit documentation**

```bash
git add docs/RUNBOOK.md docs/superpowers/specs/2026-09-02-m4-customer-profile-design.md docs/superpowers/plans/2026-09-02-m4-customer-profile.md
git commit -m "docs: record M4 customer profile completion"
```

- [ ] **Step 9: Re-run post-commit evidence and report**

Run: `pnpm typecheck`

Run: `pnpm test`

Run: `pnpm --filter @im-hub/desktop build`

Run: `git status --short --branch`

Expected: all verification commands exit 0 and the worktree is clean. Do not claim automatic extraction, full audit, alerts, management UI, package delivery, or production rollout complete.
