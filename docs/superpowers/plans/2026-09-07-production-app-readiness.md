# Production Application Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Fastify application safe to expose through the production Caddy/Cloudflare path with validated configuration, health probes, Redis-backed authentication limits, and a one-time owner bootstrap.

**Architecture:** Refactor environment parsing into a testable production-aware boundary, inject health/rate-limit dependencies into `buildServer`, and keep bootstrap as a separate CLI that can only transact against an empty database. Caddy is the sole network hop to the application, so Fastify trusts exactly one proxy hop and rate-limit keys use normalized client IP plus a hash of normalized email.

**Tech Stack:** TypeScript ESM, Fastify 5, `@fastify/rate-limit` 11.2.0+, ioredis, Kysely/PostgreSQL, Argon2id, Vitest, pnpm 10.

**Spec:** `docs/superpowers/specs/2026-09-07-production-server-deployment-design.md`

## Global Constraints

- Complete `2026-09-07-translation-provider-choice.md` first; migration `0017` and the provider factory must already exist.
- Work only in `/private/tmp/im-hub-m3-outbox`; do not modify either main checkout or any production server during this plan.
- Use Node.js 22+ and pnpm 10; production mode is explicit and must reject development placeholder secrets.
- Use `@fastify/rate-limit` version `>=11.2.0` because earlier versions have an IPv6 key-normalization bypass; keep `ipv6Subnet: 64`. See the [official compatibility table](https://github.com/fastify/fastify-rate-limit#compatibility) and [security advisory](https://github.com/fastify/fastify-rate-limit/security/advisories/GHSA-grpc-p53c-r64v).
- Trust one proxy hop only when production config says so; do not trust arbitrary public forwarding headers.
- Never print or commit password values, database/Redis/JWT/provider secrets, token contents, customer text, QR, code, 2FA, or platform sessions.
- Health responses contain status only, not version, account count, connection strings, queues, errors, or stack traces.
- Production owner bootstrap reads the password without echo and refuses any non-empty user table.

---

### Task 1: Add testable production configuration validation

**Files:**
- Create: `packages/server/src/config.test.ts`
- Modify: `packages/server/src/config.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `parseConfig(env: NodeJS.ProcessEnv): Config`.
- Produces: `APP_ENV: 'development' | 'test' | 'production'`, `PUBLIC_ORIGIN`, `TRUST_PROXY_HOPS`.
- Consumes: provider configuration from the translation plan.

- [ ] **Step 1: Write failing production config tests**

```ts
const minimumEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://imhub:synthetic-production-password@db:5432/imhub',
  REDIS_URL: 'redis://:synthetic-production-password@redis:6379',
  JWT_SECRET: 'synthetic-production-jwt-secret-with-more-than-32-characters',
}

it('accepts an exact HTTPS production origin and one trusted proxy hop', () => {
  const config = parseConfig({
    ...minimumEnv,
    APP_ENV: 'production',
    PUBLIC_ORIGIN: 'https://imhub.jojo2333.net',
    TRUST_PROXY_HOPS: '1',
  })
  expect(config.PUBLIC_ORIGIN).toBe('https://imhub.jojo2333.net')
  expect(config.TRUST_PROXY_HOPS).toBe(1)
})

it.each([
  'http://imhub.jojo2333.net',
  'https://user@imhub.jojo2333.net',
  'https://imhub.jojo2333.net/path',
])('rejects unsafe production origin %s', origin => {
  expect(() => parseConfig({ ...minimumEnv, APP_ENV: 'production', PUBLIC_ORIGIN: origin }))
    .toThrow('PUBLIC_ORIGIN')
})
```

Also assert production rejects `JWT_SECRET=change-me-in-production`, the development DB password/URL, `TRUST_PROXY_HOPS` other than `1`, and `WHATSAPP_CLOUD_ENABLED=true` when the internal Web-only release policy is active.

- [ ] **Step 2: Run config tests and verify missing parser failures**

Run: `pnpm exec vitest run packages/server/src/config.test.ts`

Expected: FAIL because `parseConfig` and production fields do not exist.

- [ ] **Step 3: Refactor schema parsing without weakening current validation**

```ts
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  return schema.superRefine((value, ctx) => {
    if (value.APP_ENV !== 'production') return
    assertExactHttpsOrigin(value.PUBLIC_ORIGIN, ctx)
    if (value.TRUST_PROXY_HOPS !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['TRUST_PROXY_HOPS'], message: 'production requires one trusted proxy hop' })
    }
  }).parse(env)
}

export const config = parseConfig(process.env)
```

Keep the existing WhatsApp Cloud cross-field validation. `.env.example` lists `APP_ENV=development`, `PUBLIC_ORIGIN=` and `TRUST_PROXY_HOPS=0` with no real secrets.

- [ ] **Step 4: Run config and current server tests**

Run: `pnpm exec vitest run packages/server/src/config.test.ts packages/server/src/api/server.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit configuration validation**

```bash
git add packages/server/src/config.ts packages/server/src/config.test.ts .env.example
git commit -m "feat(server): validate production runtime config"
```

### Task 2: Add minimal liveness and readiness probes

**Files:**
- Create: `packages/server/src/api/routes/health.ts`
- Create: `packages/server/src/api/routes/health.test.ts`
- Modify: `packages/server/src/api/server.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Produces: `HealthChecks` with `database()`, `redis()`, `initialized()`.
- Produces: public `GET /health/live` and `GET /health/ready`.
- Consumes: existing PostgreSQL `db` and a dedicated Redis check connection.

- [ ] **Step 1: Write failing probe tests**

```ts
it('returns only a minimal ready status', async () => {
  const response = await app.inject({ method: 'GET', url: '/health/ready' })
  expect(response.statusCode).toBe(200)
  expect(response.json()).toEqual({ status: 'ready' })
})

it('returns 503 without exposing dependency errors', async () => {
  checks.database.mockRejectedValue(new Error('sensitive connection detail'))
  const response = await app.inject({ method: 'GET', url: '/health/ready' })
  expect(response.statusCode).toBe(503)
  expect(response.json()).toEqual({ status: 'not_ready' })
  expect(response.body).not.toContain('sensitive')
})
```

Also assert `/health/live` remains 200 when a dependency fails and both routes work without Authorization.

- [ ] **Step 2: Run the test and verify 401/404 failures**

Run: `pnpm exec vitest run packages/server/src/api/routes/health.test.ts`

Expected: FAIL because public health routes are not registered.

- [ ] **Step 3: Implement the small route module**

```ts
export interface HealthChecks {
  database(): Promise<void>
  redis(): Promise<void>
  initialized(): boolean
}

app.get('/health/live', async () => ({ status: 'live' }))
app.get('/health/ready', async (_req, reply) => {
  try {
    if (!checks.initialized()) throw new Error('not initialized')
    await Promise.all([checks.database(), checks.redis()])
    return { status: 'ready' }
  } catch {
    return reply.code(503).send({ status: 'not_ready' })
  }
})
```

Register these routes before the authentication hook or explicitly allow only these exact paths. In production, use `select 1`, Redis `PING`, and an initialization boolean that becomes true after server lifecycle setup; Telegram/provider health is not readiness.

- [ ] **Step 4: Run health and authentication hook tests**

Run: `pnpm exec vitest run packages/server/src/api/routes/health.test.ts packages/server/src/api/server.test.ts`

Expected: PASS; unrelated unauthenticated APIs still return 401.

- [ ] **Step 5: Commit health endpoints**

```bash
git add packages/server/src/api/routes/health.ts packages/server/src/api/routes/health.test.ts packages/server/src/api/server.ts packages/server/src/index.ts
git commit -m "feat(server): expose minimal health probes"
```

### Task 3: Add proxy-safe Redis-backed authentication limits

**Files:**
- Create: `packages/server/src/api/rate-limit.ts`
- Create: `packages/server/src/api/rate-limit.test.ts`
- Modify: `packages/server/src/api/routes/auth.ts`
- Modify: `packages/server/src/api/routes/auth.test.ts`
- Modify: `packages/server/src/api/server.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `AuthRateLimits.guardLogin(req, reply)` and `guardPasswordChange(req, reply)` pre-handlers.
- Consumes: an ioredis client with short connection timeout and `maxRetriesPerRequest: 1`.
- Produces: stable 429 body `{ error: 'too many requests', retryAfterSeconds: number }`.

- [ ] **Step 1: Install the patched plugin version**

Run: `pnpm --filter @im-hub/server add @fastify/rate-limit@^11.2.0`

Expected: `packages/server/package.json` and `pnpm-lock.yaml` change; no npm/yarn lockfile appears.

- [ ] **Step 2: Write failing key and route tests**

```ts
it('normalizes email and hashes it before composing a login bucket', () => {
  const key = loginAccountKey('2001:db8::1', ' User@Example.COM ')
  expect(key).toMatch(/^login-account:2001:db8:::[a-f0-9]{64}$/)
  expect(key).not.toContain('user@example.com')
})

it('rejects the eleventh login in fifteen minutes with the same body for known and unknown users', async () => {
  for (let index = 0; index < 10; index++) await login('missing@example.test', 'synthetic')
  const blocked = await login('missing@example.test', 'synthetic')
  expect(blocked.statusCode).toBe(429)
  expect(blocked.json().error).toBe('too many requests')
})
```

Add proxy tests proving `TRUST_PROXY_HOPS=0` ignores injected XFF and `TRUST_PROXY_HOPS=1` uses exactly the right-most address supplied by the sole Caddy hop. Include IPv4-mapped IPv6 and `/64` IPv6 rotation cases.

- [ ] **Step 3: Run focused tests and verify the missing limiter**

Run: `pnpm exec vitest run packages/server/src/api/rate-limit.test.ts packages/server/src/api/routes/auth.test.ts packages/server/src/api/server.test.ts`

Expected: FAIL because no limiter is registered and repeated logins stay 401.

- [ ] **Step 4: Implement two login buckets and a password bucket**

Register `@fastify/rate-limit` with `global: false`, Redis, `skipOnError: false`, and `ipv6Subnet: 64`. Build two manual login checks: 30 requests/15 minutes per normalized IP and 10 requests/15 minutes per `(normalized IP, SHA-256(normalized email))`. Use a separate 10 requests/15 minutes password-change group keyed by normalized IP plus authenticated user id.

```ts
const emailHash = createHash('sha256')
  .update(email.trim().toLowerCase(), 'utf8').digest('hex')
return `login-account:${normalizeIP(request.ip, 64)}:${emailHash}`
```

Run both login guards after body parsing but before database/password work. Return identical invalid-credential responses for nonexistent, disabled, expired, and wrong-password cases. Never log the rate-limit key.

- [ ] **Step 5: Wire one trusted Caddy hop and verify**

Configure Fastify with `trustProxy: config.TRUST_PROXY_HOPS === 0 ? false : 1`. Production `index.ts` passes a dedicated Redis connection for rate limiting; tests use an isolated/in-memory store and fake clock.

Run: `pnpm exec vitest run packages/server/src/api/rate-limit.test.ts packages/server/src/api/routes/auth.test.ts packages/server/src/api/server.test.ts`

Expected: PASS, including Redis error fail-closed behavior on auth routes.

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the limiter**

```bash
git add packages/server/package.json pnpm-lock.yaml packages/server/src/api packages/server/src/index.ts
git commit -m "feat(server): rate limit authentication routes"
```

### Task 4: Add a one-time empty-database owner bootstrap

**Files:**
- Create: `packages/server/src/db/bootstrap-owner-service.ts`
- Create: `packages/server/src/db/bootstrap-owner-service.test.ts`
- Create: `packages/server/src/db/bootstrap-owner.ts`
- Create: `packages/server/src/db/hidden-input.ts`
- Create: `packages/server/src/db/hidden-input.test.ts`
- Modify: `packages/server/package.json`

**Interfaces:**
- Produces: `bootstrapOwner(db, { email, displayName, password, now }): Promise<{ id: string }>`.
- Produces: interactive CLI `pnpm --filter @im-hub/server bootstrap-owner` with email/display-name prompts and hidden password prompts.
- Consumes: existing `hashPassword`, `must_change_password`, `temporary_password_expires_at`, and single-enabled-owner DB constraint.

- [ ] **Step 1: Write failing service tests**

```ts
const fixedNow = new Date('2026-09-07T00:00:00.000Z')
const validInput = {
  email: 'owner@example.test',
  displayName: '管理员',
  password: 'synthetic-temporary-password',
  now: fixedNow,
}

it('creates exactly one forced-change owner in an empty database', async () => {
  await bootstrapOwner(db, {
    email: 'owner@example.test', displayName: '管理员',
    password: 'synthetic-temporary-password', now: fixedNow,
  })
  const owner = await db.selectFrom('users').selectAll().executeTakeFirstOrThrow()
  expect(owner).toMatchObject({
    email: 'owner@example.test', role: 'owner', must_change_password: true,
  })
  expect(owner.temporary_password_expires_at?.toISOString())
    .toBe('2026-09-08T00:00:00.000Z')
})

it('refuses any non-empty users table without changing rows', async () => {
  await expect(bootstrapOwner(db, validInput)).rejects.toThrow('database is not empty')
  expect(await db.selectFrom('users').select('id').execute()).toHaveLength(1)
})
```

Add concurrent execution coverage: two calls race, one succeeds and one refuses, leaving exactly one owner.

- [ ] **Step 2: Run tests and verify the service is missing**

Run: `pnpm exec vitest run packages/server/src/db/bootstrap-owner-service.test.ts`

Expected: FAIL because `bootstrapOwner` does not exist.

- [ ] **Step 3: Implement the transactional service**

```ts
await db.transaction().execute(async trx => {
  await sql`select pg_advisory_xact_lock(hashtext('im-hub-bootstrap-owner'))`.execute(trx)
  const existing = await trx.selectFrom('users').select(({ fn }) => fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow()
  if (Number(existing.count) !== 0) throw new BootstrapOwnerError('database is not empty')
  await trx.insertInto('users').values({
    email: normalizedEmail,
    display_name: displayName.trim(),
    role: 'owner',
    password_hash: await hashPassword(password),
    must_change_password: true,
    temporary_password_expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000),
  }).execute()
})
```

Validate email, display-name length and 12–128 Unicode code points before hashing. The CLI accepts no email or
password values in process argv; it prompts for email and display name normally and passwords without echo.

- [ ] **Step 4: Implement and test hidden terminal input**

`hidden-input.ts` temporarily disables terminal echo, reads two password entries, restores terminal state in `finally`, and throws if stdin is not an interactive TTY. Its test uses injected input/output adapters and asserts output contains prompts/newlines but never the synthetic password.

```ts
const password = await readHiddenLine('临时密码：')
const confirmation = await readHiddenLine('再次输入：')
if (password !== confirmation) throw new Error('两次输入不一致')
```

Run: `pnpm exec vitest run packages/server/src/db/bootstrap-owner-service.test.ts packages/server/src/db/hidden-input.test.ts packages/server/src/api/routes/auth.test.ts`

Expected: PASS and no test output contains the password sentinel.

- [ ] **Step 5: Add the CLI script and commit**

Add package script:

```json
"bootstrap-owner": "tsx src/db/bootstrap-owner.ts"
```

The CLI prints only success/failure and the created email; it never prints password/hash/token. It closes DB handles in `finally`.

```bash
git add packages/server/src/db packages/server/package.json
git commit -m "feat(server): bootstrap the first production owner"
```

### Task 5: Add a non-secret production preflight

**Files:**
- Create: `packages/server/src/production/preflight.ts`
- Create: `packages/server/src/production/preflight.test.ts`
- Modify: `packages/server/package.json`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Produces: `runProductionPreflight(config, dependencies): Promise<PreflightResult>`.
- Produces: package script `preflight:production` that prints checks as `ok`/`missing` only.

- [ ] **Step 1: Write failing preflight tests**

```ts
it('reports readiness without echoing values', async () => {
  const result = await runProductionPreflight(config, checks)
  expect(result).toEqual({
    database: 'ok', redis: 'ok', migrations: 'ok',
    deepl: 'ok', claude: 'ok', openai: 'ok', telegram: 'ok',
    whatsappCloudDisabled: 'ok',
  })
  expect(JSON.stringify(result)).not.toContain(config.JWT_SECRET)
})
```

Add failures for unapplied migrations, any missing provider, missing Telegram pair, WhatsApp Cloud enabled, and organization admin writes disabled for the post-bootstrap production stage.

- [ ] **Step 2: Run and verify missing preflight behavior**

Run: `pnpm exec vitest run packages/server/src/production/preflight.test.ts`

Expected: FAIL because the production preflight does not exist.

- [ ] **Step 3: Implement read-only checks**

Use `select 1`, Redis `PING`, Kysely migration status, Boolean configuration presence and exact policy flags. Return structured names/status only. The CLI exits nonzero on any missing item and does not make schema, user, account, or secret changes.

- [ ] **Step 4: Run preflight and lifecycle tests**

Run: `pnpm exec vitest run packages/server/src/production/preflight.test.ts packages/server/src/keyword-alert/runtime.test.ts packages/server/src/api/routes/health.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit preflight**

```bash
git add packages/server/src/production packages/server/package.json packages/server/src/index.ts
git commit -m "feat(server): add production readiness preflight"
```

### Task 6: Application-readiness regression checkpoint

**Files:**
- Modify: `docs/RUNBOOK.md`
- Test: configuration, health, auth, bootstrap, migrations, translation, native control, full repository.

**Interfaces:**
- Consumes: Tasks 1–5 and the completed translation-provider plan.
- Produces: application SHA ready for the container-runtime plan.

- [ ] **Step 1: Document production-only commands and boundaries**

Add a production section describing `preflight:production`, interactive `bootstrap-owner`, health paths, one trusted Caddy hop, rate limits, no seed, and provider availability. Show variable names only.

- [ ] **Step 2: Run focused server verification**

Run: `pnpm exec vitest run packages/server/src/config.test.ts packages/server/src/api/rate-limit.test.ts packages/server/src/api/routes/health.test.ts packages/server/src/api/routes/auth.test.ts packages/server/src/db/bootstrap-owner-service.test.ts packages/server/src/db/hidden-input.test.ts packages/server/src/production/preflight.test.ts`

Expected: PASS.

- [ ] **Step 3: Run full verification**

Run: `pnpm typecheck`

Expected: PASS.

Run: `pnpm test`

Expected: PASS against the explicitly derived test database, never production.

Run: `pnpm --filter @im-hub/desktop build`

Expected: PASS.

- [ ] **Step 4: Inspect the final change set**

Run: `git diff --check && git status --short && git diff --name-only`

Expected: no `.env`, secret, database dump, TDLib/Signal/WhatsApp session, build output, QR, code, or credential file.

- [ ] **Step 5: Commit the readiness documentation**

```bash
git add docs/RUNBOOK.md
git commit -m "docs: document production application readiness"
```
