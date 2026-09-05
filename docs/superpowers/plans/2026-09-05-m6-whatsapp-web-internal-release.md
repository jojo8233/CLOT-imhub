# M6 WhatsApp Web Internal Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a company-internal, unsigned macOS/Windows im-hub package whose only employee-visible WhatsApp onboarding route is isolated WhatsApp Web.

**Architecture:** Keep the existing `web_shell` bridge and Cloud API backend as separate routes, but centralize a desktop product policy that exposes only Web and renders legacy Cloud accounts as unavailable. Compile one validated company HTTPS origin into internal packages, reuse the existing per-account partitions and fail-closed bridge, and package the Electron app with electron-builder; Windows artifacts come from a same-repository PR/manual GitHub workflow and macOS artifacts come from the same commit locally.

**Tech Stack:** Node.js 22+, pnpm 10, TypeScript ESM, React 19, Electron 33, electron-vite 2, Vitest 2, electron-builder 26.15.3, GitHub Actions, PostgreSQL 16, Redis.

**Spec:** `docs/superpowers/specs/2026-09-05-m6-whatsapp-web-internal-release-design.md`

## Global Constraints

- Work only in `/private/tmp/im-hub-m3-outbox` on `codex/m6-whatsapp-web-internal`; do not modify the main checkout.
- Use `pnpm`; do not create npm or yarn lockfiles. Keep TypeScript strict and ESM relative imports ending in `.js`.
- Preserve `cloud_api` shared types, migrations, server routes, services, encrypted secrets, and automated tests. Do not convert or delete existing Cloud accounts.
- New WhatsApp accounts use `connection_mode=web_shell`; Web DOM messages do not enter the central `messages` table, customer-profile association, or keyword alerts.
- Keep every WhatsApp account in its existing `persist:native-<accountId>` partition. Never log or package platform profiles, sessions, QR links, account identities, message bodies, DOM message IDs, JWTs, grants, or secrets.
- Internal packaged builds require an exact HTTPS origin with no credentials, path, query, or fragment. The URL is not a credential and must still be protected by server-side authentication and RBAC.
- The first package is manual-update and unsigned. Do not add auto-update, a release feed, or a GitHub Release. Use stable app ID `org.imhub.desktop`, product name `im-hub`, and artifact names containing `internal-unsigned`.
- macOS acceptance is read-only. Windows acceptance permits at most one user-confirmed, non-sensitive text send and never an automatic send.
- Before database tests, silently load the existing root `.env`; confirm tests derive and use the isolated `_test` database. Never print the environment.
- A task is complete only after its listed tests pass and its focused commit is created. Do not batch unrelated refactors into these commits.

---

### Task 1: Centralize the WhatsApp Web-only desktop product policy

**Files:**
- Create: `packages/desktop/src/renderer/whatsapp-product-policy.ts`
- Create: `packages/desktop/src/renderer/whatsapp-product-policy.test.ts`

**Interfaces:**
- Consumes: `AccountConnectionMode` from `@im-hub/shared`.
- Produces: `WHATSAPP_CREATION_MODE`, `WHATSAPP_PRODUCT_BLURB`, `WhatsAppProductSurface`, `whatsAppProductSurface(account)`, `whatsAppWebAccount(account)`, and `whatsAppLegacyCloudNotice(account)` for Tasks 2–4.

- [ ] **Step 1: Write the failing product-policy test**

```ts
import { describe, expect, it } from 'vitest'
import {
  WHATSAPP_CREATION_MODE,
  WHATSAPP_PRODUCT_BLURB,
  whatsAppLegacyCloudNotice,
  whatsAppProductSurface,
  whatsAppWebAccount,
} from './whatsapp-product-policy.js'

describe('WhatsApp Web-only product policy', () => {
  it('fixes all new employee-visible accounts to web_shell', () => {
    expect(WHATSAPP_CREATION_MODE).toBe('web_shell')
    expect(WHATSAPP_PRODUCT_BLURB).toBe('WhatsApp Web 双语页面')
  })

  it('keeps web_shell and historical adapter accounts on the Web surface', () => {
    for (const connection_mode of ['web_shell', 'adapter'] as const) {
      const account = { platform: 'whatsapp', connection_mode }
      expect(whatsAppProductSurface(account)).toBe('web')
      expect(whatsAppWebAccount(account)).toBe(true)
      expect(whatsAppLegacyCloudNotice(account)).toBeNull()
    }
  })

  it('preserves Cloud accounts but marks them unavailable', () => {
    const account = { platform: 'whatsapp', connection_mode: 'cloud_api' }
    expect(whatsAppProductSurface(account)).toBe('legacy_cloud')
    expect(whatsAppWebAccount(account)).toBe(false)
    expect(whatsAppLegacyCloudNotice(account)).toBe('旧 Cloud 账号（当前产品不支持连接）')
  })

  it('does not classify other platforms as WhatsApp', () => {
    expect(whatsAppProductSurface({
      platform: 'signal', connection_mode: 'native_desktop',
    })).toBe('other')
    expect(whatsAppProductSurface(undefined)).toBe('other')
  })
})
```

- [ ] **Step 2: Run the test and verify the missing module fails**

Run:

```bash
pnpm exec vitest run packages/desktop/src/renderer/whatsapp-product-policy.test.ts
```

Expected: FAIL because `whatsapp-product-policy.js` does not exist.

- [ ] **Step 3: Implement the minimal centralized policy**

```ts
import type { AccountConnectionMode } from '@im-hub/shared'

export const WHATSAPP_CREATION_MODE = 'web_shell' as const satisfies AccountConnectionMode
export const WHATSAPP_PRODUCT_BLURB = 'WhatsApp Web 双语页面'

export type WhatsAppProductSurface = 'web' | 'legacy_cloud' | 'other'

interface ProductAccount {
  platform: string
  connection_mode: string
}

export function whatsAppProductSurface(
  account: ProductAccount | undefined,
): WhatsAppProductSurface {
  if (account?.platform !== 'whatsapp') return 'other'
  if (account.connection_mode === 'web_shell' || account.connection_mode === 'adapter') return 'web'
  if (account.connection_mode === 'cloud_api') return 'legacy_cloud'
  return 'other'
}

export function whatsAppWebAccount(account: ProductAccount | undefined): boolean {
  return whatsAppProductSurface(account) === 'web'
}

export function whatsAppLegacyCloudNotice(account: ProductAccount | undefined): string | null {
  return whatsAppProductSurface(account) === 'legacy_cloud'
    ? '旧 Cloud 账号（当前产品不支持连接）'
    : null
}
```

- [ ] **Step 4: Run the test and typecheck**

Run:

```bash
pnpm exec vitest run packages/desktop/src/renderer/whatsapp-product-policy.test.ts
pnpm typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 5: Commit the policy**

```bash
git add packages/desktop/src/renderer/whatsapp-product-policy.ts packages/desktop/src/renderer/whatsapp-product-policy.test.ts
git commit -m "feat(desktop): define WhatsApp Web-only product policy"
```

---

### Task 2: Remove Cloud API from employee-visible WhatsApp onboarding

**Files:**
- Create: `packages/desktop/src/renderer/components/AddAccountDialog.product.test.tsx`
- Modify: `packages/desktop/src/renderer/components/AddAccountDialog.tsx`
- Test: `packages/desktop/src/renderer/components/AddAccountDialog.organization.test.ts`

**Interfaces:**
- Consumes: `WHATSAPP_CREATION_MODE` and `WHATSAPP_PRODUCT_BLURB` from Task 1.
- Produces: `connectionModeForPlatform(platform): 'adapter' | 'native_desktop' | 'web_shell'`; the rendered WhatsApp form has exactly one Web path and no Cloud configuration probe.

- [ ] **Step 1: Write the failing rendered-product test**

```tsx
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AddAccountDialog, connectionModeForPlatform } from './AddAccountDialog.js'

describe('AddAccountDialog WhatsApp product route', () => {
  it('shows only WhatsApp Web onboarding', () => {
    const html = renderToStaticMarkup(<AddAccountDialog
      initialPlatform="whatsapp"
      role="agent"
      onClose={() => undefined}
      onAccountsChanged={async () => undefined}
    />)
    expect(html).toContain('WhatsApp Web 双语页面')
    expect(html).toContain('创建并扫码')
    expect(html).not.toContain('Cloud API')
    expect(html).not.toContain('Meta Embedded Signup')
  })

  it('always maps WhatsApp creation to web_shell', () => {
    expect(connectionModeForPlatform('whatsapp')).toBe('web_shell')
    expect(connectionModeForPlatform('signal')).toBe('native_desktop')
    expect(connectionModeForPlatform('telegram')).toBe('adapter')
  })
})
```

- [ ] **Step 2: Run the test and verify it fails against the current dual-route UI**

Run:

```bash
pnpm exec vitest run packages/desktop/src/renderer/components/AddAccountDialog.product.test.tsx
```

Expected: FAIL because the rendered form contains Cloud API/Meta text and `connectionModeForPlatform` is missing.

- [ ] **Step 3: Collapse the component to one WhatsApp path**

In `AddAccountDialog.tsx`:

- remove `WhatsAppOnboardingStatus`, `WhatsAppMode`, the `cloud` step, Cloud session/status state, the Cloud config effect, onboarding polling, Cloud-specific submit logic, and `WhatsAppCloudStep`;
- keep Cloud methods in `api/client.ts` because the backend route is intentionally preserved;
- import the Task 1 constants;
- change the WhatsApp card blurb and form copy to Web only;
- make account creation call this helper:

```ts
export function connectionModeForPlatform(
  platform: ChatPlatform,
): 'adapter' | 'native_desktop' | 'web_shell' {
  if (platform === 'signal') return 'native_desktop'
  if (platform === 'whatsapp') return WHATSAPP_CREATION_MODE
  return 'adapter'
}
```

Use `connectionModeForPlatform(platform)` in `handleCreate()` and leave the existing role/team scoping helper unchanged.

- [ ] **Step 4: Prove the Cloud probe and text are absent from the employee component**

Run:

```bash
rg -n "getWhatsAppCloudConfig|startWhatsAppCloudOnboarding|WhatsAppCloudStep|Cloud API|Meta Embedded" packages/desktop/src/renderer/components/AddAccountDialog.tsx
```

Expected: no matches.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
pnpm exec vitest run packages/desktop/src/renderer/components/AddAccountDialog.product.test.tsx packages/desktop/src/renderer/components/AddAccountDialog.organization.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the Web-only onboarding change**

```bash
git add packages/desktop/src/renderer/components/AddAccountDialog.tsx packages/desktop/src/renderer/components/AddAccountDialog.product.test.tsx packages/desktop/src/renderer/components/AddAccountDialog.organization.test.ts
git commit -m "feat(desktop): expose only WhatsApp Web onboarding"
```

---

### Task 3: Render legacy Cloud accounts without connecting them

**Files:**
- Modify: `packages/desktop/src/renderer/components/NativeClient.tsx`
- Modify: `packages/desktop/src/renderer/components/NativeClient.test.ts`
- Modify: `packages/desktop/src/renderer/components/NativeConversationWorkspace.tsx`
- Create: `packages/desktop/src/renderer/components/NativeConversationWorkspace.test.tsx`
- Modify: `packages/desktop/src/renderer/layout.ts`
- Modify: `packages/desktop/src/renderer/layout.test.ts`
- Modify: `packages/desktop/src/renderer/components/OrganizationAdminAccounts.tsx`
- Modify: `packages/desktop/src/renderer/components/OrganizationAdminAccounts.test.tsx`
- Test: `packages/desktop/src/renderer/whatsapp-product-policy.test.ts`

**Interfaces:**
- Consumes: `whatsAppWebAccount(account)` and `whatsAppLegacyCloudNotice(account)` from Task 1.
- Produces: one routing rule shared by pre-mounting, the active conversation surface, and owner account management. A legacy Cloud account stays visible but never mounts a webview or `ChatWorkspace`.

- [ ] **Step 1: Extend the failing routing and management tests**

Add to `NativeClient.test.ts`:

Extend its Vitest import to include `vi`, then add:

```ts
it('never mounts a legacy Cloud account as a local client', () => {
  const accounts = [{
    id: 'wa-cloud', platform: 'whatsapp', owner_user_id: 'user-1',
    connection_mode: 'cloud_api', desktop_mount_state: 'ready',
  }] satisfies Array<Pick<AccountRow,
    'id' | 'platform' | 'owner_user_id' | 'connection_mode' | 'desktop_mount_state'>>

  expect(nativeAccountIdsToMount(accounts, { id: 'user-1', role: 'agent' }, true)).toEqual([])
  expect(ownedLocalAccountIds(accounts, { id: 'user-1', role: 'agent' }, {
    webview: true, signalDesktop: false,
  })).toEqual([])
})
```

Add a second case to `OrganizationAdminAccounts.test.tsx` using an item with
`platform: 'whatsapp'` and `connectionMode: 'cloud_api'`, then assert:

```ts
expect(html).toContain('旧 Cloud 账号（当前产品不支持连接）')
expect(html).toContain('转移负责人 / 团队')
expect(html).not.toContain('转换为 Web')
```

Create `NativeConversationWorkspace.test.tsx` and render the exported legacy placeholder directly:

```tsx
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LegacyWhatsAppCloudWorkspace } from './NativeConversationWorkspace.js'

describe('legacy WhatsApp Cloud workspace', () => {
  it('shows an unavailable placeholder without chat or translation actions', () => {
    const html = renderToStaticMarkup(<LegacyWhatsAppCloudWorkspace />)
    expect(html).toContain('旧 Cloud 账号')
    expect(html).toContain('当前产品不支持连接')
    expect(html).not.toContain('发送')
    expect(html).not.toContain('翻译')
  })
})
```

Change `layout.test.ts` so no test expects a Cloud account to open `ChatWorkspace`; remove the obsolete `usesCloudConversationWorkspace` suite.

- [ ] **Step 2: Run the tests and verify the management label/routing change fails**

Run:

```bash
pnpm exec vitest run packages/desktop/src/renderer/components/NativeClient.test.ts packages/desktop/src/renderer/components/NativeConversationWorkspace.test.tsx packages/desktop/src/renderer/components/OrganizationAdminAccounts.test.tsx packages/desktop/src/renderer/layout.test.ts
```

Expected: FAIL because the owner view lacks the legacy label and Cloud accounts still route to `ChatWorkspace`.

- [ ] **Step 3: Apply the centralized policy to every desktop consumer**

In `NativeClient.tsx`, replace repeated WhatsApp mode conditions in `nativeAccountIdsToMount()` and
`ownedLocalAccountIds()` with `whatsAppWebAccount(account)`. Replace its existing defensive
unsupported-WhatsApp overlay with the approved legacy notice, and remove the instruction to finish
Cloud authorization; this branch must not mount a Web client or offer an action.

In `NativeConversationWorkspace.tsx`, select the active account with `whatsAppProductSurface()`. Export and render a dedicated `LegacyWhatsAppCloudWorkspace` for `legacy_cloud`; it contains only the approved unavailable message and does not instantiate `NativeClient`, `TranslationDock`, or `ChatWorkspace`. All other accounts keep the native-client workspace. Remove `usesCloudConversationWorkspace()` from `layout.ts` and its tests.

In `OrganizationAdminAccounts.tsx`, call `whatsAppLegacyCloudNotice({
platform: item.platform, connection_mode: item.connectionMode })` next to the raw connection mode. Do not add conversion or reconnection actions.

- [ ] **Step 4: Run the focused routing tests and typecheck**

Run:

```bash
pnpm exec vitest run packages/desktop/src/renderer/whatsapp-product-policy.test.ts packages/desktop/src/renderer/components/NativeClient.test.ts packages/desktop/src/renderer/components/NativeConversationWorkspace.test.tsx packages/desktop/src/renderer/components/OrganizationAdminAccounts.test.tsx packages/desktop/src/renderer/layout.test.ts
pnpm typecheck
```

Expected: PASS; `cloud_api` remains a valid shared/server value.

- [ ] **Step 5: Commit legacy compatibility**

```bash
git add packages/desktop/src/renderer/whatsapp-product-policy.ts packages/desktop/src/renderer/whatsapp-product-policy.test.ts packages/desktop/src/renderer/components/NativeClient.tsx packages/desktop/src/renderer/components/NativeClient.test.ts packages/desktop/src/renderer/components/NativeConversationWorkspace.tsx packages/desktop/src/renderer/components/NativeConversationWorkspace.test.tsx packages/desktop/src/renderer/layout.ts packages/desktop/src/renderer/layout.test.ts packages/desktop/src/renderer/components/OrganizationAdminAccounts.tsx packages/desktop/src/renderer/components/OrganizationAdminAccounts.test.tsx
git commit -m "feat(desktop): retain legacy WhatsApp Cloud accounts safely"
```

---

### Task 4: Make WhatsApp bridge failures short, visible, and retryable

**Files:**
- Modify: `packages/desktop/src/renderer/components/NativeClient.tsx`
- Modify: `packages/desktop/src/renderer/components/NativeClient.test.ts`
- Modify: `packages/desktop/src/renderer/components/TranslationDock.tsx`
- Modify: `packages/desktop/src/renderer/components/TranslationDock.test.ts`
- Test: `packages/desktop/src/preload/whatsapp-web-health.test.ts`
- Test: `packages/desktop/src/preload/whatsapp-web-send-action.test.ts`

**Interfaces:**
- Produces: `nativeBridgeUserMessage(platform, event)`, `reloadNativeWebview(view)`, and `nativeConnectionUnavailableReason(platform, connection, error)`.
- Preserves: a ready WhatsApp page remains visible while bridge/store state becomes failed, so translation and controlled send are disabled by the existing dock gate.

- [ ] **Step 1: Write failing short-message and retry tests**

Add to `NativeClient.test.ts`:

```ts
it('redacts WhatsApp structural diagnostics from the user prompt', () => {
  expect(nativeBridgeUserMessage('whatsapp', {
    code: 'whatsapp_dom_selector_unavailable',
    message: 'WhatsApp 页面结构已变化；安全诊断：{"selectors":999}',
  })).toBe('WhatsApp 页面版本暂不兼容，请重新加载后重试')
  expect(nativeBridgeUserMessage('whatsapp', {
    code: 'whatsapp_translation_marker_hidden',
    message: 'diagnostic payload',
  })).toBe('WhatsApp 译文暂时无法显示，请重新加载后重试')
  expect(nativeBridgeUserMessage('whatsapp', {
    code: 'unexpected_bridge_diagnostic',
    message: 'internal selector and payload details',
  })).toBe('WhatsApp 页面连接暂时不可用，请重新加载后重试')
})

it('reloads only the selected webview for an explicit retry', () => {
  const reload = vi.fn()
  expect(reloadNativeWebview({ reload })).toBe(true)
  expect(reload).toHaveBeenCalledOnce()
  expect(reloadNativeWebview(null)).toBe(false)
})
```

Add to `TranslationDock.test.ts`:

```ts
it('disables native composer actions whenever the bridge is not ready', () => {
  expect(nativeConnectionUnavailableReason('whatsapp', 'failed', '页面版本暂不兼容'))
    .toBe('页面版本暂不兼容')
  expect(nativeConnectionUnavailableReason('whatsapp', 'waiting', null))
    .toBe('等待 WhatsApp 原生输入桥接')
  expect(nativeConnectionUnavailableReason('whatsapp', 'ready', null)).toBeNull()
})
```

- [ ] **Step 2: Run the tests and verify the helpers are missing**

Run:

```bash
pnpm exec vitest run packages/desktop/src/renderer/components/NativeClient.test.ts packages/desktop/src/renderer/components/TranslationDock.test.ts
```

Expected: FAIL on the three missing exports.

- [ ] **Step 3: Implement fail-closed presentation without hiding the official page**

Add pure mappings in `NativeClient.tsx`:

```ts
export function nativeBridgeUserMessage(
  platform: string,
  event: { code: string; message: string },
): string {
  if (platform === 'whatsapp' && event.code === 'whatsapp_dom_selector_unavailable') {
    return 'WhatsApp 页面版本暂不兼容，请重新加载后重试'
  }
  if (platform === 'whatsapp' && event.code === 'whatsapp_translation_marker_hidden') {
    return 'WhatsApp 译文暂时无法显示，请重新加载后重试'
  }
  if (platform === 'whatsapp') {
    return 'WhatsApp 页面连接暂时不可用，请重新加载后重试'
  }
  return event.message
}

export function reloadNativeWebview(view: { reload(): void } | null): boolean {
  if (!view) return false
  view.reload()
  return true
}
```

When a `bridge.error` arrives, set the short local `controlError` and set store connection to `failed`; when `bridge.ready` recovers, clear `controlError`. Keep `state === 'ready'`, show a small “重新加载” button in the banner, and call only the selected webview's `reload()`.

Extract the connection part of `TranslationDock` availability into:

```ts
export function nativeConnectionUnavailableReason(
  platform: string,
  connection: 'loading' | 'waiting' | 'ready' | 'failed' | undefined,
  error: string | null | undefined,
): string | null {
  if (connection === 'failed') return error ?? '原生客户端桥接失败'
  if (connection !== 'ready') return `等待 ${PLATFORM_LABEL[platform] ?? platform} 原生输入桥接`
  return null
}
```

Use it after the existing role/ownership checks. Do not enable translate/send while it returns a value.

- [ ] **Step 4: Run failure and DOM regression tests**

Run:

```bash
pnpm exec vitest run packages/desktop/src/renderer/components/NativeClient.test.ts packages/desktop/src/renderer/components/TranslationDock.test.ts packages/desktop/src/preload/whatsapp-web-health.test.ts packages/desktop/src/preload/whatsapp-web-send-action.test.ts packages/desktop/src/preload/whatsapp-web-send.test.ts
pnpm typecheck
```

Expected: PASS; no test performs a real send.

- [ ] **Step 5: Commit failure hardening**

```bash
git add packages/desktop/src/renderer/components/NativeClient.tsx packages/desktop/src/renderer/components/NativeClient.test.ts packages/desktop/src/renderer/components/TranslationDock.tsx packages/desktop/src/renderer/components/TranslationDock.test.ts
git commit -m "fix(desktop): fail closed on WhatsApp Web bridge errors"
```

---

### Task 5: Compile a validated company server origin and show the internal-build badge

**Files:**
- Create: `packages/desktop/src/internal-release-config.ts`
- Create: `packages/desktop/src/internal-release-config.test.ts`
- Create: `packages/desktop/src/internal-release-globals.d.ts`
- Modify: `packages/desktop/electron.vite.config.ts`
- Modify: `packages/desktop/src/main/imhub-window-runtime.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/preload/index.test.ts`
- Modify: `packages/desktop/src/renderer/types.d.ts`
- Modify: `packages/desktop/src/renderer/App.tsx`
- Modify: `packages/desktop/src/renderer/api/client.ts`
- Modify: `packages/desktop/src/renderer/api/client.test.ts`
- Modify: `packages/desktop/src/renderer/components/AccountTabs.tsx`
- Create: `packages/desktop/src/renderer/components/AccountTabs.test.tsx`

**Interfaces:**
- Produces: `DesktopReleaseChannel`, `resolveInternalReleaseBuild(env)`, `compiledInternalServerUrl()`, `compiledInternalWsUrl()`, `compiledReleaseChannel()`, `desktopServerUrl(compiled, runtime)`, `desktopWebSocketUrl(compiled, serverUrl)`, and `websocketEndpoint(wsOrigin)`.
- Changes trusted preload shape to include `wsUrl` and `release: { channel: 'development' | 'internal-unsigned' }`.

- [ ] **Step 1: Write failing origin validation tests**

```ts
import { describe, expect, it } from 'vitest'
import {
  desktopServerUrl,
  desktopWebSocketUrl,
  resolveInternalReleaseBuild,
} from './internal-release-config.js'

describe('internal desktop release config', () => {
  it('requires one exact HTTPS origin for an internal package', () => {
    expect(resolveInternalReleaseBuild({
      IM_HUB_INTERNAL_RELEASE: '1',
      IM_HUB_SERVER_URL: 'https://imhub.example.test',
    })).toEqual({
      channel: 'internal-unsigned',
      serverUrl: 'https://imhub.example.test',
      wsUrl: 'wss://imhub.example.test',
    })
  })

  it.each([
    undefined,
    'http://imhub.example.test',
    'https://user:password@imhub.example.test',
    'https://imhub.example.test/api',
    'https://imhub.example.test?tenant=1',
    'https://imhub.example.test/#fragment',
  ])('rejects an unsafe packaged origin: %s', (serverUrl) => {
    expect(() => resolveInternalReleaseBuild({
      IM_HUB_INTERNAL_RELEASE: '1',
      IM_HUB_SERVER_URL: serverUrl,
    })).toThrow('IM_HUB_SERVER_URL')
  })

  it('keeps localhost only as an explicit non-internal fallback', () => {
    expect(resolveInternalReleaseBuild({})).toEqual({
      channel: 'development', serverUrl: null, wsUrl: null,
    })
    expect(desktopServerUrl(null, undefined)).toBe('http://localhost:4000')
    expect(desktopServerUrl(null, 'http://127.0.0.1:4000')).toBe('http://127.0.0.1:4000')
    expect(desktopWebSocketUrl(null, 'http://127.0.0.1:4000')).toBe('ws://127.0.0.1:4000')
  })

  it('never lets runtime environment override compiled internal origins', () => {
    expect(desktopServerUrl(
      'https://imhub.example.test', 'https://override.invalid',
    )).toBe('https://imhub.example.test')
    expect(desktopWebSocketUrl(
      'wss://imhub.example.test', 'http://override.invalid',
    )).toBe('wss://imhub.example.test')
  })
})
```

- [ ] **Step 2: Write failing preload/badge tests**

Extend `preload/index.test.ts` to assert:

```ts
const bridge = electron.exposed as {
  serverUrl: string
  wsUrl: string
  release: { channel: string }
}
expect(bridge.release).toEqual({ channel: 'development' })
expect(bridge.serverUrl).toBe('http://localhost:4000')
expect(bridge.wsUrl).toBe('ws://localhost:4000')
```

Extend `renderer/api/client.test.ts` to import `websocketEndpoint` and assert that it consumes the
preload-provided WebSocket origin directly:

```ts
expect(websocketEndpoint('wss://imhub.example.test'))
  .toBe('wss://imhub.example.test/ws')
```

Create `AccountTabs.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Brand } from './AccountTabs.js'

describe('internal release badge', () => {
  it('is visible only in internal unsigned packages', () => {
    expect(renderToStaticMarkup(<Brand releaseChannel="internal-unsigned" />))
      .toContain('内部未签名测试版')
    expect(renderToStaticMarkup(<Brand releaseChannel="development" />))
      .not.toContain('内部未签名测试版')
  })
})
```

- [ ] **Step 3: Run the tests and verify the release module/API are missing**

Run:

```bash
pnpm exec vitest run packages/desktop/src/internal-release-config.test.ts packages/desktop/src/preload/index.test.ts packages/desktop/src/renderer/api/client.test.ts packages/desktop/src/renderer/components/AccountTabs.test.tsx
```

Expected: FAIL on missing module, preload metadata, and `Brand` export.

- [ ] **Step 4: Implement exact-origin parsing and build constants**

`resolveInternalReleaseBuild()` must parse with `new URL()`, require `url.origin === raw` or
`raw === url.origin + '/'`, reject credentials/path/query/fragment, require HTTPS for internal builds, and derive WSS by changing only the protocol.

Declare build constants:

```ts
declare const __IM_HUB_SERVER_URL__: string | null
declare const __IM_HUB_WS_URL__: string | null
declare const __IM_HUB_RELEASE_CHANNEL__: 'development' | 'internal-unsigned'
```

In `electron.vite.config.ts`, calculate once and provide the same `define` object to `main`, `preload`, and `renderer`:

```ts
const release = resolveInternalReleaseBuild(process.env)
const releaseDefine = {
  __IM_HUB_SERVER_URL__: JSON.stringify(release.serverUrl),
  __IM_HUB_WS_URL__: JSON.stringify(release.wsUrl),
  __IM_HUB_RELEASE_CHANNEL__: JSON.stringify(release.channel),
}
```

`compiledInternalServerUrl()`, `compiledInternalWsUrl()`, and `compiledReleaseChannel()` must use
`typeof` checks so Vitest/non-bundled execution safely returns `null`/`null`/`development`.

- [ ] **Step 5: Route main/preload traffic through the same compiled origin**

In `imhub-window-runtime.ts`, replace both direct `process.env.IM_HUB_SERVER_URL` fallbacks with one module-level value:

```ts
const configuredServerUrl = desktopServerUrl(
  compiledInternalServerUrl(),
  process.env.IM_HUB_SERVER_URL,
)
```

Use it for `NativeControlHost` and `DesktopInstallationManager`.

In `preload/index.ts`, expose `serverUrl`, the separately compiled/derived `wsUrl`, and the release
channel. Extend `renderer/types.d.ts`. In `renderer/api/client.ts`, stop deriving WebSocket protocol
from `BASE`; read `window.imHub.wsUrl` and call exported `websocketEndpoint(wsUrl)`, with only the
explicit non-Electron development fallback `ws://localhost:4000`. In `App.tsx`, pass
`window.imHub?.release?.channel ?? 'development'` into `AccountTabs`; export `Brand` and render a
compact “内部未签名测试版” badge only for `internal-unsigned`.

- [ ] **Step 6: Verify build-time failure and safe success paths**

Run:

```bash
IM_HUB_INTERNAL_RELEASE=1 pnpm --filter @im-hub/desktop build
```

Expected: FAIL before bundling with a non-sensitive message that `IM_HUB_SERVER_URL` is required.

Run:

```bash
IM_HUB_INTERNAL_RELEASE=1 IM_HUB_SERVER_URL=https://imhub.example.test pnpm --filter @im-hub/desktop build
pnpm exec vitest run packages/desktop/src/internal-release-config.test.ts packages/desktop/src/preload/index.test.ts packages/desktop/src/renderer/api/client.test.ts packages/desktop/src/renderer/components/AccountTabs.test.tsx packages/desktop/src/main/signal-integrated-policy.test.ts
pnpm typecheck
```

Expected: PASS. `https://imhub.example.test` is a reserved test origin and the resulting build is not distributable.

- [ ] **Step 7: Commit release origin and badge support**

```bash
git add packages/desktop/electron.vite.config.ts packages/desktop/src/internal-release-config.ts packages/desktop/src/internal-release-config.test.ts packages/desktop/src/internal-release-globals.d.ts packages/desktop/src/main/imhub-window-runtime.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/index.test.ts packages/desktop/src/renderer/types.d.ts packages/desktop/src/renderer/App.tsx packages/desktop/src/renderer/api/client.ts packages/desktop/src/renderer/api/client.test.ts packages/desktop/src/renderer/components/AccountTabs.tsx packages/desktop/src/renderer/components/AccountTabs.test.tsx
git commit -m "feat(desktop): bind internal builds to company server"
```

---

### Task 6: Add deterministic unsigned DMG and NSIS packaging

**Files:**
- Modify: `packages/desktop/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.gitignore`
- Create: `packages/desktop/scripts/package-internal.mjs`
- Create: `packages/desktop/scripts/package-internal.test.mjs`

**Interfaces:**
- Consumes: `IM_HUB_SERVER_URL`; always injects `IM_HUB_INTERNAL_RELEASE=1` and `CSC_IDENTITY_AUTO_DISCOVERY=false` into build/package children.
- Produces: `package:internal:mac`, `package:internal:win`, `builderArguments(target)`, `unsignedBuildEnvironment(env)`, a non-sensitive JSON build manifest, and a production-dependency license inventory that must travel with the installer.

- [ ] **Step 1: Add the packaging dependency with pnpm**

Run:

```bash
pnpm --filter @im-hub/desktop add -D electron-builder@26.15.3
```

Expected: only `packages/desktop/package.json` and `pnpm-lock.yaml` change; no npm/yarn lockfile appears.

- [ ] **Step 2: Write the failing package-script test**

```js
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  builderArguments,
  createInternalBuildManifest,
  unsignedBuildEnvironment,
} from './package-internal.mjs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe('internal desktop packaging', () => {
  it('uses stable unsigned DMG/NSIS metadata', () => {
    expect(pkg.version).toBe('0.1.0-internal.1')
    expect(pkg.build.appId).toBe('org.imhub.desktop')
    expect(pkg.build.productName).toBe('im-hub')
    expect(pkg.build.artifactName).toContain('internal-unsigned')
    expect(pkg.build.nsis).toMatchObject({ oneClick: false, perMachine: false })
    expect(pkg.scripts['licenses:prod']).toBe('pnpm licenses list --prod --json')
  })

  it('selects only the requested platform target', () => {
    expect(builderArguments('mac')).toEqual(['--mac', 'dmg', '--publish', 'never'])
    expect(builderArguments('win')).toEqual(['--win', 'nsis', '--x64', '--publish', 'never'])
  })

  it('forces this channel to remain unsigned without exposing inherited signing config', () => {
    const env = unsignedBuildEnvironment({
      PATH: '/test/bin',
      IM_HUB_SERVER_URL: 'https://imhub.example.test',
      CSC_LINK: 'dummy-signing-material',
      WIN_CSC_LINK: 'dummy-windows-signing-material',
      APPLE_ID: 'dummy-apple-id',
    })
    expect(env).toMatchObject({
      PATH: '/test/bin',
      IM_HUB_SERVER_URL: 'https://imhub.example.test',
      IM_HUB_INTERNAL_RELEASE: '1',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    })
    expect(env).not.toHaveProperty('CSC_LINK')
    expect(env).not.toHaveProperty('WIN_CSC_LINK')
    expect(env).not.toHaveProperty('APPLE_ID')
  })

  it('writes a non-sensitive manifest', () => {
    expect(createInternalBuildManifest({
      commit: 'abc123', version: '0.1.0-internal.1', target: 'win', arch: 'x64',
      serverOrigin: 'https://imhub.example.test', artifacts: ['im-hub.exe'],
    })).toEqual({
      commit: 'abc123', version: '0.1.0-internal.1', platform: 'win', arch: 'x64',
      serverOrigin: 'https://imhub.example.test', channel: 'internal-unsigned',
      artifacts: ['im-hub.exe'],
    })
  })
})
```

- [ ] **Step 3: Run the package test and verify the script/config are missing**

Run:

```bash
pnpm exec vitest run packages/desktop/scripts/package-internal.test.mjs
```

Expected: FAIL because the packaging script and metadata do not exist.

- [ ] **Step 4: Add stable electron-builder metadata**

Set `packages/desktop/package.json` version to `0.1.0-internal.1`, add:

```json
{
  "scripts": {
    "licenses:prod": "pnpm licenses list --prod --json",
    "package:internal:mac": "node ./scripts/package-internal.mjs mac",
    "package:internal:win": "node ./scripts/package-internal.mjs win"
  },
  "build": {
    "appId": "org.imhub.desktop",
    "productName": "im-hub",
    "asar": true,
    "directories": { "output": "release" },
    "files": ["out/**/*", "package.json"],
    "artifactName": "im-hub-${version}-${os}-${arch}-internal-unsigned.${ext}",
    "mac": { "target": ["dmg"], "category": "public.app-category.business" },
    "win": { "target": ["nsis"] },
    "nsis": {
      "oneClick": false,
      "perMachine": false,
      "allowToChangeInstallationDirectory": true,
      "deleteAppDataOnUninstall": false
    }
  }
}
```

Add `packages/desktop/release/` to `.gitignore`.

- [ ] **Step 5: Implement the no-shell packaging runner and manifest**

`package-internal.mjs` must:

1. accept only `mac` or `win`; reject `mac` unless `process.platform === 'darwin'`, and reject `win` unless `process.platform === 'win32'`;
2. require `IM_HUB_SERVER_URL` without logging it;
3. spawn `pnpm exec electron-vite build`, then `pnpm exec electron-builder` with `builderArguments(target)` using `spawnSync()` and `shell: false`;
4. use `unsignedBuildEnvironment()` to set `IM_HUB_INTERNAL_RELEASE=1` and
   `CSC_IDENTITY_AUTO_DISCOVERY=false`, and delete inherited `CSC_LINK`, `CSC_KEY_PASSWORD`,
   `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, `CSC_NAME`, `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` before spawning either child;
5. stop on either non-zero exit;
6. run `pnpm --filter @im-hub/desktop licenses:prod`, validate that its stdout parses as a license object rather than an error object, and write `release/im-hub-0.1.0-internal.1-internal-unsigned-third-party-licenses.json` for this release;
7. list only matching `internal-unsigned` artifact basenames from `release/`;
8. write the manifest using the exact package version plus the selected target and runtime architecture—for example, `release/im-hub-0.1.0-internal.1-win-x64-internal-unsigned.manifest.json`—with no token, profile, partition, environment dump, or platform identity.

Guard CLI execution with a `fileURLToPath(import.meta.url) === resolve(process.argv[1])` check so Vitest can import the pure helpers without starting a build.

- [ ] **Step 6: Run unit tests and a non-distributable macOS package smoke test**

Run:

```bash
pnpm exec vitest run packages/desktop/scripts/package-internal.test.mjs packages/desktop/src/internal-release-config.test.ts
IM_HUB_SERVER_URL=https://imhub.example.test pnpm --filter @im-hub/desktop package:internal:mac
```

Expected: PASS; `packages/desktop/release/` contains one `internal-unsigned.dmg`, one matching manifest for the current architecture, and one `internal-unsigned-third-party-licenses.json` production-dependency inventory. This reserved-origin package is smoke-test-only and must not be distributed.

- [ ] **Step 7: Audit and commit packaging**

Run:

```bash
git status --short
git check-ignore packages/desktop/release/
git diff --check
```

Expected: release outputs are ignored; no `.env`, package artifact, profile, session, npm lockfile, or yarn lockfile is listed.

Commit:

```bash
git add .gitignore packages/desktop/package.json packages/desktop/scripts/package-internal.mjs packages/desktop/scripts/package-internal.test.mjs pnpm-lock.yaml
git commit -m "build(desktop): package unsigned internal installers"
```

---

### Task 7: Build and retain the Windows installer in GitHub Actions

**Files:**
- Create: `.github/workflows/windows-internal-package.yml`
- Create: `packages/desktop/scripts/windows-workflow.test.mjs`

**Interfaces:**
- Consumes: package scripts from Task 6 and GitHub Environment `internal-test` variable `IM_HUB_SERVER_URL`.
- Produces: same-repository PR builds for first acceptance and `workflow_dispatch` builds after merge; artifact retention is exactly 7 days.

- [ ] **Step 1: Write the failing workflow contract test**

```js
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(
  new URL('../../../.github/workflows/windows-internal-package.yml', import.meta.url),
  'utf8',
)

describe('Windows internal package workflow', () => {
  it('supports first-PR and later manual builds without fork packaging', () => {
    expect(workflow).toContain('pull_request:')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('github.event.pull_request.head.repo.full_name == github.repository')
  })

  it('uses the protected environment and seven-day unsigned artifact', () => {
    expect(workflow).toContain('environment: internal-test')
    expect(workflow).toContain('vars.IM_HUB_SERVER_URL')
    expect(workflow).toContain('package:internal:win')
    expect(workflow).toContain('retention-days: 7')
    expect(workflow).toContain('internal-unsigned')
    expect(workflow).toContain('third-party-licenses')
  })
})
```

- [ ] **Step 2: Run the test and verify the workflow is absent**

Run:

```bash
pnpm exec vitest run packages/desktop/scripts/windows-workflow.test.mjs
```

Expected: FAIL with `ENOENT` for `.github/workflows/windows-internal-package.yml`.

- [ ] **Step 3: Create a least-privilege two-job workflow**

The workflow must use `permissions: { contents: read }` and contain:

```yaml
name: Windows internal package

on:
  pull_request:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: imhub
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
      redis:
        image: redis:7
        ports: ['6379:6379']
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    env:
      DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/imhub
      REDIS_URL: redis://127.0.0.1:6379
      JWT_SECRET: github-actions-isolated-test-secret-32-characters
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -c 'CREATE DATABASE imhub_test'
      - run: pnpm typecheck
      - run: pnpm test

  package-windows:
    needs: verify
    if: github.event_name == 'workflow_dispatch' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: windows-latest
    environment: internal-test
    env:
      IM_HUB_SERVER_URL: ${{ vars.IM_HUB_SERVER_URL }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - shell: pwsh
        run: if (-not $env:IM_HUB_SERVER_URL) { throw 'internal-test IM_HUB_SERVER_URL is missing' }
      - run: pnpm exec vitest run packages/desktop/src/renderer/whatsapp-product-policy.test.ts packages/desktop/src/renderer/components/AddAccountDialog.product.test.tsx packages/desktop/src/renderer/components/NativeClient.test.ts packages/desktop/src/renderer/components/TranslationDock.test.ts packages/desktop/src/internal-release-config.test.ts packages/desktop/src/preload/index.test.ts packages/desktop/src/preload/whatsapp-web-health.test.ts packages/desktop/src/preload/whatsapp-web-send-action.test.ts packages/desktop/src/preload/whatsapp-web-send.test.ts packages/desktop/scripts/package-internal.test.mjs packages/desktop/scripts/windows-workflow.test.mjs
      - run: pnpm --filter @im-hub/desktop package:internal:win
      - uses: actions/upload-artifact@v4
        with:
          name: im-hub-windows-internal-unsigned
          path: |
            packages/desktop/release/*internal-unsigned*.exe
            packages/desktop/release/*internal-unsigned*.manifest.json
            packages/desktop/release/*internal-unsigned-third-party-licenses.json
          retention-days: 7
          if-no-files-found: error
```

The Linux job owns DB-backed full regression. The Windows job repeats type-sensitive targeted behavior through the package script's electron-vite build and performs the actual NSIS build. Never use development or production database URLs in Actions.

- [ ] **Step 4: Run the workflow contract and targeted tests**

Run:

```bash
pnpm exec vitest run packages/desktop/scripts/windows-workflow.test.mjs packages/desktop/scripts/package-internal.test.mjs packages/desktop/src/internal-release-config.test.ts
pnpm typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit the Windows workflow**

```bash
git add .github/workflows/windows-internal-package.yml packages/desktop/scripts/windows-workflow.test.mjs
git commit -m "ci: build Windows internal installer"
```

---

### Task 8: Run cross-package regression and document the internal release procedure

**Files:**
- Modify: `docs/RUNBOOK.md`
- Modify: `docs/features/06-需求缺口.md`
- Modify: `docs/superpowers/specs/2026-08-26-m0-product-scope.md`
- Modify: `docs/superpowers/specs/2026-08-29-signal-whatsapp-parallel-checkpoint.md`
- Modify: `docs/superpowers/specs/2026-09-05-m6-whatsapp-web-internal-release-design.md`

**Interfaces:**
- Consumes: all Tasks 1–7 and their exact test/package commands.
- Produces: an evidence-backed automated checkpoint and an operator runbook that does not claim macOS/Windows manual acceptance early.

- [ ] **Step 1: Update current product wording**

Change active docs so they state:

- WhatsApp employee onboarding is Web-only; Cloud backend is retained and disabled;
- legacy Cloud accounts remain manageable but unavailable for conversations;
- Web visible text is not central archive and does not feed profiles/alerts;
- `org.imhub.desktop`, manual update, unsigned internal marker, fixed HTTPS origin, required license inventory, and 7-day Windows artifact are current packaging boundaries;
- Signal Windows remains M5 and is not part of this M6 acceptance;
- no manual platform result is recorded until the corresponding checklist actually runs.

Do not rewrite historical checkpoint statements as though Cloud code never existed.

- [ ] **Step 2: Add exact RUNBOOK build and rollback commands**

Document the non-distributable smoke command:

```bash
IM_HUB_SERVER_URL=https://imhub.example.test pnpm --filter @im-hub/desktop package:internal:mac
```

For a real internal package, instruct the operator to load the actual HTTPS origin from the approved local deployment environment without echoing it, then run the same package command. State that the GitHub `internal-test` Environment must contain a configuration variable named `IM_HUB_SERVER_URL`; do not put its value in the repository or docs.

Document rollback as installing the previous internal package without deleting user data, and require application/official linked-device cleanup before uninstalling or reassigning an account.

- [ ] **Step 3: Run the complete local verification suite with the isolated test database**

Run without printing environment values:

```bash
set -a && . "/Users/mac/Documents/Codex/CLOT fanyi/im-hub/.env" && set +a
pnpm typecheck
pnpm test
pnpm --filter @im-hub/desktop build
IM_HUB_SERVER_URL=https://imhub.example.test pnpm --filter @im-hub/desktop package:internal:mac
```

Expected: every command exits 0; full tests report zero failures; the DMG and manifest are ignored and marked `internal-unsigned`.

- [ ] **Step 4: Audit the complete diff and secret boundary**

Run:

```bash
git diff --check
git status --short
git diff --stat origin/main...HEAD
rg -n "whatsapp.*cloud|cloud_api|WHATSAPP_CLOUD" packages/desktop/src/renderer docs/RUNBOOK.md docs/features/06-需求缺口.md docs/superpowers/specs/2026-08-26-m0-product-scope.md
```

Expected: employee creation UI has no Cloud option; references that remain describe the disabled backend or legacy accounts. Status contains only intended source/tests/docs/workflow files and never `.env`, `release/`, `out/`, data, profile, session, token, QR, message, npm lock, or yarn lock files.

- [ ] **Step 5: Request a read-only code review and fix all valid findings**

Use `superpowers:requesting-code-review`. The reviewer must check:

- no Cloud backend/schema deletion;
- no legacy Cloud webview/ChatWorkspace mount;
- packaged builds cannot fall back to localhost or HTTP;
- main/preload use the same compiled origin;
- bridge error diagnostics are not exposed in full user text;
- retry reloads only the selected webview and cannot send;
- partition/userData/app ID remain stable;
- workflows cannot package fork PRs or expose credentials;
- tests and docs match the approved spec.

After fixes, rerun every affected test plus the full commands from Step 3.

- [ ] **Step 6: Commit the documentation checkpoint**

Record exact commit IDs, test file/test counts, build module counts, DMG basename, manifest basename, and “macOS/Windows manual acceptance pending”. Do not record the server origin or platform identifiers.

```bash
git add docs/RUNBOOK.md docs/features/06-需求缺口.md docs/superpowers/specs/2026-08-26-m0-product-scope.md docs/superpowers/specs/2026-08-29-signal-whatsapp-parallel-checkpoint.md docs/superpowers/specs/2026-09-05-m6-whatsapp-web-internal-release-design.md
git commit -m "docs: record WhatsApp Web internal build checkpoint"
```

---

### Task 9: Create the PR, obtain the Windows artifact, and record real acceptance

**Files:**
- Modify after evidence: `docs/superpowers/specs/2026-09-05-m6-whatsapp-web-internal-release-design.md`
- Modify after evidence: `docs/RUNBOOK.md`

**Interfaces:**
- Consumes: clean reviewed branch, GitHub Environment `internal-test`, Windows artifact, and the approved manual test limits.
- Produces: one PR with automated GitHub evidence and a final checkpoint containing only non-sensitive boolean/manual results.

- [ ] **Step 1: Confirm the GitHub Environment variable name exists without reading its value**

Run:

```bash
gh variable list --env internal-test --json name
```

Expected: output contains only the variable name `IM_HUB_SERVER_URL`. If the Environment or variable name is absent, stop and ask the user to configure the exact company HTTPS origin in GitHub; do not invent a URL and do not ask for tokens, credentials, or platform session data.

- [ ] **Step 2: Push the branch and create a PR against main**

Run only after the branch is clean and fresh verification passed:

```bash
git push --set-upstream origin codex/m6-whatsapp-web-internal
gh pr create --base main --head codex/m6-whatsapp-web-internal --title "feat: package WhatsApp Web for internal desktop use" --body "## Summary

- expose WhatsApp Web as the only employee onboarding route while retaining disabled Cloud backend code
- keep legacy Cloud accounts manageable but unavailable for conversations
- bind unsigned internal desktop packages to one validated company HTTPS origin
- add deterministic DMG/NSIS packaging and Windows artifact automation

## Verification

- pnpm typecheck
- pnpm test
- pnpm --filter @im-hub/desktop build
- unsigned macOS package smoke test

## Manual acceptance

- macOS read-only acceptance pending
- Windows install and one user-confirmed non-sensitive text send pending"
```

Expected: GitHub returns one new PR URL. Do not merge it yet.

- [ ] **Step 3: Wait for PR checks and verify the Windows artifact metadata**

Run:

```bash
gh pr checks --watch
```

Expected: Linux `verify` and Windows `package-windows` pass for the PR head. Confirm the artifact contains the NSIS `.exe`, matching `internal-unsigned` manifest, and production-dependency license inventory; do not extract or inspect WhatsApp/session user data because none belongs in the artifact.

- [ ] **Step 4: Perform macOS read-only acceptance with the real internal origin**

Generate the DMG from the exact PR head using the approved local deployment environment. Launching/installing is an external GUI action and requires user approval. Follow spec section 10.1 exactly: verify install, login, Web-only add UI, existing WhatsApp login, visible/scroll translations, one draft write then manual clear, restart persistence, and fail-closed server/grant behavior. Send zero messages.

Record only pass/fail booleans, build version, commit, and short non-sensitive error categories.

- [ ] **Step 5: Hand the Windows artifact to the user for one controlled acceptance**

The user performs spec section 10.2 on a real Windows machine. Before the only send, they must confirm the intended non-sensitive recipient and single draft in the WhatsApp UI. They click send exactly once; the automation never clicks on their behalf. Record only:

- install opened: yes/no;
- im-hub login: yes/no;
- WhatsApp QR/login: yes/no;
- visible and scrolled bilingual bubbles: yes/no;
- single draft write: yes/no;
- exactly one received message and no retry: yes/no;
- restart preserved login and did not resend: yes/no;
- server/grant failure stayed fail-closed: yes/no;
- non-sensitive error category, if any.

- [ ] **Step 6: Append the real acceptance checkpoint only after evidence exists**

If either platform has a failure, record it as open and fix it using `superpowers:systematic-debugging`; do not mark the slice complete. If both pass, append exact results to the M6 design and RUNBOOK without account names, recipients, bodies, DOM IDs, QR data, partition paths, tokens, or server origin.

Run:

```bash
git diff --check
git status --short
```

Commit:

```bash
git add docs/RUNBOOK.md docs/superpowers/specs/2026-09-05-m6-whatsapp-web-internal-release-design.md
git commit -m "docs: record WhatsApp Web internal acceptance"
git push
```

- [ ] **Step 7: Final review and integration handoff**

Use `superpowers:verification-before-completion` and `superpowers:requesting-code-review` on the final PR head. After all checks/review findings are closed, use `superpowers:finishing-a-development-branch` and offer the user the supported integration choices. Do not merge the PR without the user's explicit selection.
