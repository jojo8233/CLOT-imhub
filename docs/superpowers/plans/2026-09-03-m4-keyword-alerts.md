# Internal Keyword Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an internal-only, RBAC-scoped keyword alert loop for new inbound central messages, including reliable literal matching, per-recipient acknowledgement, owner-only rule management, WebSocket hints, and a desktop alert center.

**Architecture:** Add shared rule/alert contracts and four PostgreSQL tables, enqueue a durable scan row in the same transaction as every accepted inbound message revision, and process rows with a pure TypeScript Aho-Corasick matcher. Persist one alert per message/rule and fixed recipient rows, reapply current `ScopedDb` visibility on every read, then expose strict internal APIs and a reducer-backed desktop view with an in-app badge and toast.

**Tech Stack:** Node.js 22+, pnpm 10, TypeScript ESM, Fastify 5, Zod, Kysely/PostgreSQL, React 19, Zustand, Vitest, Electron 33/electron-vite.

**Spec:** `docs/superpowers/specs/2026-09-03-m4-keyword-alerts-design.md`

## Global Constraints

- Work only in `/private/tmp/im-hub-m3-outbox` on branch `codex/m4-keyword-alerts`; do not modify the main checkout or create another worktree.
- Base implementation work on `origin/main` merge commit `dd6429a886efd6f4c8f5d097f29324f31e8101da` plus design commit `d548c53`.
- Before implementation, read `AGENTS.md`, the linked spec, `docs/superpowers/specs/2026-08-25-native-client-pivot.md`, and current `package.json` completely.
- Use Node.js 22+ and pnpm 10. Do not generate npm or yarn lockfiles.
- Keep strict TypeScript ESM conventions: relative source imports use `.js`, type-only imports use `import type`, and do not add `any`, `@ts-ignore`, or non-null assertions.
- Business reads must enter through `req.scoped`/`ScopedDb`; route modules must not import the global `db`.
- Rules are global company rules and owner-only. Manager, auditor, and agent must not read or mutate the rule catalog.
- Match only literal patterns against newly accepted non-empty inbound message bodies and later accepted edits. Do not scan migration history or outbound messages.
- `owner`, lead-team `manager`, and account-owner `agent` receive independent acknowledgement rows. `auditor` receives a global read-only feed without acknowledgement state or badge.
- Recipient snapshots never expand retroactively, but every alert read must still pass the actor's current account scope.
- WebSocket hints and logs must not contain keyword text, body, excerpt, account/conversation/user identifiers, platform message keys, media references, tokens, QR links, verification codes, 2FA passwords, or platform profile/session data.
- Do not read or print `.env`; inspect only `.env.example` when variable names are required.
- Do not modify Telegram/Signal/WhatsApp guest/preload code, native rendering, translation coordinators, composers, send attempts, message-ID algorithms, or WhatsApp DOM scope.
- WhatsApp `web_shell` remains outside keyword alerts because its DOM messages are not centrally archived. Only configured `cloud_api` webhook messages can participate.
- Do not send real Telegram, Signal, or WhatsApp messages. Real platform acceptance requires a separate explicit authorization.
- Database tests use only the existing fixed `_test` database through `testDatabaseUrl()` and clean new tables before parent rows.
- Before server, database, or test commands, load the root environment without displaying it, exactly as required by `AGENTS.md`: run `set -a`, then `. ./.env`, then `set +a` in the same shell. Never inspect, echo, log, or commit `.env` values.
- Do not apply migration `0015` to an unspecified development database. Automated migration tests are required; a real development migration needs explicit target confirmation.
- Every implementation task follows red-green TDD, ends with focused verification, and creates one focused commit.

---

## Specification Coverage

- Spec §§1-3 and §12 (internal-only scope, supported central-message boundary, and prohibited platform changes): enforced by Global Constraints, Tasks 4, 8, 10, and 11.
- Spec §4 (global literal rules, normalization, edit semantics, optimistic revisions, and no backfill): Tasks 1, 3, 4, 5, and 6.
- Spec §5 (transactional jobs, leases, bounded matching, retry/degraded recovery, and body handling): Tasks 2, 4, 5, 6, and 8.
- Spec §6 (one alert per message/rule, fixed recipients, current-scope recheck, and personal acknowledgement): Tasks 2, 5, and 7.
- Spec §7 (strict owner APIs, scoped alert APIs, bound cursors, response whitelist, and body-free WebSocket event): Tasks 1, 6, 7, and 8.
- Spec §§8-9 (desktop role behavior, filters, paging, badge, in-app hint, stale-response safety, and visible recovery): Tasks 9 and 10.
- Spec §§10-11 (forward migration, no history scan, documentation, focused/full verification, and no implicit real-platform acceptance): Tasks 2 and 11.

---

## File Responsibility Map

### Shared contracts

- Create `packages/shared/src/keyword-alert.ts`: constants, severities, rule DTOs, alert search/page/count DTOs.
- Create `packages/shared/src/keyword-alert.test.ts`: runtime constants and representative typed fixtures.
- Modify `packages/shared/src/ws.ts`: exact `WsKeywordAlertEvent` and exhaustive server-event union.
- Modify `packages/shared/src/index.ts`: export the keyword-alert contract.

### Database and matching domain

- Create `packages/server/src/db/migrations/0015_keyword_alerts.ts`: four tables, constraints, indexes, no history backfill.
- Create `packages/server/src/db/migrations/0015_keyword_alerts.test.ts`: isolated-schema up/down and empty-job proof.
- Modify `packages/server/src/db/types.ts`: typed rows for rules, scan jobs, alerts, and recipients.
- Create `packages/server/src/keyword-alert/matcher.ts`: normalization, validation, Aho-Corasick, and current-body excerpt.
- Create `packages/server/src/keyword-alert/matcher.test.ts`: Unicode, overlap, dedupe, and excerpt cases.

### Reliable server pipeline

- Modify `packages/server/src/ingest/repo.ts`: transactionally enqueue scan rows for accepted inbound revisions.
- Modify `packages/server/src/ingest/repo.test.ts`: scheduling, replay, edit, and outbound exclusions.
- Create `packages/server/src/keyword-alert/scan-repo.ts`: lease, active rules, atomic completion/recipients, retry/degraded operations.
- Create `packages/server/src/keyword-alert/scan-repo.test.ts`: database integration and role-recipient matrix.
- Create `packages/server/src/keyword-alert/worker.ts`: bounded polling, matching, backoff, publish-after-commit, stop lifecycle.
- Create `packages/server/src/keyword-alert/worker.test.ts`: fake repo/clock orchestration tests.
- Create `packages/server/src/keyword-alert/runtime.ts`: production worker composition with an injectable lifecycle seam.
- Create `packages/server/src/keyword-alert/runtime.test.ts`: start/stop composition tests without importing the server entrypoint.

### Rules and alert APIs

- Create `packages/server/src/keyword-alert/rule-repo.ts`: owner rule CRUD with optimistic locking and normalized uniqueness.
- Create `packages/server/src/keyword-alert/rule-repo.test.ts`: database CRUD/conflict tests.
- Create `packages/server/src/api/routes/keyword-rules.ts`: owner-only strict endpoints and degraded retry.
- Create `packages/server/src/api/routes/keyword-rules.test.ts`: authentication, role, schema, conflict, and non-echo tests.
- Create `packages/server/src/keyword-alert/query.ts`: scope/user/filter-bound cursor codec.
- Create `packages/server/src/keyword-alert/query.test.ts`: cursor and cross-filter rejection tests.
- Create `packages/server/src/keyword-alert/scoped-repo.ts`: scoped page, personal count, and personal acknowledgement.
- Create `packages/server/src/keyword-alert/scoped-repo.test.ts`: current-scope and per-user acknowledgement database tests.
- Create `packages/server/src/api/routes/keyword-alerts.ts`: list/count/ack endpoints.
- Create `packages/server/src/api/routes/keyword-alerts.test.ts`: four-role API matrix and response whitelist.
- Modify `packages/server/src/rbac/scoped-db.ts` and `.test.ts`: close current actor user ID into alert/rule repositories.
- Modify `packages/server/src/api/server.ts`: construct actor-aware `ScopedDb` and register both route modules.
- Modify `packages/server/src/index.ts`: create/start/stop the scan worker and publish targeted hints.

### Desktop state and UI

- Modify `packages/desktop/src/renderer/api/client.ts` and `.test.ts`: typed rule, alert, count, retry, and acknowledge calls.
- Create `packages/desktop/src/renderer/keyword-alert-center.ts` and `.test.ts`: pure page/ack/realtime reducer.
- Create `packages/desktop/src/renderer/components/KeywordAlertCenterView.tsx` and `.test.tsx`: scoped alert controller and pure list content.
- Create `packages/desktop/src/renderer/components/KeywordRuleManager.tsx` and `.test.tsx`: owner-only rule controller and pure content.
- Modify `packages/desktop/src/renderer/components/FunctionCenter.tsx` and `.test.tsx`: wire navigation and badge.
- Create `packages/desktop/src/renderer/keyword-alert-notification.ts` and `.test.ts`: body-free toast/count refresh decisions.
- Modify `packages/desktop/src/renderer/App.tsx`: bootstrap count, WS hint, in-app toast, and alert view.

### Documentation and verification

- Modify `docs/superpowers/specs/2026-08-24-im-hub-design.md`.
- Modify `docs/superpowers/specs/2026-08-26-m0-product-scope.md`.
- Modify `docs/features/README.md` and `docs/features/06-需求缺口.md`.
- Modify `docs/RUNBOOK.md`.
- Append verified implementation evidence to `docs/superpowers/specs/2026-09-03-m4-keyword-alerts-design.md` only after final verification.

---

### Task 1: Add Shared Keyword Alert Contracts

**Files:**

- Create: `packages/shared/src/keyword-alert.ts`
- Create: `packages/shared/src/keyword-alert.test.ts`
- Modify: `packages/shared/src/ws.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**

- Consumes: existing `Platform` and `WsServerEvent`.
- Produces: `KeywordAlertSeverity`, rule create/update DTOs, alert search/page/count DTOs, and `WsKeywordAlertEvent`.

- [ ] **Step 1: Write the failing shared contract test**

Create `packages/shared/src/keyword-alert.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  KEYWORD_ALERT_PAGE_DEFAULT_LIMIT,
  KEYWORD_ALERT_PAGE_MAX_LIMIT,
  KEYWORD_RULE_PATTERN_MAX_CODE_POINTS,
  KEYWORD_ALERT_SEVERITIES,
  type KeywordAlertListPage,
  type KeywordAlertSearchRequest,
  type KeywordRuleCreate,
  type KeywordRuleUpdate,
} from './keyword-alert.js'
import type { WsServerEvent } from './ws.js'

describe('keyword alert contracts', () => {
  it('fixes limits, severities, request shapes, and the body-free websocket hint', () => {
    expect(KEYWORD_RULE_PATTERN_MAX_CODE_POINTS).toBe(100)
    expect(KEYWORD_ALERT_PAGE_DEFAULT_LIMIT).toBe(50)
    expect(KEYWORD_ALERT_PAGE_MAX_LIMIT).toBe(100)
    expect(KEYWORD_ALERT_SEVERITIES).toEqual(['normal', 'important', 'urgent'])

    const create: KeywordRuleCreate = {
      pattern: 'Synthetic literal', severity: 'important', enabled: true,
    }
    const update: KeywordRuleUpdate = { baseRevision: 1, enabled: false }
    const search: KeywordAlertSearchRequest = {
      status: 'pending', severity: 'urgent', platform: 'telegram', limit: 50,
    }
    const page: KeywordAlertListPage = { items: [], nextCursor: null }
    const event: WsServerEvent = {
      type: 'keyword_alert',
      alertId: '00000000-0000-4000-8000-000000000001',
      severity: 'urgent',
      requiresAcknowledgement: true,
      createdAt: '2026-09-03T00:00:00.000Z',
    }

    expect({ create, update, search, page, event }).toBeDefined()
    expect(event).not.toHaveProperty('body')
    expect(event).not.toHaveProperty('pattern')
  })
})
```

- [ ] **Step 2: Run the shared test to verify RED**

Run:

```bash
pnpm exec vitest run packages/shared/src/keyword-alert.test.ts
pnpm --filter @im-hub/shared exec tsc --noEmit
```

Expected: the module or typecheck fails because the keyword alert contract does not exist.

- [ ] **Step 3: Add the exact shared contract**

Create `packages/shared/src/keyword-alert.ts` with these public names:

```ts
import type { Platform } from './platform.js'

export const KEYWORD_RULE_PATTERN_MAX_CODE_POINTS = 100
export const KEYWORD_ALERT_PAGE_DEFAULT_LIMIT = 50
export const KEYWORD_ALERT_PAGE_MAX_LIMIT = 100
export const KEYWORD_ALERT_SEVERITIES = ['normal', 'important', 'urgent'] as const
export type KeywordAlertSeverity = (typeof KEYWORD_ALERT_SEVERITIES)[number]
export type KeywordAlertStatusFilter = 'pending' | 'acknowledged' | 'all'

export interface KeywordRule {
  id: string
  pattern: string
  severity: KeywordAlertSeverity
  enabled: boolean
  revision: number
  effectiveAt: string
  createdAt: string
  updatedAt: string
}

export interface KeywordRuleCreate {
  pattern: string
  severity: KeywordAlertSeverity
  enabled: boolean
}

export interface KeywordRuleUpdate {
  baseRevision: number
  pattern?: string
  severity?: KeywordAlertSeverity
  enabled?: boolean
}

export interface KeywordRuleListResponse {
  rules: KeywordRule[]
  degradedScanCount: number
}

export interface KeywordAlertSearchRequest {
  status: KeywordAlertStatusFilter
  severity?: KeywordAlertSeverity
  platform?: Platform
  accountId?: string
  limit?: number
  cursor?: string
}

export interface KeywordAlertListItem {
  alertId: string
  messageId: string
  conversationId: string
  accountId: string
  platform: Platform
  severity: KeywordAlertSeverity
  pattern: string
  accountDisplayName: string
  conversationDisplayName: string | null
  excerpt: string | null
  matchedAt: string
  messageChangedAfterMatch: boolean
  messageDeleted: boolean
  requiresAcknowledgement: boolean
  acknowledgedAt: string | null
}

export interface KeywordAlertListPage {
  items: KeywordAlertListItem[]
  nextCursor: string | null
}

export interface KeywordAlertUnacknowledgedCount {
  count: number
}
```

In `ws.ts`, add the exact body-free event from the spec and include it in `WsServerEvent`:

```ts
import type { KeywordAlertSeverity } from './keyword-alert.js'

export interface WsKeywordAlertEvent {
  type: 'keyword_alert'
  alertId: string
  severity: KeywordAlertSeverity
  requiresAcknowledgement: boolean
  createdAt: string
}
```

Export the new module once from `packages/shared/src/index.ts`.

- [ ] **Step 4: Run shared verification**

Run:

```bash
pnpm exec vitest run packages/shared/src/keyword-alert.test.ts
pnpm --filter @im-hub/shared exec tsc --noEmit
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit the shared contract**

```bash
git add packages/shared/src/keyword-alert.ts packages/shared/src/keyword-alert.test.ts packages/shared/src/ws.ts packages/shared/src/index.ts
git commit -m "feat(shared): add keyword alert contracts"
```

---

### Task 2: Add the Keyword Alert Schema

**Files:**

- Create: `packages/server/src/db/migrations/0015_keyword_alerts.ts`
- Create: `packages/server/src/db/migrations/0015_keyword_alerts.test.ts`
- Modify: `packages/server/src/db/types.ts`

**Interfaces:**

- Consumes: `users`, `messages`, existing generated UUID support, and Task 1 severity strings.
- Produces: typed `keyword_rules`, `keyword_alert_scan_jobs`, `keyword_alerts`, and `keyword_alert_recipients` tables.

- [ ] **Step 1: Write the isolated migration test first**

Create a random schema test following `0014_customer_profile_library.test.ts`. Build minimal `users` and `messages` parents, insert one synthetic message before `up()`, run `up()`, and assert:

```ts
expect(afterUp.rows[0]).toEqual({
  rules: `${schema}.keyword_rules`,
  jobs: `${schema}.keyword_alert_scan_jobs`,
  alerts: `${schema}.keyword_alerts`,
  recipients: `${schema}.keyword_alert_recipients`,
})
expect((await isolated.selectFrom('keyword_alert_scan_jobs').selectAll().execute())).toEqual([])
```

Then run `down()` and assert all four `to_regclass` values are null. Keep all DDL inside the random schema and drop it in `finally`.

- [ ] **Step 2: Run the migration test to verify RED**

```bash
pnpm exec vitest run packages/server/src/db/migrations/0015_keyword_alerts.test.ts
```

Expected: FAIL because migration `0015_keyword_alerts.ts` does not exist.

- [ ] **Step 3: Implement the forward-only production schema**

Create `0015_keyword_alerts.ts`. Use Kysely schema methods plus `sql` for defaults, checks, and partial indexes. The four tables must have these columns and constraints:

```ts
// keyword_rules
id uuid primary key default gen_random_uuid()
pattern text not null
normalized_pattern text not null
severity text not null check in ('normal','important','urgent')
enabled boolean not null default true
revision integer not null default 1 check revision > 0
effective_at timestamptz not null default now()
created_by_user_id uuid not null references users(id)
updated_by_user_id uuid not null references users(id)
created_at timestamptz not null default now()
updated_at timestamptz not null default now()
deleted_at timestamptz null

// keyword_alert_scan_jobs
id uuid primary key default gen_random_uuid()
message_id uuid not null references messages(id) on delete cascade
message_revision text not null
body_snapshot text not null
available_at timestamptz not null default now()
attempt_count integer not null default 0 check attempt_count >= 0
lease_owner text null
lease_expires_at timestamptz null
last_error_code text null
created_at timestamptz not null default now()
unique(message_id, message_revision)

// keyword_alerts
id uuid primary key default gen_random_uuid()
message_id uuid not null references messages(id) on delete cascade
rule_id uuid not null references keyword_rules(id)
pattern_snapshot text not null
severity_snapshot text not null check in ('normal','important','urgent')
matched_message_revision text not null
created_at timestamptz not null default now()
unique(message_id, rule_id)

// keyword_alert_recipients
alert_id uuid not null references keyword_alerts(id) on delete cascade
user_id uuid not null references users(id) on delete cascade
requires_ack boolean not null
acknowledged_at timestamptz null
created_at timestamptz not null default now()
primary key(alert_id, user_id)
check(acknowledged_at is null or requires_ack)
```

Add these indexes:

- partial unique `keyword_rules_normalized_active_uq` on `normalized_pattern WHERE deleted_at IS NULL`;
- `keyword_rules_enabled_effective_idx` on `(enabled, effective_at)`;
- `keyword_alert_scan_jobs_claim_idx` on `(available_at, created_at, id)`;
- `keyword_alerts_created_id_idx` on `(created_at, id)`;
- `keyword_alert_recipients_user_status_idx` on `(user_id, requires_ack, acknowledged_at, alert_id)`.

`down()` drops recipients, alerts, jobs, then rules. Do not select from or insert scan rows for existing messages.

- [ ] **Step 4: Add strict Kysely table types**

Add `KeywordRulesTable`, `KeywordAlertScanJobsTable`, `KeywordAlertsTable`, and `KeywordAlertRecipientsTable` to `db/types.ts`. Reuse `Timestamp`, `RequiredTimestamp`, `Generated`, and `KeywordAlertSeverity`; type nullable lease/error/ack columns explicitly. Add all four tables to `Database`.

- [ ] **Step 5: Verify migration, typecheck, and migration discovery**

```bash
pnpm exec vitest run packages/server/src/db/migrations/0015_keyword_alerts.test.ts packages/server/src/db/migration-provider.test.ts
pnpm --filter @im-hub/server exec tsc --noEmit
```

Expected: the isolated migration test passes, the provider sees `0015_keyword_alerts` but does not import its test file, and server typecheck exits 0.

- [ ] **Step 6: Commit the schema**

```bash
git add packages/server/src/db/migrations/0015_keyword_alerts.ts packages/server/src/db/migrations/0015_keyword_alerts.test.ts packages/server/src/db/types.ts
git commit -m "feat(server): add keyword alert schema"
```

Do not run `pnpm db:migrate` against a development database in this task.

---

### Task 3: Build the Literal Matcher and Excerpt Helper

**Files:**

- Create: `packages/server/src/keyword-alert/matcher.ts`
- Create: `packages/server/src/keyword-alert/matcher.test.ts`

**Interfaces:**

- Consumes: `KEYWORD_RULE_PATTERN_MAX_CODE_POINTS` and `KeywordAlertSeverity`.
- Produces: `normalizeKeywordText()`, `normalizeKeywordPattern()`, `AhoCorasickKeywordMatcher`, and `keywordAlertExcerpt()`.

- [ ] **Step 1: Write failing normalization and matching tests**

Use synthetic literals only:

```ts
expect(normalizeKeywordPattern('  ＲＥＦＵＮＤ  ')).toBe('refund')
expect(() => normalizeKeywordPattern('line\nbreak')).toThrow(KeywordPatternError)
expect(() => normalizeKeywordPattern('\ntrimmed control')).toThrow(KeywordPatternError)
expect(() => normalizeKeywordPattern('x'.repeat(101))).toThrow(KeywordPatternError)
expect(() => normalizeKeywordPattern('\ufb03'.repeat(34))).toThrow(KeywordPatternError)

const matcher = new AhoCorasickKeywordMatcher([
  { id: 'r1', normalizedPattern: 'refund' },
  { id: 'r2', normalizedPattern: 'fund' },
  { id: 'r3', normalizedPattern: '退款' },
])
expect(matcher.matchRuleIds('REFUND refund 退款')).toEqual(['r1', 'r2', 'r3'])
expect(matcher.matchRuleIds('no match')).toEqual([])
```

Also assert deterministic rule-ID order, overlapping patterns, an empty rule set, emoji code-point length, and no duplicate ID when a pattern appears more than once.

- [ ] **Step 2: Write failing excerpt tests**

Add exact cases:

```ts
expect(keywordAlertExcerpt('short current body', 'current', false)).toBe('short current body')
expect(keywordAlertExcerpt('body hidden after deletion', 'hidden', true)).toBeNull()
expect(Array.from(keywordAlertExcerpt('前'.repeat(200) + '命中词' + '后'.repeat(200), '命中词', false) ?? ''))
  .toHaveLength(160)
expect(keywordAlertExcerpt('前'.repeat(200) + 'ＲＥＦＵＮＤ' + '后'.repeat(200), 'refund', false))
  .toContain('ＲＥＦＵＮＤ')
expect(keywordAlertExcerpt('edited body without old literal', 'old literal', false))
  .toBe('edited body without old literal')
```

- [ ] **Step 3: Run tests to verify RED**

```bash
pnpm exec vitest run packages/server/src/keyword-alert/matcher.test.ts
```

Expected: FAIL because `matcher.ts` does not exist.

- [ ] **Step 4: Implement the pure matcher**

Use these signatures:

```ts
export class KeywordPatternError extends Error {}

export function normalizeKeywordText(value: string): string
export function normalizeKeywordPattern(value: string): string

export interface KeywordMatcherRule {
  id: string
  normalizedPattern: string
}

export class AhoCorasickKeywordMatcher {
  constructor(rules: readonly KeywordMatcherRule[])
  matchRuleIds(body: string): string[]
}

export function keywordAlertExcerpt(
  currentBody: string,
  pattern: string,
  deleted: boolean,
): string | null
```

`normalizeKeywordPattern()` rejects `\u0000-\u001f` and `\u007f-\u009f` in the original value, trims it, applies `NFKC` plus locale-independent `.toLowerCase()`, rejects controls again in the normalized result, then rejects an empty result or more than 100 normalized code points. The matcher walks `Array.from(normalizeKeywordText(body))`, builds failure links once in the constructor, and returns each rule ID once in constructor order. The excerpt preserves the original current body and returns at most 160 code points. It locates the keyword using the same normalized semantics (including full-width/case variants), maps the normalized hit back to an original-body window when possible, and otherwise uses the current-body prefix; it never falls back to the stored scan body.

- [ ] **Step 5: Run matcher verification**

```bash
pnpm exec vitest run packages/server/src/keyword-alert/matcher.test.ts
pnpm --filter @im-hub/server exec tsc --noEmit
```

Expected: tests and typecheck pass without adding a dependency.

- [ ] **Step 6: Commit the matcher**

```bash
git add packages/server/src/keyword-alert/matcher.ts packages/server/src/keyword-alert/matcher.test.ts
git commit -m "feat(server): add literal keyword matcher"
```

---

### Task 4: Enqueue Scans in the Message Transaction

**Files:**

- Modify: `packages/server/src/ingest/repo.ts`
- Modify: `packages/server/src/ingest/repo.test.ts`

**Interfaces:**

- Consumes: Task 2 `keyword_alert_scan_jobs`, existing `InsertMessageInput`, and `messageRevision()`.
- Produces: one durable scan row for every accepted non-empty inbound message revision.

- [ ] **Step 1: Add failing database cases before changing the repository**

Extend `ingest/repo.test.ts` after cleaning `keyword_alert_recipients`, `keyword_alerts`, and `keyword_alert_scan_jobs` before `messages`. Add cases that assert:

```ts
const first = await repo.insertMessage(msg({ conversationId, direction: 'in', body: 'Synthetic body' }))
expect(await db.selectFrom('keyword_alert_scan_jobs')
  .select(['message_id', 'message_revision', 'body_snapshot']).execute()).toEqual([{
  message_id: first.id,
  message_revision: 'initial',
  body_snapshot: 'Synthetic body',
}])
```

Then replay the same event and expect one job; submit edit versions 1 and 2 and expect `initial`, `version:1`, `version:2` exactly once each. Add separate assertions that outbound messages, whitespace-only inbound bodies, stale edits, and duplicate revisions create no additional jobs.

- [ ] **Step 2: Run repository tests to verify RED**

```bash
pnpm exec vitest run packages/server/src/ingest/repo.test.ts
```

Expected: FAIL because message persistence does not create scan rows.

- [ ] **Step 3: Add the transaction-local scheduling helper**

In `KyselyMessageRepo`, add:

```ts
private async enqueueKeywordAlertScan(
  trx: Transaction<Database>,
  messageId: string,
  input: InsertMessageInput,
): Promise<void> {
  if (input.direction !== 'in' || input.body.trim() === '') return
  await trx.insertInto('keyword_alert_scan_jobs').values({
    message_id: messageId,
    message_revision: messageRevision(input.editVersion, input.editedAt),
    body_snapshot: input.body,
  }).onConflict(oc => oc.columns(['message_id', 'message_revision']).doNothing()).execute()
}
```

Call it inside the existing insert transaction only after a new row is returned, and inside `updateExistingMessage()` only when a newer body revision was accepted (`contentChanged` is true). The separate `markMessageDeleted()` path never schedules a scan. Keep shadow observation and translation invalidation in the same transaction. Do not add scheduling to `MessageIngestor`, native routes, Cloud API service, or adapter callbacks; all ingestion sources must inherit the single repository boundary.

- [ ] **Step 4: Run focused message lifecycle verification**

```bash
pnpm exec vitest run packages/server/src/ingest/repo.test.ts packages/server/src/ingest/ingestor.test.ts packages/server/src/api/routes/native.test.ts packages/server/src/whatsapp-cloud/service.test.ts
pnpm --filter @im-hub/server exec tsc --noEmit
```

Expected: scan cases and existing identity/edit/remap tests pass. No outbound message creates a scan job.

- [ ] **Step 5: Commit transactional scheduling**

```bash
git add packages/server/src/ingest/repo.ts packages/server/src/ingest/repo.test.ts
git commit -m "feat(server): enqueue keyword scans with messages"
```

---

### Task 5: Process Durable Scans and Snapshot Recipients

**Files:**

- Create: `packages/server/src/keyword-alert/scan-repo.ts`
- Create: `packages/server/src/keyword-alert/scan-repo.test.ts`
- Create: `packages/server/src/keyword-alert/worker.ts`
- Create: `packages/server/src/keyword-alert/worker.test.ts`

**Interfaces:**

- Consumes: Task 2 tables, Task 3 matcher, current `users/team_members/accounts/messages` relations, and Task 1 `WsKeywordAlertEvent`.
- Produces: leased scan jobs, atomic alert/recipient completion, degraded retry operations, and `KeywordAlertWorker`.

- [ ] **Step 1: Write failing worker orchestration tests with fakes**

Define fake jobs and rules without real text from users. Require the worker to:

```ts
expect(await worker.drainOnce()).toEqual({ claimed: 2, completed: 2, failed: 0 })
expect(repo.completed).toEqual([
  { jobId: 'j1', ruleIds: ['r1'] },
  { jobId: 'j2', ruleIds: [] },
])
expect(published).toEqual([
  ['owner-1', expect.objectContaining({ type: 'keyword_alert', requiresAcknowledgement: true })],
  ['auditor-1', expect.objectContaining({ type: 'keyword_alert', requiresAcknowledgement: false })],
])
```

Add a processing-failure case proving `fail()` receives a fixed `scan_failed` code and the body/pattern are absent. Add a separate publish-failure case proving an already committed/deleted job is not passed to `fail()` and later HTTP recovery remains authoritative. Add `keywordAlertRetryDelayMs()` assertions for attempts 1, 2, 9, and 10: `1000`, `2000`, `256000`, `300000`.

- [ ] **Step 2: Write failing scan-repository integration tests**

Use synthetic owner, auditor, disabled auditor, lead manager, unrelated manager, account owner agent, unrelated agent, two teams, one account, one conversation, one inbound message, and one scan job. Add cases for:

- `claimBatch()` leases at most 20 eligible rows for 60 seconds in `created_at,id` order;
- an unexpired lease is not reclaimed, while an expired lease is;
- `complete()` creates one alert per matched rule and deletes the job in the same transaction;
- replayed completion does not duplicate `(message_id, rule_id)` or recipients;
- an empty rule set deletes the job without creating alerts, so rule-free operation cannot accumulate completed work;
- an initial no-match followed by a matching edit creates the first alert, while a later matching edit after an existing alert preserves the first `matched_message_revision` and snapshots;
- disabling, deleting, or editing a rule after `loadActiveRules()` but before `complete()` makes the stale revision fail completion revalidation and creates no alert;
- recipients are users with `disabled_at IS NULL`: all owners, auditors with `requires_ack=false`, lead managers for the account team, and the account owner only when that user is an agent; overlapping identities are deduplicated and unrelated/disabled users are absent;
- no-team accounts omit managers but still include global owner/auditor and the owning agent;
- `fail()` increments attempts, clears the lease, writes only `scan_failed`, and schedules the exact capped delay;
- attempt 10 is excluded from automatic claims, counted by `countDegraded()`, and restored by `retryDegraded(now)`.

Use exact recipient assertions:

```ts
expect(recipients).toEqual([
  { user_id: agentId, requires_ack: true },
  { user_id: auditorId, requires_ack: false },
  { user_id: managerId, requires_ack: true },
  { user_id: ownerId, requires_ack: true },
].sort((a, b) => a.user_id.localeCompare(b.user_id)))
```

- [ ] **Step 3: Run both new test files to verify RED**

```bash
pnpm exec vitest run packages/server/src/keyword-alert/worker.test.ts packages/server/src/keyword-alert/scan-repo.test.ts
```

Expected: FAIL because the scan repository and worker do not exist.

- [ ] **Step 4: Implement scan repository contracts**

Use these exported shapes:

```ts
export interface KeywordAlertScanJob {
  id: string
  messageId: string
  messageRevision: string
  bodySnapshot: string
  createdAt: Date
  attemptCount: number
}

export interface ActiveKeywordRule {
  id: string
  pattern: string
  normalizedPattern: string
  severity: KeywordAlertSeverity
  revision: number
  effectiveAt: Date
}

export interface KeywordAlertDelivery {
  userId: string
  event: WsKeywordAlertEvent
}

export class KyselyKeywordAlertScanRepo {
  constructor(private readonly db: Kysely<Database>) {}
  claimBatch(workerId: string, now: Date): Promise<KeywordAlertScanJob[]>
  loadActiveRules(): Promise<ActiveKeywordRule[]>
  complete(workerId: string, job: KeywordAlertScanJob, matchedRules: readonly ActiveKeywordRule[]): Promise<KeywordAlertDelivery[]>
  fail(workerId: string, job: KeywordAlertScanJob, now: Date, errorCode: 'scan_failed'): Promise<void>
  countDegraded(): Promise<number>
  retryDegraded(now: Date): Promise<number>
}
```

`claimBatch()` uses a short transaction, `FOR UPDATE SKIP LOCKED`, `attempt_count < 10`, `available_at <= now`, and absent/expired leases. `complete()` locks the leased job and then locks matched rule rows in sorted-ID order, revalidating every rule by `id + revision + enabled + deleted_at IS NULL + effective_at <= job.createdAt` inside the completion transaction. It takes `pattern_snapshot` and `severity_snapshot` from those locked database rows, not from unchecked caller text. It inserts each still-valid alert with `ON CONFLICT DO NOTHING RETURNING`, inserts only recipients for newly created alerts, deletes the job even when no rule remains valid, and returns deliveries after the transaction result is known. This revision check makes a concurrent disable/delete/edit authoritative and prevents a loaded stale rule from creating an alert. Never select or return message body from `complete()`.

`fail()` first verifies the lease owner, increments `attempt_count` exactly once, computes the delay from that new attempt number, clears the lease, and stores only `scan_failed`. Attempt 10 is retained with a five-minute `available_at` but is excluded from subsequent automatic claims until owner retry resets it to zero.

- [ ] **Step 5: Implement the bounded worker**

Use dependency interfaces so unit tests need no database or timers:

```ts
export interface KeywordAlertWorkerRepo {
  claimBatch(workerId: string, now: Date): Promise<KeywordAlertScanJob[]>
  loadActiveRules(): Promise<ActiveKeywordRule[]>
  complete(workerId: string, job: KeywordAlertScanJob, matchedRules: readonly ActiveKeywordRule[]): Promise<KeywordAlertDelivery[]>
  fail(workerId: string, job: KeywordAlertScanJob, now: Date, errorCode: 'scan_failed'): Promise<void>
}

export interface KeywordAlertWorkerOptions {
  repo: KeywordAlertWorkerRepo
  publish(userId: string, event: WsKeywordAlertEvent): void
  now?: () => Date
  workerId?: string
}

export class KeywordAlertWorker {
  constructor(options: KeywordAlertWorkerOptions)
  drainOnce(): Promise<{ claimed: number; completed: number; failed: number }>
  start(): void
  stop(): Promise<void>
}
```

For each batch, build one matcher from `loadActiveRules()`, obtain rule IDs for each job body, map them back to matched rule objects, filter by `effectiveAt`, call `complete()`, and only then publish returned deliveries. Repository/matching failures call `fail()`; a WebSocket publish failure is caught and recorded only as a fixed event code/count because the job has already committed and must not be retried. `start()` schedules a 250 ms idle poll with `setTimeout`, never overlaps drains, and writes only fixed error codes/counts. `stop()` cancels the timer and awaits the current drain. Export `keywordAlertRetryDelayMs(attemptCount)` with the exact delay contract from Step 1.

- [ ] **Step 6: Run pipeline verification**

```bash
pnpm exec vitest run packages/server/src/keyword-alert/matcher.test.ts packages/server/src/keyword-alert/worker.test.ts packages/server/src/keyword-alert/scan-repo.test.ts packages/server/src/ingest/repo.test.ts
pnpm --filter @im-hub/server exec tsc --noEmit
```

Expected: all tests and server typecheck pass.

- [ ] **Step 7: Commit the durable processor**

```bash
git add packages/server/src/keyword-alert/scan-repo.ts packages/server/src/keyword-alert/scan-repo.test.ts packages/server/src/keyword-alert/worker.ts packages/server/src/keyword-alert/worker.test.ts
git commit -m "feat(server): process durable keyword scans"
```

---

### Task 6: Add Owner-Only Rule Management

**Files:**

- Create: `packages/server/src/keyword-alert/rule-repo.ts`
- Create: `packages/server/src/keyword-alert/rule-repo.test.ts`
- Create: `packages/server/src/api/routes/keyword-rules.ts`
- Create: `packages/server/src/api/routes/keyword-rules.test.ts`
- Modify: `packages/server/src/rbac/scoped-db.ts`
- Modify: `packages/server/src/rbac/scoped-db.test.ts`
- Modify: `packages/server/src/api/server.ts`

**Interfaces:**

- Consumes: shared rule DTOs, `normalizeKeywordPattern()`, Task 5 degraded operations, and current request actor.
- Produces: `ScopedDb.keywordRules()`, optimistic owner CRUD, and five strict internal endpoints.

- [ ] **Step 1: Write failing repository tests**

Cover create/list/update/disable/re-enable/soft-delete with exact revision progression. Require:

```ts
const created = await repo.create(ownerId, {
  pattern: '  ＲＥＦＵＮＤ  ', severity: 'important', enabled: true,
})
expect(created).toMatchObject({
  kind: 'created',
  rule: { pattern: 'ＲＥＦＵＮＤ', severity: 'important', enabled: true, revision: 1 },
})
if (created.kind !== 'created') throw new Error('expected created rule')

expect(await repo.update(created.rule.id, ownerId, { baseRevision: 1, enabled: false }))
  .toMatchObject({ kind: 'updated', rule: { revision: 2, enabled: false } })
expect(await repo.update(created.rule.id, ownerId, { baseRevision: 1, severity: 'urgent' }))
  .toEqual({ kind: 'conflict', currentRevision: 2 })
```

Create a normalized duplicate and expect `{ kind: 'duplicate' }`; delete with the current revision, assert it disappears from `list()` but existing alert FK rows remain valid; re-create the same normalized pattern after soft delete and expect success.

- [ ] **Step 2: Write failing route tests**

Build a server with four actor tokens. Assert unauthenticated requests return `401`; manager/auditor/agent receive `403` for every `/api/keyword-rules` method; owner can list/create/update/delete and receives `degradedScanCount`. Add strict invalid cases for JSON null, extra keys, empty/control/101-code-point pattern, bad severity, missing update field, and bad revision. Every invalid response must equal a fixed body that does not contain the submitted pattern.

Assert duplicate and stale revision map to separate `409` responses:

```ts
expect(duplicate.body).toBe('{"error":"关键词规则已存在"}')
expect(stale.json()).toEqual({ error: '关键词规则已被更新', currentRevision: 2 })
```

- [ ] **Step 3: Run repository and route tests to verify RED**

```bash
pnpm exec vitest run packages/server/src/keyword-alert/rule-repo.test.ts packages/server/src/api/routes/keyword-rules.test.ts
```

Expected: FAIL because rule repository/routes do not exist.

- [ ] **Step 4: Implement the rule repository**

Export:

```ts
export type SaveKeywordRuleResult =
  | { kind: 'updated'; rule: KeywordRule }
  | { kind: 'not_found' }
  | { kind: 'conflict'; currentRevision: number }
  | { kind: 'duplicate' }

export type CreateKeywordRuleResult =
  | { kind: 'created'; rule: KeywordRule }
  | { kind: 'duplicate' }

export type RemoveKeywordRuleResult =
  | { kind: 'removed' }
  | { kind: 'not_found' }
  | { kind: 'conflict'; currentRevision: number }

export interface KeywordAlertScanMaintenance {
  countDegraded(): Promise<number>
  retryDegraded(now: Date): Promise<number>
}

export class KeywordRuleRepo {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly scans: KeywordAlertScanMaintenance,
  ) {}
  list(): Promise<KeywordRuleListResponse>
  create(actorUserId: string, input: KeywordRuleCreate): Promise<CreateKeywordRuleResult>
  update(id: string, actorUserId: string, input: KeywordRuleUpdate): Promise<SaveKeywordRuleResult>
  remove(id: string, actorUserId: string, baseRevision: number): Promise<RemoveKeywordRuleResult>
  retryDegraded(now: Date): Promise<{ retried: number }>
}
```

Trim the display pattern before storage, derive normalized text only server-side, update `effective_at` and `updated_at` on every successful mutation, increment revision atomically, and catch PostgreSQL `23505` only for the named active-pattern constraint. Return `{ kind:'created', rule }` on create success so every union is discriminated. `remove()` sets `deleted_at`, `enabled=false`, and increments revision; it never deletes alerts.

`list()` obtains `degradedScanCount` through the injected Task 5 maintenance interface, and `retryDegraded()` delegates to the same interface. `ScopedDb.keywordRules()` constructs this repository with a `KyselyKeywordAlertScanRepo` backed by the same private database; do not duplicate scan retry SQL in the rule repository.

Add `keywordRules(): KeywordRuleRepo` to `ScopedDb`. This factory closes over the private database but does not imply authorization; the route still rejects every non-owner before calling it.

- [ ] **Step 5: Implement strict owner-only routes**

Register:

```text
GET    /api/keyword-rules
POST   /api/keyword-rules
PATCH  /api/keyword-rules/:id
DELETE /api/keyword-rules/:id        body: { baseRevision }
POST   /api/keyword-alert-scans/retry body: {}
```

Use `z.object(...).strict()` and treat only `undefined` as an omitted body; explicit JSON `null` is invalid. Check `req.actor.role === 'owner'` before repository calls. Do not log request bodies or patterns. Register `keywordRuleRoutes` in `api/server.ts`.

Return `201` plus the created rule for create, `200` plus the updated rule for patch, `{ deleted: true }` for successful delete, and `{ retried }` for retry. Map not-found to fixed `404`, duplicate/stale revision to the distinct fixed `409` responses from Step 2, and never serialize the repository result unions directly. Keep delete JSON-based because the existing desktop `request<T>()` always parses a successful response body.

- [ ] **Step 6: Run rule API verification**

```bash
pnpm exec vitest run packages/server/src/keyword-alert/rule-repo.test.ts packages/server/src/api/routes/keyword-rules.test.ts packages/server/src/rbac/scoped-db.test.ts
pnpm typecheck
```

Expected: all tests and monorepo typecheck pass.

- [ ] **Step 7: Commit owner rule management**

```bash
git add packages/server/src/keyword-alert/rule-repo.ts packages/server/src/keyword-alert/rule-repo.test.ts packages/server/src/api/routes/keyword-rules.ts packages/server/src/api/routes/keyword-rules.test.ts packages/server/src/rbac/scoped-db.ts packages/server/src/rbac/scoped-db.test.ts packages/server/src/api/server.ts
git commit -m "feat(api): add owner keyword rule management"
```

---

### Task 7: Add Scoped Alert Search, Count, and Personal Acknowledgement

**Files:**

- Create: `packages/server/src/keyword-alert/query.ts`
- Create: `packages/server/src/keyword-alert/query.test.ts`
- Create: `packages/server/src/keyword-alert/scoped-repo.ts`
- Create: `packages/server/src/keyword-alert/scoped-repo.test.ts`
- Create: `packages/server/src/api/routes/keyword-alerts.ts`
- Create: `packages/server/src/api/routes/keyword-alerts.test.ts`
- Modify: `packages/server/src/rbac/scoped-db.ts`
- Modify: `packages/server/src/rbac/scoped-db.test.ts`
- Modify: `packages/server/src/api/server.ts`

**Interfaces:**

- Consumes: `ScopeFilter`, `applyAccountScope`, current actor user ID/role, Task 1 alert DTOs, Task 3 excerpt helper.
- Produces: actor-bound `ScopedKeywordAlertRepo`, safe cursor codec, and list/count/ack endpoints.

- [ ] **Step 1: Write failing cursor tests**

Create `query.test.ts` and require a versioned base64url cursor whose payload contains only position plus a SHA-256 fingerprint:

```ts
const fingerprint = keywordAlertFilterFingerprint({
  actorUserId: '00000000-0000-4000-8000-000000000001',
  scope: { kind: 'teams', teamIds: ['b', 'a'] },
  status: 'pending', severity: 'urgent', platform: 'telegram', accountId: null,
})
const cursor = encodeKeywordAlertCursor({
  createdAt: '2026-09-03T00:00:00.000Z',
  alertId: '00000000-0000-4000-8000-000000000002',
  fingerprint,
})
expect(cursor).not.toContain('telegram')
expect(decodeKeywordAlertCursor(cursor, fingerprint)).toMatchObject({
  alertId: '00000000-0000-4000-8000-000000000002',
})
```

Reject malformed, cross-user, cross-filter, and changed-team-scope cursors with `KeywordAlertCursorError`. Sort team IDs before hashing.

- [ ] **Step 2: Write failing scoped repository tests**

Seed two teams/accounts, alerts, and recipient rows for owner, auditor, lead manager, unrelated manager, owning agent, and unrelated agent. Assert:

- owner and auditor see global recipient rows;
- manager sees only recipient rows still inside current lead-team scope;
- agent sees only recipient rows still inside self-account scope;
- changing manager scope after the hit hides the old alert without deleting the recipient row;
- reassigning the account away from an agent after the hit hides the old alert without deleting the recipient row;
- adding a new manager after the hit does not create old recipient rows;
- `pending`, `acknowledged`, and `all` filters have exact results;
- auditor `all` rows have `requiresAcknowledgement=false`, and `unacknowledgedCount()` returns `0`;
- current deleted message returns `excerpt:null` and `messageDeleted:true`;
- a later edit returns `messageChangedAfterMatch:true` and a current-body excerpt;
- equal timestamps paginate by descending alert UUID without gaps or duplicates;
- returned object keys exactly match `KeywordAlertListItem` and exclude raw/external IDs/other recipients.

Test `acknowledge()` twice for one agent and assert the first timestamp remains unchanged and another recipient stays null.

- [ ] **Step 3: Write failing route tests**

Require:

```ts
POST  /api/keyword-alerts/search
GET   /api/keyword-alerts/unacknowledged-count
PATCH /api/keyword-alerts/:id/acknowledge
```

Assert authentication, four-role visibility, auditor search accepting only `status:'all'`, invisible account returning an empty page, invalid/cross-filter cursor returning a fixed `400`, auditor acknowledgement returning `403`, absent/invisible alert returning `404`, and duplicate acknowledgement returning `200` with the original `acknowledgedAt`.

- [ ] **Step 4: Run all new tests to verify RED**

```bash
pnpm exec vitest run packages/server/src/keyword-alert/query.test.ts packages/server/src/keyword-alert/scoped-repo.test.ts packages/server/src/api/routes/keyword-alerts.test.ts
```

Expected: FAIL because the cursor, scoped repository, and routes do not exist.

- [ ] **Step 5: Implement the bound cursor and scoped repository**

Export:

```ts
export class KeywordAlertCursorError extends Error {}
export function keywordAlertFilterFingerprint(input: KeywordAlertFilterIdentity): string
export function encodeKeywordAlertCursor(position: KeywordAlertCursorPosition): string
export function decodeKeywordAlertCursor(encoded: string, expectedFingerprint: string): KeywordAlertCursorPosition

export class ScopedKeywordAlertRepo {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly scope: ScopeFilter,
    private readonly actorUserId: string,
  ) {}
  list(request: KeywordAlertSearchRequest): Promise<KeywordAlertListPage>
  unacknowledgedCount(): Promise<number>
  acknowledge(alertId: string, at: Date): Promise<{ acknowledgedAt: string } | null>
}
```

Change `ScopedDb` constructor to require `actorUserId` after `scope`, expose it only through `keywordAlerts()`, and update all existing construction sites/tests:

```ts
req.scoped = new ScopedDb(db, resolveScope(req.actor), req.actor.userId)
```

Every alert query starts from `accounts`, immediately applies `applyAccountScope`, joins conversations/messages/alerts/current-user recipients, and selects only the response whitelist. Compute `messageChangedAfterMatch` by comparing `matched_message_revision` with the current `messageRevision(edit_version, edited_at)`; when `deleted_at` is set, force `excerpt:null` regardless of the retained body. Normalize limits to 50/default and 100/max. Order by `keyword_alerts.created_at DESC, keyword_alerts.id DESC`; fetch `limit + 1`. Bind the cursor fingerprint to actor ID, stable scope identity, and all filters.

For acknowledgement, first select the current user's visible recipient through the scoped join, reject `requires_ack=false`, then update only `(alert_id, actorUserId)` with `acknowledged_at = coalesce(acknowledged_at, at)` and return the stored timestamp.

- [ ] **Step 6: Implement strict alert routes**

Use strict Zod schemas. Explicit JSON null is invalid. Enforce auditor `status === 'all'` before the repo call. Map cursor errors to `400`, auditor ack to `403`, and invisible/missing ack targets to `404`. Never log filters, cursor payloads, excerpts, or identifiers.

The count route remains safe for every authenticated role: it returns `{ count: 0 }` for auditor because auditor recipient rows have `requires_ack=false`. The desktop deliberately does not request or display this count for auditor.

Register `keywordAlertRoutes` in `api/server.ts`.

- [ ] **Step 7: Run scoped API and RBAC verification**

```bash
pnpm exec vitest run packages/server/src/keyword-alert/query.test.ts packages/server/src/keyword-alert/scoped-repo.test.ts packages/server/src/api/routes/keyword-alerts.test.ts packages/server/src/rbac/scoped-db.test.ts packages/server/src/rbac/scope.test.ts
pnpm typecheck
```

Expected: all tests and typecheck pass.

- [ ] **Step 8: Commit scoped alert APIs**

```bash
git add packages/server/src/keyword-alert/query.ts packages/server/src/keyword-alert/query.test.ts packages/server/src/keyword-alert/scoped-repo.ts packages/server/src/keyword-alert/scoped-repo.test.ts packages/server/src/api/routes/keyword-alerts.ts packages/server/src/api/routes/keyword-alerts.test.ts packages/server/src/rbac/scoped-db.ts packages/server/src/rbac/scoped-db.test.ts packages/server/src/api/server.ts
git commit -m "feat(api): add scoped keyword alert workflow"
```

---

### Task 8: Start the Worker and Publish Targeted Hints

**Files:**

- Modify: `packages/server/src/index.ts`
- Create: `packages/server/src/keyword-alert/runtime.ts`
- Create: `packages/server/src/keyword-alert/runtime.test.ts`
- Modify: `packages/server/src/api/ws.test.ts`

**Interfaces:**

- Consumes: `KyselyKeywordAlertScanRepo`, `KeywordAlertWorker`, `WsHub.publishTo()`.
- Produces: a testable production scan lifecycle and per-recipient body-free WebSocket hints.

- [ ] **Step 1: Add failing runtime-composition and payload tests**

Create `runtime.test.ts` against a `startKeywordAlertRuntime()` API that accepts an injectable worker factory. Assert the helper constructs one worker, calls `start()` once, returns a lifecycle whose `stop()` awaits that same worker, and passes the exact `publish(userId,event)` callback through. No database query, timer, adapter, Redis client, or real WebSocket may start in this test.

Extend `api/ws.test.ts` to publish a `keyword_alert` event to one user and assert another user's socket receives nothing. Parse the payload and assert its exact keys:

```ts
expect(Object.keys(payload).sort()).toEqual([
  'alertId', 'createdAt', 'requiresAcknowledgement', 'severity', 'type',
])
```

- [ ] **Step 2: Run focused tests to verify RED**

```bash
pnpm exec vitest run packages/server/src/keyword-alert/runtime.test.ts packages/server/src/api/ws.test.ts
```

Expected: FAIL because `runtime.ts` and its exported lifecycle helper do not exist.

- [ ] **Step 3: Implement the testable runtime seam**

Create `runtime.ts` with these exported contracts:

```ts
export interface KeywordAlertWorkerLifecycle {
  stop(): Promise<void>
}

export interface KeywordAlertRuntimeOptions {
  db: Kysely<Database>
  publish(userId: string, event: WsKeywordAlertEvent): void
  createWorker?: (options: KeywordAlertWorkerOptions) => Pick<KeywordAlertWorker, 'start' | 'stop'>
}

export function startKeywordAlertRuntime(
  options: KeywordAlertRuntimeOptions,
): KeywordAlertWorkerLifecycle
```

Export `KeywordAlertWorkerOptions` from Task 5. The default factory constructs `KeywordAlertWorker` with `KyselyKeywordAlertScanRepo(options.db)`, calls `start()` exactly once, and returns only the stop lifecycle. The optional factory exists solely for deterministic composition tests and must not escape into `index.ts`.

- [ ] **Step 4: Wire the production composition root**

In `index.ts`, start exactly one runtime after `db` and `hub` exist:

```ts
const keywordAlertRuntime = startKeywordAlertRuntime({
  db,
  publish: (userId, event) => hub.publishTo(userId, event),
})
```

In the existing SIGINT/SIGTERM shutdown sequence, call `await keywordAlertRuntime.stop()` before `app.close()`, `redis.quit()`, and `db.destroy()`. Do not start a BullMQ queue, new process, system notifier, or platform guest hook.

- [ ] **Step 5: Run production-path verification**

```bash
pnpm exec vitest run packages/server/src/keyword-alert/worker.test.ts packages/server/src/keyword-alert/scan-repo.test.ts packages/server/src/keyword-alert/runtime.test.ts packages/server/src/api/ws.test.ts
pnpm --filter @im-hub/server exec tsc --noEmit
```

Expected: all listed tests and server typecheck pass. Do not add an import-time `index.test.ts` that starts real adapters or infrastructure.

- [ ] **Step 6: Commit runtime wiring**

```bash
git add packages/server/src/index.ts packages/server/src/keyword-alert/runtime.ts packages/server/src/keyword-alert/runtime.test.ts packages/server/src/api/ws.test.ts
git commit -m "feat(server): run keyword alert worker"
```

---

### Task 9: Add the Desktop API and Alert State Machine

**Files:**

- Modify: `packages/desktop/src/renderer/api/client.ts`
- Modify: `packages/desktop/src/renderer/api/client.test.ts`
- Create: `packages/desktop/src/renderer/keyword-alert-center.ts`
- Create: `packages/desktop/src/renderer/keyword-alert-center.test.ts`

**Interfaces:**

- Consumes: Task 1 shared contracts and server endpoints from Tasks 6-7.
- Produces: typed cancellable client methods and stale-safe alert page/ack reducer.

- [ ] **Step 1: Write failing client contract tests**

After a synthetic login, assert exact method/path/body/signal behavior for:

```ts
api.searchKeywordAlerts({ status: 'pending', severity: 'urgent', limit: 50 }, signal)
api.getKeywordAlertUnacknowledgedCount()
api.acknowledgeKeywordAlert(alertId)
api.listKeywordRules()
api.createKeywordRule({ pattern: 'Synthetic', severity: 'normal', enabled: true })
api.updateKeywordRule(ruleId, { baseRevision: 1, enabled: false })
api.deleteKeywordRule(ruleId, 2)
api.retryKeywordAlertScans()
```

Require searches to use POST JSON and never put filters in the URL. Require delete to send `{ baseRevision }` and retry to send `{}`.

- [ ] **Step 2: Write failing reducer tests**

Define `KeywordAlertCenterState` fixtures and cover:

- stale replacement responses ignored;
- append deduplicates by `alertId` and preserves rows on append failure;
- filter change clears old rows and abort generation;
- `ack.started` marks only one row busy;
- `ack.succeeded` moves the row out of `pending`, keeps it in `all`, and stores server timestamp;
- `ack.failed` leaves acknowledgement unchanged and exposes a retryable row error;
- `realtime.received` increments a revision but never inserts an unscoped WS payload as a list row.

Example:

```ts
state = reduceKeywordAlertCenter(state, {
  type: 'ack.succeeded', alertId: item.alertId, acknowledgedAt: '2026-09-03T01:00:00.000Z',
})
expect(state.items).toEqual([])
expect(state.acknowledgingAlertId).toBeNull()
```

- [ ] **Step 3: Run tests to verify RED**

```bash
pnpm exec vitest run packages/desktop/src/renderer/api/client.test.ts packages/desktop/src/renderer/keyword-alert-center.test.ts
```

Expected: methods and reducer are missing.

- [ ] **Step 4: Add typed API methods**

Import all DTOs plus shared `Role` and `Platform` with `import type`, tighten the existing `SessionUser.role` and `AccountRow.platform` fields from `string` to those shared unions, and add the eight methods from Step 1. `searchKeywordAlerts` accepts an optional `AbortSignal`. Keep token handling and `UnauthorizedError` behavior unchanged; update any now-invalid synthetic test fixtures to real union members rather than adding casts.

- [ ] **Step 5: Implement the pure reducer**

Use these public names:

```ts
export type KeywordAlertLoadMode = 'replace' | 'append'
export interface KeywordAlertCenterState {
  items: KeywordAlertListItem[]
  nextCursor: string | null
  activeLoad: { requestId: number; mode: KeywordAlertLoadMode } | null
  acknowledgingAlertId: string | null
  error: string | null
  appendError: string | null
  ackError: { alertId: string; message: string } | null
  realtimeRevision: number
  hasLoaded: boolean
}
export function initialKeywordAlertCenterState(): KeywordAlertCenterState
export function reduceKeywordAlertCenter(
  state: KeywordAlertCenterState,
  action: KeywordAlertCenterAction,
): KeywordAlertCenterState
```

Mirror the proven request-ID and append semantics of `customer-profile-library.ts`, but key by `alertId`. The reducer never trusts the WS event as row content.

- [ ] **Step 6: Run desktop state verification**

```bash
pnpm exec vitest run packages/desktop/src/renderer/api/client.test.ts packages/desktop/src/renderer/keyword-alert-center.test.ts
pnpm --filter @im-hub/desktop exec tsc --noEmit
```

Expected: all pass.

- [ ] **Step 7: Commit desktop data/state**

```bash
git add packages/desktop/src/renderer/api/client.ts packages/desktop/src/renderer/api/client.test.ts packages/desktop/src/renderer/keyword-alert-center.ts packages/desktop/src/renderer/keyword-alert-center.test.ts
git commit -m "feat(desktop): add keyword alert state"
```

---

### Task 10: Build the Alert Center, Rule Manager, Badge, and In-App Hint

**Files:**

- Create: `packages/desktop/src/renderer/components/KeywordAlertCenterView.tsx`
- Create: `packages/desktop/src/renderer/components/KeywordAlertCenterView.test.tsx`
- Create: `packages/desktop/src/renderer/components/KeywordRuleManager.tsx`
- Create: `packages/desktop/src/renderer/components/KeywordRuleManager.test.tsx`
- Create: `packages/desktop/src/renderer/keyword-alert-notification.ts`
- Create: `packages/desktop/src/renderer/keyword-alert-notification.test.ts`
- Modify: `packages/desktop/src/renderer/components/FunctionCenter.tsx`
- Modify: `packages/desktop/src/renderer/components/FunctionCenter.test.tsx`
- Modify: `packages/desktop/src/renderer/App.tsx`

**Interfaces:**

- Consumes: Task 9 client/reducer and Task 1 `WsKeywordAlertEvent`.
- Produces: `keywordAlerts` navigation, scoped list/ack UI, owner rule UI, memory-only badge, and generic in-app toast.

- [ ] **Step 1: Write failing pure alert-content tests**

Export a stateless `KeywordAlertContent` accepting state, role, filters, accounts, callbacks, and an optional rule-manager node. With `renderToStaticMarkup`, assert:

- pending/acknowledged/all tabs for owner/manager/agent;
- auditor renders only “全部告警” and no acknowledge button;
- severity/platform/account controls;
- normal/important/urgent labels;
- account/conversation names, keyword, time, and short excerpt;
- edited/deleted markers;
- loading, empty, first-load error, append error, and acknowledge error states;
- owner rule-manager tab exists; other roles do not render it.

Use only synthetic fixtures and assert deleted rows do not render their hidden body fixture.

- [ ] **Step 2: Write failing pure rule-manager tests**

Export `KeywordRuleManagerContent` and assert owner controls for pattern, severity, enabled, save, edit, disable, delete, degraded count, and retry. Require conflict copy `规则已被其他窗口更新，请刷新后重试`, duplicate copy `关键词规则已存在`, and no rendering of submitted pattern inside generic server errors.

- [ ] **Step 3: Write failing FunctionCenter and notification tests**

Update the metadata test to require:

```ts
expect(FUNCTION_CENTER_ENTRIES).toEqual(expect.arrayContaining([
  expect.objectContaining({ title: '关键词警报', view: 'keywordAlerts' }),
]))
```

Add a rendering case with `keywordAlertCount={3}` and assert the badge contains `3`; `null` and `0` render no badge. In `keyword-alert-notification.test.ts`, require a `keyword_alert` event to produce only a generic message such as `收到一条紧急关键词告警`, never pattern/body, and return `refreshCount:true` only when `requiresAcknowledgement` is true.

- [ ] **Step 4: Run all component tests to verify RED**

```bash
pnpm exec vitest run packages/desktop/src/renderer/components/KeywordAlertCenterView.test.tsx packages/desktop/src/renderer/components/KeywordRuleManager.test.tsx packages/desktop/src/renderer/components/FunctionCenter.test.tsx packages/desktop/src/renderer/keyword-alert-notification.test.ts
```

Expected: components/view key/helpers do not exist.

- [ ] **Step 5: Implement the alert controller and pure content**

Export:

```ts
export function KeywordAlertCenterView(props: {
  role: Role
  realtimeRevision: number
  onAcknowledged(): void
}): ReactNode
```

The controller derives auditor status as `all`, keeps other filters in local state, holds one AbortController and monotonically increasing request ID, uses the Task 9 reducer, cancels on filters/unmount, and blocks append during another load. On `realtimeRevision` change it refreshes the current filter without flashing old rows under changed filters. Map `NetworkError` to `连不上服务端，请稍后重试`, all other non-401 load errors to `关键词告警加载失败，请稍后重试`, and preserve rows on failed refresh/ack.

On acknowledgement success, dispatch the exact server timestamp and call `onAcknowledged()` so App refreshes the count. Do not call native control, platform selection, message send, translation, system notification, or filesystem APIs.

- [ ] **Step 6: Implement owner rule management**

`KeywordRuleManager` loads the owner-only list when mounted, submits Task 1 create/update bodies, uses returned revision after every save, confirms soft deletion in the UI, and exposes degraded retry. A stale `409` retains unsaved input and offers refresh; duplicate `409` keeps the form. Never write patterns to console.

- [ ] **Step 7: Wire navigation, badge, WS handling, and toast**

Change `ViewKey` to:

```ts
export type ViewKey = 'chat' | 'accounts' | 'customerProfiles' | 'keywordAlerts'
```

Give the “关键词警报” entry `view: 'keywordAlerts'` and change its description from the obsolete administrator-only wording to `查看账号范围内的客户关键词告警`. Add `keywordAlertCount: number | null` to `FunctionCenter`; render `99+` above 99 in both expanded and compact modes.

In `App.tsx`:

- add memory-only `keywordAlertCount`, `keywordAlertRealtimeRevision`, and toast state;
- after `refreshSessionUser`, fetch the count for non-auditors without blocking account bootstrap; set auditor count to null;
- handle `event.type === 'keyword_alert'` before message branches: create generic toast, increment realtime revision, and refetch count only when `requiresAcknowledgement` is true;
- reset all alert state on logout/generation change;
- render `KeywordAlertCenterView` only for `view === 'keywordAlerts'`;
- render the toast inside the app card with `role="status"`/`aria-live="polite"`, automatically dismiss after 5 seconds, and never invoke Electron Notification or Audio APIs.

Keep the native chat workspace mounted with `display:none` while the alert view is active.

- [ ] **Step 8: Run desktop verification**

```bash
pnpm exec vitest run packages/desktop/src/renderer/api/client.test.ts packages/desktop/src/renderer/keyword-alert-center.test.ts packages/desktop/src/renderer/components/KeywordAlertCenterView.test.tsx packages/desktop/src/renderer/components/KeywordRuleManager.test.tsx packages/desktop/src/renderer/components/FunctionCenter.test.tsx packages/desktop/src/renderer/keyword-alert-notification.test.ts packages/desktop/src/renderer/store.test.ts
pnpm --filter @im-hub/desktop exec tsc --noEmit
pnpm --filter @im-hub/desktop build
```

Expected: all tests pass and electron-vite builds main, preload, and renderer. No system-notification code or platform guest bundle changes appear in the diff.

- [ ] **Step 9: Commit the desktop alert center**

```bash
git add packages/desktop/src/renderer/components/KeywordAlertCenterView.tsx packages/desktop/src/renderer/components/KeywordAlertCenterView.test.tsx packages/desktop/src/renderer/components/KeywordRuleManager.tsx packages/desktop/src/renderer/components/KeywordRuleManager.test.tsx packages/desktop/src/renderer/keyword-alert-notification.ts packages/desktop/src/renderer/keyword-alert-notification.test.ts packages/desktop/src/renderer/components/FunctionCenter.tsx packages/desktop/src/renderer/components/FunctionCenter.test.tsx packages/desktop/src/renderer/App.tsx
git commit -m "feat(desktop): build internal keyword alerts"
```

---

### Task 11: Synchronize Documentation and Run Final Verification

**Files:**

- Modify: `docs/superpowers/specs/2026-08-24-im-hub-design.md`
- Modify: `docs/superpowers/specs/2026-08-26-m0-product-scope.md`
- Modify: `docs/features/README.md`
- Modify: `docs/features/06-需求缺口.md`
- Modify: `docs/RUNBOOK.md`
- Modify after verification: `docs/superpowers/specs/2026-09-03-m4-keyword-alerts-design.md`

**Interfaces:**

- Consumes: all verified behavior from Tasks 1-10.
- Produces: accurate current docs, release/migration instructions, final evidence, and a reviewed branch.

- [ ] **Step 1: Update current product documentation**

Record only behavior proven by the implementation:

- M4-3 is internal-only, literal-only, global-rule, owner-managed;
- new/edited inbound central messages are matched; no history backfill and no outbound matching;
- owner/manager/agent confirm independently; auditor has a global read-only feed and no badge;
- notifications are in-app only and work the same on macOS/Windows;
- WhatsApp Web remains outside central alerts; configured Cloud API webhook messages participate;
- no regex, email, WeCom webhook, OS notification, sound, deep-link navigation, or agent approval workflow exists;
- migration `0015` creates four tables and does not scan existing messages;
- document the three internal alert endpoints and five owner-only rule/scan endpoints without example keywords or bodies.

- [ ] **Step 2: Scan for stale or unsafe statements**

Run:

```bash
rg -n "关键词告警|关键词警报|alert_permissions|Aho|正则|邮件|企业微信|系统通知|WhatsApp Web" docs/RUNBOOK.md docs/features docs/superpowers/specs/2026-08-24-im-hub-design.md docs/superpowers/specs/2026-08-26-m0-product-scope.md packages
rg -n "new Notification|Notification\(|Audio\(" packages/desktop/src
git diff --check
git status --short
```

Expected: active docs distinguish implemented internal literal alerts from deferred features; no desktop system notification/audio call was introduced; diff check is empty; status contains only intended M4-3 files.

- [ ] **Step 3: Run the complete focused suite**

```bash
pnpm exec vitest run packages/shared/src/keyword-alert.test.ts packages/server/src/db/migrations/0015_keyword_alerts.test.ts packages/server/src/db/migration-provider.test.ts packages/server/src/keyword-alert/matcher.test.ts packages/server/src/ingest/repo.test.ts packages/server/src/keyword-alert/scan-repo.test.ts packages/server/src/keyword-alert/worker.test.ts packages/server/src/keyword-alert/runtime.test.ts packages/server/src/keyword-alert/rule-repo.test.ts packages/server/src/api/routes/keyword-rules.test.ts packages/server/src/keyword-alert/query.test.ts packages/server/src/keyword-alert/scoped-repo.test.ts packages/server/src/api/routes/keyword-alerts.test.ts packages/server/src/api/ws.test.ts packages/server/src/rbac/scoped-db.test.ts packages/desktop/src/renderer/api/client.test.ts packages/desktop/src/renderer/keyword-alert-center.test.ts packages/desktop/src/renderer/components/KeywordAlertCenterView.test.tsx packages/desktop/src/renderer/components/KeywordRuleManager.test.tsx packages/desktop/src/renderer/components/FunctionCenter.test.tsx packages/desktop/src/renderer/keyword-alert-notification.test.ts
```

Expected: every listed file passes. Database tests connect only to the fixed `_test` database.

- [ ] **Step 4: Invoke verification-before-completion and run fresh full verification**

Use `superpowers:verification-before-completion`, then run:

```bash
pnpm typecheck
pnpm test
pnpm --filter @im-hub/desktop build
git diff origin/main...HEAD --check
```

Expected: typecheck exits 0, the full Vitest suite has zero failures, all three desktop build stages succeed, and diff check is empty. If PostgreSQL is blocked by sandbox `EPERM`, rerun the exact same `pnpm test` with required sandbox escalation; never change the database target.

- [ ] **Step 5: Record only fresh evidence in the design checkpoint**

Append the exact commit IDs, focused/full test counts, typecheck result, desktop build result, migration status, and manual acceptance status to the design spec. Do not include rule text, excerpts, message bodies/keys, account/conversation/user identifiers, media references, platform profile/session data, tokens, QR links, codes, or secrets.

If no development database target has been explicitly confirmed, record `开发数据库 migration 未执行` rather than loading `.env` or guessing. If no real desktop package/interaction test was authorized, record `未进行真实平台消息验收` rather than implying it passed.

- [ ] **Step 6: Commit documentation**

```bash
git add docs/superpowers/specs/2026-08-24-im-hub-design.md docs/superpowers/specs/2026-08-26-m0-product-scope.md docs/superpowers/specs/2026-09-03-m4-keyword-alerts-design.md docs/features/README.md docs/features/06-需求缺口.md docs/RUNBOOK.md
git commit -m "docs: record internal keyword alerts"
```

- [ ] **Step 7: Review the complete branch before integration**

Run:

```bash
git status --short --branch
git diff origin/main...HEAD --stat
git diff origin/main...HEAD --check
```

Invoke `superpowers:requesting-code-review`. Address verified findings with `superpowers:receiving-code-review`, rerun affected tests, then rerun Task 11 Step 4. Do not push, open a PR, merge, apply the development migration, package a desktop app, or perform real platform acceptance until the user explicitly chooses that step.

---

## Planned Commit Sequence

1. `feat(shared): add keyword alert contracts`
2. `feat(server): add keyword alert schema`
3. `feat(server): add literal keyword matcher`
4. `feat(server): enqueue keyword scans with messages`
5. `feat(server): process durable keyword scans`
6. `feat(api): add owner keyword rule management`
7. `feat(api): add scoped keyword alert workflow`
8. `feat(server): run keyword alert worker`
9. `feat(desktop): add keyword alert state`
10. `feat(desktop): build internal keyword alerts`
11. `docs: record internal keyword alerts`

The existing design commit `d548c53` precedes this sequence. Do not amend or squash implementation commits; each task remains independently reviewable.
