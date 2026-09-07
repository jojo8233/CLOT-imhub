# Employee Translation Provider Choice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure DeepL, Claude, and OpenAI together and let each employee save a default provider or override it for one translation, with explicit fallback disclosure.

**Architecture:** Put the provider union and response metadata in `@im-hub/shared`, persist one preference per user and one translation per provider, then resolve every employee-triggered request from explicit override to user default to company default. Keep provider keys and availability on the server; native webviews obtain the real user only from their verified control grant.

**Tech Stack:** TypeScript ESM, Kysely/PostgreSQL, Fastify 5, Redis translation cache, React 19, zustand, Vitest, pnpm 10.

**Spec:** `docs/superpowers/specs/2026-09-07-production-server-deployment-design.md`

## Global Constraints

- Work only in `/private/tmp/im-hub-m3-outbox`; do not modify either main checkout.
- Use Node.js 22+ and pnpm 10; do not create npm/yarn lockfiles.
- Use TDD for every behavior change and add migration `0017`; never rewrite migrations `0001`–`0016`.
- `DEFAULT_TRANSLATION_PROVIDER` remains `deepl`; fallback order is `deepl`, `claude`, `openai` after the requested provider.
- API keys remain server-only and no test/log may print a key, customer text, QR, code, 2FA value, or platform session.
- Business reads keep the RBAC boundary; native requests derive `userId` from `authorizeNativeControl`, never from the request body.
- Preserve WhatsApp Web-only employee behavior and the retained, disabled Cloud API backend.

---

### Task 1: Shared provider and result contracts

**Files:**
- Create: `packages/shared/src/translation-provider.ts`
- Create: `packages/shared/src/translation-provider.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/native-control.ts`
- Test: `packages/shared/src/translation-provider.test.ts`

**Interfaces:**
- Produces: `TRANSLATION_PROVIDERS`, `TranslationProviderName`, `TranslationProviderAvailability`, `TranslationPreference`, `TranslationResultMeta`.
- Produces: `NativeTranslationBatchInput.provider?: TranslationProviderName` and provider-aware native results.

- [ ] **Step 1: Write the failing shared contract test**

```ts
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  TRANSLATION_PROVIDERS,
  type NativeTranslationBatchInput,
  type TranslationProviderName,
} from './index.js'

describe('translation provider contract', () => {
  it('keeps the production provider order stable', () => {
    expect(TRANSLATION_PROVIDERS).toEqual(['deepl', 'claude', 'openai'])
  })

  it('allows a typed one-request native override', () => {
    const input: NativeTranslationBatchInput = {
      texts: ['synthetic'], targetLang: 'zh', provider: 'claude',
    }
    expectTypeOf(input.provider).toEqualTypeOf<TranslationProviderName | undefined>()
  })
})
```

- [ ] **Step 2: Run the test and verify the missing export failure**

Run: `pnpm exec vitest run packages/shared/src/translation-provider.test.ts`

Expected: FAIL because `TRANSLATION_PROVIDERS` and `TranslationProviderName` do not exist.

- [ ] **Step 3: Add the minimal shared types and exports**

```ts
export const TRANSLATION_PROVIDERS = ['deepl', 'claude', 'openai'] as const
export type TranslationProviderName = (typeof TRANSLATION_PROVIDERS)[number]

export interface TranslationProviderAvailability {
  provider: TranslationProviderName
  available: boolean
}

export interface TranslationPreference {
  companyDefault: TranslationProviderName
  userDefault: TranslationProviderName
  providers: TranslationProviderAvailability[]
}

export interface TranslationResultMeta {
  requestedProvider: TranslationProviderName
  provider: TranslationProviderName
  downgraded: boolean
}
```

Export this module from `packages/shared/src/index.ts`. Change native input/result provider fields from `string` to the shared union and add `requestedProvider` plus `downgraded` to each successful native result.

- [ ] **Step 4: Run shared tests and typecheck**

Run: `pnpm exec vitest run packages/shared/src/translation-provider.test.ts packages/shared/src/translation.test.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS after all existing native result fixtures receive typed provider metadata.

- [ ] **Step 5: Commit the contract**

```bash
git add packages/shared/src/translation-provider.ts packages/shared/src/translation-provider.test.ts packages/shared/src/index.ts packages/shared/src/native-control.ts packages/desktop/src packages/server/src
git commit -m "feat(shared): define translation provider choices"
```

### Task 2: Persist personal preferences and per-provider message translations

**Files:**
- Create: `packages/server/src/db/migrations/0017_translation_provider_preferences.ts`
- Create: `packages/server/src/db/migrations/0017_translation_provider_preferences.test.ts`
- Modify: `packages/server/src/db/types.ts`
- Modify: `packages/server/src/db/migration-provider.test.ts`
- Modify: `packages/server/src/ingest/repo.ts`
- Modify: `packages/server/src/ingest/repo.test.ts`
- Modify: `packages/server/src/pipeline/translate-job.ts`
- Modify: `packages/server/src/pipeline/translate-job.test.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/src/db/migrations/0017_translation_provider_preferences.test.ts`

**Interfaces:**
- Produces: `users.preferred_translation_provider: TranslationProviderName` with DB default `deepl`.
- Produces: `message_translations` primary key `(message_id, target_lang, provider)`.
- Produces: provider-aware `hasTranslation`/save/read behavior used by Tasks 3–5.

- [ ] **Step 1: Write migration tests against an isolated schema**

```ts
it('adds a constrained user preference and permits provider-specific translations', async () => {
  await up(isolated)
  await isolated.updateTable('users')
    .set({ preferred_translation_provider: 'claude' })
    .where('id', '=', userId).execute()
  await isolated.insertInto('message_translations').values([
    { message_id: messageId, target_lang: 'zh', provider: 'deepl', translated_text: 'A' },
    { message_id: messageId, target_lang: 'zh', provider: 'openai', translated_text: 'B' },
  ]).execute()
  await expect(sql`update ${sql.table(`${schema}.users`)} set preferred_translation_provider = 'invalid'`
    .execute(db)).rejects.toMatchObject({ constraint: 'users_translation_provider_check' })
})
```

Also start the isolated schema with the old two-column `message_translations_pk` and one row, then assert that row survives `up()`.

- [ ] **Step 2: Run the migration test and verify it fails**

Run: `pnpm exec vitest run packages/server/src/db/migrations/0017_translation_provider_preferences.test.ts`

Expected: FAIL because migration `0017` is absent.

- [ ] **Step 3: Implement migration `0017` and Kysely types**

```ts
await db.schema.alterTable('users')
  .addColumn('preferred_translation_provider', 'text', column => column.notNull().defaultTo('deepl'))
  .execute()
await db.schema.alterTable('users')
  .addCheckConstraint(
    'users_translation_provider_check',
    sql`preferred_translation_provider in ('deepl', 'claude', 'openai')`,
  ).execute()

await db.schema.alterTable('message_translations')
  .dropConstraint('message_translations_pk').execute()
await db.schema.alterTable('message_translations')
  .addPrimaryKeyConstraint('message_translations_pk', ['message_id', 'target_lang', 'provider'])
  .execute()
```

Type both DB columns as `TranslationProviderName`. The development-only `down()` must deterministically retain the newest row per `(message_id, target_lang)` before restoring the old primary key; production rollback continues to use backups instead of `down()`.

- [ ] **Step 4: Make repository conflict/read keys provider-aware**

Change `saveTranslationIfCurrent()` conflict columns to `['message_id', 'target_lang', 'provider']`. Change
`runTranslateJob` to call `hasTranslation(messageId, targetLang, requestedProvider)` and update its dependency
signature/tests. Make repository publish reads explicitly choose the company-default DeepL result. Add a regression
test that saving OpenAI does not overwrite DeepL for the same message and language.

Run: `pnpm exec vitest run packages/server/src/db/migrations/0017_translation_provider_preferences.test.ts packages/server/src/ingest/repo.test.ts packages/server/src/db/migration-provider.test.ts`

Expected: PASS, and migration provider reports 17 production migrations ending in `0017_translation_provider_preferences`.

- [ ] **Step 5: Commit the storage change**

```bash
git add packages/server/src/db packages/server/src/ingest packages/server/src/pipeline packages/server/src/index.ts
git commit -m "feat(server): persist provider-specific translations"
```

### Task 3: Resolve provider availability and user preference on the server

**Files:**
- Create: `packages/server/src/translation/preference-service.ts`
- Create: `packages/server/src/translation/preference-service.test.ts`
- Create: `packages/server/src/translation/preference-repo.ts`
- Create: `packages/server/src/translation/providers/index.ts`
- Create: `packages/server/src/translation/providers/index.test.ts`
- Create: `packages/server/src/translation/providers/openai.test.ts`
- Create: `packages/server/src/translation/providers/claude.test.ts`
- Modify: `packages/server/src/translation/types.ts`
- Modify: `packages/server/src/translation/gateway.ts`
- Modify: `packages/server/src/translation/gateway.test.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Produces: `TranslationPreferenceService.get(userId)`, `.set(userId, provider)`, `.resolve(userId, override?)`.
- Produces: `TranslationGateway.availableProviders(): TranslationProviderName[]`.
- Consumes: Task 2 user preference column and Task 1 provider union.

- [ ] **Step 1: Write failing service and gateway tests**

```ts
it('resolves explicit override before saved and company defaults', async () => {
  const service = new TranslationPreferenceService(repo, ['deepl', 'claude', 'openai'], 'deepl')
  await expect(service.resolve('user-1', 'openai')).resolves.toBe('openai')
  await expect(service.resolve('user-1')).resolves.toBe('claude')
})

it('falls back when a saved provider is unavailable without changing storage', async () => {
  const service = new TranslationPreferenceService(repo, ['deepl', 'openai'], 'deepl')
  await expect(service.resolve('user-1')).resolves.toBe('deepl')
  expect(repo.set).not.toHaveBeenCalled()
})
```

Add a gateway assertion that requested OpenAI produces attempt order `openai`, `deepl`, `claude` and returns `downgradedFrom: ['openai']` if DeepL succeeds.
Add SDK-mocked OpenAI/Claude tests that assert the configured model is called, structured output is parsed, customer
text is treated as tagged data, and upstream/malformed responses become `ProviderFailedError` without logging keys.
Add a factory test that empty keys omit only that provider and never returns key material in availability metadata.

- [ ] **Step 2: Run tests and verify missing service behavior**

Run: `pnpm exec vitest run packages/server/src/translation/preference-service.test.ts packages/server/src/translation/gateway.test.ts`

Expected: FAIL because the service and availability API do not exist.

- [ ] **Step 3: Implement the preference service and configured-provider factory**

```ts
export class TranslationPreferenceService {
  async resolve(userId: string, override?: TranslationProviderName): Promise<TranslationProviderName> {
    if (override && this.available.includes(override)) return override
    const saved = await this.repo.get(userId)
    return this.available.includes(saved) ? saved : this.companyDefault
  }
}
```

Define the repository boundary and its Kysely implementation:

```ts
export interface TranslationPreferenceRepo {
  get(userId: string): Promise<TranslationProviderName>
  set(userId: string, provider: TranslationProviderName): Promise<void>
}
```

`TranslationPreferenceService.get()` returns the `TranslationPreference` DTO; `.set()` persists then returns the
updated DTO. Add `createConfiguredTranslationProviders(config)` in
`packages/server/src/translation/providers/index.ts`; instantiate only providers with non-empty keys. `index.ts`
passes that list to the gateway and preference service. Replace the server-local `ProviderName` alias with the shared
union so the names cannot drift. Never log key values or lengths.

- [ ] **Step 4: Run provider unit tests**

Run: `pnpm exec vitest run packages/server/src/translation/gateway.test.ts packages/server/src/translation/preference-service.test.ts packages/server/src/translation/providers/index.test.ts packages/server/src/translation/providers/deepl.test.ts packages/server/src/translation/providers/openai.test.ts packages/server/src/translation/providers/claude.test.ts`

Expected: PASS for all three success paths, requested-first fallback order, no-provider rejection, and availability list.

- [ ] **Step 5: Commit provider resolution**

```bash
git add packages/server/src/translation packages/server/src/index.ts
git commit -m "feat(server): resolve employee translation provider"
```

### Task 4: Add authenticated preference and availability APIs

**Files:**
- Create: `packages/server/src/api/routes/translation-preferences.ts`
- Create: `packages/server/src/api/routes/translation-preferences.test.ts`
- Modify: `packages/server/src/api/server.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Produces: `GET /api/translation/providers -> TranslationPreference`.
- Produces: `PATCH /api/session/translation-provider` body `{ provider: TranslationProviderName }`.
- Consumes: `TranslationPreferenceService` from Task 3 and authenticated `req.actor.userId`.

- [ ] **Step 1: Write failing route tests**

```ts
it('returns availability without secrets and updates only the caller', async () => {
  const get = await app.inject({ method: 'GET', url: '/api/translation/providers', headers: auth('agent') })
  expect(get.json()).toEqual({
    companyDefault: 'deepl', userDefault: 'claude',
    providers: [
      { provider: 'deepl', available: true },
      { provider: 'claude', available: true },
      { provider: 'openai', available: false },
    ],
  })
  expect(JSON.stringify(get.json())).not.toContain('key')

  await app.inject({
    method: 'PATCH', url: '/api/session/translation-provider', headers: auth('agent'),
    payload: { provider: 'deepl', userId: 'someone-else' },
  })
  expect(service.set).toHaveBeenCalledWith(AGENT_ID, 'deepl')
})
```

Add 400 coverage for an unknown provider and 401 coverage for an unauthenticated call.

- [ ] **Step 2: Run the route test and verify 404 failures**

Run: `pnpm exec vitest run packages/server/src/api/routes/translation-preferences.test.ts`

Expected: FAIL with 404 for both new endpoints.

- [ ] **Step 3: Implement and register the route**

```ts
const updateBody = z.object({ provider: z.enum(TRANSLATION_PROVIDERS) }).strict()

app.get('/api/translation/providers', async req => service.get(req.actor.userId))
app.patch('/api/session/translation-provider', async (req, reply) => {
  const parsed = updateBody.safeParse(req.body)
  if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })
  return service.set(req.actor.userId, parsed.data.provider)
})
```

Inject the service through `BuildServerDeps`; tests use an in-memory fake and production uses the Kysely implementation.

- [ ] **Step 4: Run route and server tests**

Run: `pnpm exec vitest run packages/server/src/api/routes/translation-preferences.test.ts packages/server/src/api/server.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the preference API**

```bash
git add packages/server/src/api packages/server/src/index.ts
git commit -m "feat(server): expose translation preferences"
```

### Task 5: Honor provider choice in HTTP and native translation paths

**Files:**
- Modify: `packages/server/src/api/routes/translate.ts`
- Modify: `packages/server/src/api/routes/messages.ts`
- Modify: `packages/server/src/api/routes/native.test.ts`
- Modify: `packages/server/src/api/routes/messages.test.ts`
- Create: `packages/server/src/api/routes/translate.test.ts`
- Modify: `packages/desktop/src/main/native-control-host.ts`
- Create: `packages/desktop/src/main/native-control-host.translation.test.ts`
- Modify: `packages/desktop/src/preload/native-bridge.ts`
- Modify: `packages/desktop/src/preload/native-translation-coordinator.ts`
- Modify: `packages/desktop/src/preload/native-translation-coordinator.test.ts`
- Modify: `packages/desktop/src/preload/native-bubble-translation-controller.ts`
- Modify: `packages/desktop/src/preload/native-bubble-translation-controller.test.ts`
- Modify: `packages/desktop/src/preload/whatsapp-web-translation.ts`
- Modify: `packages/desktop/src/preload/whatsapp-web-translation.test.ts`

**Interfaces:**
- Consumes: optional `provider` from Task 1 and `TranslationPreferenceService.resolve()` from Task 3.
- Produces: `{ requestedProvider, provider, downgraded }` on manual translation responses, where `provider` is actual.

- [ ] **Step 1: Add failing HTTP and native tests**

```ts
it('uses the user identity from the verified native grant', async () => {
  authorizeNativeControl.mockResolvedValue({ userId: OWNER_ID, accountId: ACCOUNT_ID })
  const response = await app.inject({
    method: 'POST', url: '/api/translate/batch', headers: nativeGrant(),
    payload: { texts: ['synthetic'], targetLang: 'zh', provider: 'openai' },
  })
  expect(preferences.resolve).toHaveBeenCalledWith(OWNER_ID, 'openai')
  expect(response.json().results[0]).toMatchObject({
    requestedProvider: 'openai', provider: 'deepl', downgraded: true,
  })
})
```

Add a separate strict-schema test that a body-supplied `userId` is rejected with 400. Add message preview coverage
proving a one-request Claude override is used for forward and back translation but is not written as the user
default. Add message-list coverage proving multiple provider rows neither duplicate a message nor return a provider
different from the resolved preference when that preferred row exists.

- [ ] **Step 2: Run the focused tests and verify failures**

Run: `pnpm exec vitest run packages/server/src/api/routes/translate.test.ts packages/server/src/api/routes/messages.test.ts packages/desktop/src/main/native-control-host.translation.test.ts`

Expected: FAIL because request schemas discard/reject the provider and native routes ignore the authorized user.

- [ ] **Step 3: Thread the resolved provider through each gateway call**

```ts
const control = isNativeControlAuthorization(req.headers.authorization)
  ? await authorizeNativeControl(req.headers.authorization)
  : null
const requestedProvider = await preferences.resolve(
  control?.userId ?? req.actor.userId,
  parsed.data.provider,
)
const translated = await gateway.translate({
  text, from, to, config: { global: requestedProvider },
})
```

For authenticated Bearer requests use `req.actor.userId`. For NativeGrant requests use `control.userId`. Map gateway
output to explicit requested/actual/downgraded metadata and retain per-item batch failure isolation. Update the
message-list translation joins to include the resolved provider so the new three-column key cannot duplicate rows.

- [ ] **Step 4: Forward optional provider through the Electron trust boundary**

Update `parseTranslationBatch` to accept only the shared provider union. Forward the same typed field from
renderer/main/preload; do not expose the grant or keys to guest pages. Include an explicit provider in the coordinator
in-flight key. When provider is absent and the server resolves the user's saved default from the grant, coalesce only
the current in-flight request and discard the settled client-side cache; Redis remains the durable cache. This prevents
a later preference change from reusing a settled result from another provider.

Preserve `requestedProvider`, actual `provider`, and `downgraded` through `NativeTranslationTextResult` and
`NativeBubbleTranslationController`. WhatsApp's inserted translation marker shows the short downgrade label next to
the translated text; normal results show only the provider label. The third-party page still receives no key, grant,
JWT, or raw upstream error.

Run: `pnpm exec vitest run packages/server/src/api/routes/translate.test.ts packages/server/src/api/routes/messages.test.ts packages/desktop/src/main/native-control-host.translation.test.ts packages/desktop/src/preload/native-translation-coordinator.test.ts packages/desktop/src/preload/native-bubble-translation-controller.test.ts packages/desktop/src/preload/whatsapp-web-translation.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit all request paths**

```bash
git add packages/server/src/api packages/desktop/src/main packages/desktop/src/preload
git commit -m "feat: honor per-request translation provider"
```

### Task 6: Add personal default-provider settings to the desktop

**Files:**
- Create: `packages/desktop/src/renderer/components/TranslationProviderDialog.tsx`
- Create: `packages/desktop/src/renderer/components/TranslationProviderDialog.test.tsx`
- Modify: `packages/desktop/src/renderer/api/client.ts`
- Modify: `packages/desktop/src/renderer/api/client.test.ts`
- Modify: `packages/desktop/src/renderer/App.tsx`
- Modify: `packages/desktop/src/renderer/components/AccountTabs.tsx`
- Modify: `packages/desktop/src/renderer/components/AccountTabs.test.tsx`
- Modify: `packages/desktop/src/renderer/store.ts`
- Modify: `packages/desktop/src/renderer/store.test.ts`

**Interfaces:**
- Produces: `api.getTranslationPreference()` and `api.setTranslationProvider(provider)`.
- Produces: dialog that saves the current employee's default and disables unavailable choices.

- [ ] **Step 1: Write failing API and component tests**

```tsx
it('shows all providers and prevents selecting an unavailable provider', () => {
  const html = renderToStaticMarkup(<TranslationProviderDialog
    open
    value="claude"
    providers={[
      { provider: 'deepl', available: true },
      { provider: 'claude', available: true },
      { provider: 'openai', available: false },
    ]}
    onSave={() => undefined}
    onClose={() => undefined}
  />)
  expect(html).toContain('DeepL')
  expect(html).toContain('Claude')
  expect(html).toContain('OpenAI')
  expect(html).toContain('暂不可用')
})
```

Add client tests for the exact GET/PATCH paths and typed bodies.

- [ ] **Step 2: Run tests and verify missing component/API failures**

Run: `pnpm exec vitest run packages/desktop/src/renderer/components/TranslationProviderDialog.test.tsx packages/desktop/src/renderer/api/client.test.ts`

Expected: FAIL because the dialog and API methods do not exist.

- [ ] **Step 3: Implement the API and dialog**

```ts
getTranslationPreference: () =>
  request<TranslationPreference>('/api/translation/providers'),
setTranslationProvider: (provider: TranslationProviderName) =>
  request<TranslationPreference>('/api/session/translation-provider', {
    method: 'PATCH', body: JSON.stringify({ provider }),
  }),
```

Use static labels `DeepL`, `Claude`, `OpenAI`. Add a store slice containing the authenticated user's preference DTO
and reset it with the existing logout/user-reset path. Load when the authenticated app bootstraps; save only after
server success. Show an inline error on failure and never persist this setting in localStorage.

- [ ] **Step 4: Wire the current-user menu**

Add `onTranslationSettings` beside “修改密码” and open the dialog from `App.tsx`. On logout/reset clear the in-memory preference snapshot so a second user cannot inherit the first user's choice.

Run: `pnpm exec vitest run packages/desktop/src/renderer/components/TranslationProviderDialog.test.tsx packages/desktop/src/renderer/components/AccountTabs.test.tsx packages/desktop/src/renderer/api/client.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit desktop settings**

```bash
git add packages/desktop/src/renderer
git commit -m "feat(desktop): save employee translation provider"
```

### Task 7: Add one-request provider switches and downgrade notices

**Files:**
- Modify: `packages/desktop/src/renderer/components/Composer.tsx`
- Modify: `packages/desktop/src/renderer/components/TranslationDock.tsx`
- Modify: `packages/desktop/src/renderer/components/TranslationDock.test.ts`
- Create: `packages/desktop/src/renderer/components/Composer.provider.test.tsx`
- Modify: `packages/desktop/src/renderer/api/client.ts`
- Modify: `packages/desktop/src/renderer/store.ts`

**Interfaces:**
- Consumes: availability/default snapshot from Task 6.
- Produces: optional provider argument on each preview/native translation action and visible actual-provider downgrade notice.

- [ ] **Step 1: Write failing selection-policy tests**

Extract a small pure helper and test it rather than asserting inline styles:

```ts
expect(translationProviderNotice({
  requestedProvider: 'claude', provider: 'deepl', downgraded: true,
})).toBe('Claude 暂时不可用，本次已由 DeepL 完成')
expect(translationProviderNotice({
  requestedProvider: 'deepl', provider: 'deepl', downgraded: false,
})).toBe(null)
```

Add a component/controller test that selecting OpenAI sends `{ provider: 'openai' }` but leaves the saved default unchanged.

- [ ] **Step 2: Run tests and verify missing behavior**

Run: `pnpm exec vitest run packages/desktop/src/renderer/components/Composer.provider.test.tsx packages/desktop/src/renderer/components/TranslationDock.test.ts`

Expected: FAIL because neither component exposes a provider selection.

- [ ] **Step 3: Add per-action selectors**

Place a compact “本次翻译” selector next to the reply-language controls in `Composer` and `TranslationDock`. Initialize it from the user's default when the authenticated user changes; selecting another available provider changes only local component/draft state.

```ts
const result = await api.translatePreview(
  conversationId,
  sourceText,
  oneRequestProvider,
)
```

Provider changes invalidate current preview, back-translation, send attempt and provider-specific coordinator cache exactly as target-language changes already do.

- [ ] **Step 4: Show actual provider without leaking upstream errors**

Store `requestedProvider`, actual `provider`, and `downgraded` beside the draft result. Render the short notice only
when downgraded. For a normal result render `由 DeepL/Claude/OpenAI 翻译` near the preview. Do not put raw provider
exceptions in UI.

Run: `pnpm exec vitest run packages/desktop/src/renderer/components/Composer.provider.test.tsx packages/desktop/src/renderer/components/TranslationDock.test.ts packages/desktop/src/preload/native-translation-coordinator.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit per-request UI**

```bash
git add packages/desktop/src/renderer packages/desktop/src/preload
git commit -m "feat(desktop): switch provider per translation"
```

### Task 8: Translation feature regression and documentation checkpoint

**Files:**
- Modify: `docs/RUNBOOK.md`
- Modify: `.env.example`
- Test: all translation, API, native bridge, renderer, migration, and shared tests.

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces: a reviewed, documented translation-provider feature ready for production-hardening work.

- [ ] **Step 1: Document only variable names and behavior**

Document `DEEPL_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEFAULT_TRANSLATION_PROVIDER=deepl`, personal default behavior, per-request override, and fallback disclosure. Keep values blank in `.env.example`.

- [ ] **Step 2: Run focused tests**

Run: `pnpm exec vitest run packages/shared/src/translation-provider.test.ts packages/server/src/translation packages/server/src/api/routes/translation-preferences.test.ts packages/server/src/api/routes/translate.test.ts packages/server/src/api/routes/messages.test.ts packages/server/src/db/migrations/0017_translation_provider_preferences.test.ts packages/desktop/src/main/native-control-host.translation.test.ts packages/desktop/src/preload/native-translation-coordinator.test.ts packages/desktop/src/renderer/components/TranslationProviderDialog.test.tsx packages/desktop/src/renderer/components/Composer.provider.test.tsx packages/desktop/src/renderer/components/TranslationDock.test.ts`

Expected: PASS.

- [ ] **Step 3: Run repository-wide verification**

Run: `pnpm typecheck`

Expected: PASS.

Run: `pnpm test`

Expected: PASS with no production database URL involved.

Run: `pnpm --filter @im-hub/desktop build`

Expected: PASS.

- [ ] **Step 4: Review sensitive-data and migration diff**

Run: `git diff --check && git status --short && git diff --name-only`

Expected: only intended source/tests/docs and `pnpm-lock.yaml`; no `.env`, `data/`, session, QR, credential, build output, or npm/yarn lockfile.

- [ ] **Step 5: Commit the verified checkpoint**

```bash
git add .env.example docs/RUNBOOK.md
git commit -m "docs: record translation provider controls"
```
