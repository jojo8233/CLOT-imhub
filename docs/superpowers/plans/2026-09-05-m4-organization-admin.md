# M4-4 公司内部组织与管理中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付仅唯一 owner 可维护的公司内部员工、团队和平台账号管理闭环，并实现首次改密、即时撤权、账号安全转移及本机清理状态。

**Architecture:** 在现有共享协议、Fastify/Kysely 服务端和 Electron/React 桌面端内增加独立组织管理边界。服务端事务维护唯一 owner、唯一主管、agent 单团队和账号强一致性；桌面端只通过 typed API 和受控 Electron IPC 管理组织与本机分区，Signal 固定走人工解除旧设备。

**Tech Stack:** Node.js 22+、pnpm 10、TypeScript ESM strict、Fastify 5、Zod、Kysely/PostgreSQL、JOSE、Argon2、Electron 33、React 19、Vitest。

**Spec:** `docs/superpowers/specs/2026-09-05-m4-organization-admin-design.md`

## Global Constraints

- 功能只供公司内部使用，依赖公司内部中心服务端和 PostgreSQL，不对公网用户开放。
- 组织数据只有唯一启用 owner 可维护；manager、auditor、agent 均不能调用管理写接口。
- 员工只停用、不物理删除；不得重新引入审计日志或持久化操作历史。
- 临时密码有效 24 小时；首次改密凭证有效 10 分钟；正式密码长度 12–128 字符且不做 trim。
- 系统始终恰好一个启用 owner；每个启用团队恰好一个 manager；agent 允许零或一个团队。
- 账号负责人和团队保持强一致；唯一 owner 可持有任意启用团队或未分组账号。
- Signal 转移只撤销 im-hub 权限、隐藏视图并进入 `manual_required`，不自动删除共享 profile。
- Telegram 补丁客户端和 WhatsApp Web 的 `persist:native-<accountId>` 分区可自动清理；不能复制平台 session。
- 不修改客户档案字段、关键词匹配、消息去重键、翻译、发送 attempt 或三平台 guest 协议。
- 不读取、打印或提交 `.env`、平台 session/profile、token、二维码、验证码、2FA 密码或真实消息正文。
- 数据库测试只连接由 `testDatabaseUrl()` 派生并确认存在的固定 `_test` 库；禁止指向开发库或生产库。
- 保持源码相对导入 `.js` 后缀、`import type`、单引号、无分号和 2 空格缩进；禁止 `any`、`@ts-ignore` 和非空断言逃避类型设计。
- 继续只使用 `/private/tmp/im-hub-m3-outbox`；不得修改主 checkout。

---

## File/Module Map

- `packages/shared/src/organization-admin.ts`：跨端管理读模型、命令、登录联合响应、错误码和设备状态。
- `packages/server/src/db/migrations/0016_organization_admin.ts`：用户/团队/账号版本字段与设备清理表。
- `packages/server/src/db/organization-preflight.ts`：纯查询 preflight 与可测试报告模型。
- `packages/server/src/auth/initial-password.ts`：首次改密凭证的独立 JWT 类型。
- `packages/server/src/organization-admin/`：查询、设备、员工、团队、账号、owner 转让和 operation token 服务。
- `packages/server/src/api/routes/admin-*.ts`：owner-only HTTP 边界；路由不直接 import `db`。
- `packages/server/src/api/routes/desktop-installations.ts`：带员工会话和设备凭证的登记/清理任务 API。
- `packages/desktop/src/main/desktop-installation-*.ts`：设备凭证、安全存储、登记、自动分区清理与确认。
- `packages/desktop/src/renderer/organization-admin/`：请求代次、冲突和结果未知状态机。
- `packages/desktop/src/renderer/components/OrganizationAdmin*.tsx`：员工、团队、账号和高风险确认 UI。

---

### Task 1: Shared organization, auth, device and WebSocket contracts

**Files:**
- Create: `packages/shared/src/organization-admin.ts`
- Create: `packages/shared/src/organization-admin.test.ts`
- Modify: `packages/shared/src/ws.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `AuthenticatedUser`, `LoginResponse`, `AccountCreationContext`, `AdminUser`, `AdminTeam`, `AdminAccount`, `AdminMutationPreview`, `AdminErrorCode`, `DesktopInstallationCapability`, `DesktopCleanupTask`, `DesktopInstallationSyncResult`, `WsSessionRevokedEvent`, `WsOrganizationChangedEvent`, `WsDesktopCleanupRequestedEvent`.
- Consumes: existing `Role`, `Platform`, `AccountConnectionMode`, `AccountStatus`, `WsServerEvent`.

- [ ] **Step 1: Write failing shared contract tests**

```ts
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  ADMIN_EDITABLE_ROLES,
  type AdminAccount,
  type LoginResponse,
  type WsServerEvent,
} from './index.js'

describe('organization admin contracts', () => {
  it('普通创建角色不包含 owner', () => {
    expect(ADMIN_EDITABLE_ROLES).toEqual(['auditor', 'manager', 'agent'])
  })

  it('首次改密响应不含普通 session token 字段', () => {
    const response: LoginResponse = {
      kind: 'password_change_required',
      setupToken: 'synthetic-setup-token',
      user: { id: 'u1', role: 'agent', displayName: 'A' },
    }
    expect('token' in response).toBe(false)
  })

  it('账号清理状态包含 Signal 人工处理', () => {
    expectTypeOf<AdminAccount['cleanupState']>()
      .toEqualTypeOf<'not_required' | 'pending' | 'completed' | 'manual_required'>()
  })

  it('撤权事件属于服务端事件联合类型', () => {
    const event: WsServerEvent = { type: 'session_revoked' }
    expect(event.type).toBe('session_revoked')
  })
})
```

- [ ] **Step 2: Run the shared test and confirm RED**

Run: `pnpm exec vitest run packages/shared/src/organization-admin.test.ts`

Expected: FAIL because `organization-admin.js` and the new exported symbols do not exist.

- [ ] **Step 3: Add exact shared models and constants**

```ts
export const ADMIN_EDITABLE_ROLES = ['auditor', 'manager', 'agent'] as const
export type AdminEditableRole = typeof ADMIN_EDITABLE_ROLES[number]
export const DESKTOP_INSTALLATION_CAPABILITIES = ['partition_cleanup_v1'] as const
export type DesktopInstallationCapability = typeof DESKTOP_INSTALLATION_CAPABILITIES[number]
export type AdminCleanupState = 'not_required' | 'pending' | 'completed' | 'manual_required'
export type DesktopCleanupReason =
  | 'ownership_changed'
  | 'unsupported_client_override'
  | 'signal_official_unlink'

export interface AuthenticatedUser {
  id: string
  role: Role
  displayName: string
}

export type LoginResponse =
  | { kind: 'authenticated'; token: string; user: AuthenticatedUser }
  | { kind: 'password_change_required'; setupToken: string; user: AuthenticatedUser }

export interface AccountCreationContext {
  selectableTeams: Array<{ id: string; name: string }>
  requiresTeamSelection: boolean
  allowsUngrouped: boolean
}

export interface AdminUser {
  id: string
  email: string
  displayName: string
  role: Role
  disabledAt: string | null
  teamIds: string[]
  ownedAccountCount: number
  revision: number
}

export interface AdminTeam {
  id: string
  name: string
  managerUserId: string | null
  agentCount: number
  accountCount: number
  disabledAt: string | null
  revision: number
}

export interface AdminAccount {
  id: string
  platform: Platform
  connectionMode: AccountConnectionMode
  displayName: string
  status: AccountStatus
  ownerUserId: string
  teamId: string | null
  cleanupState: AdminCleanupState
  pendingCleanupCount: number
  revision: number
}

export interface AdminPage<T> {
  items: T[]
  nextCursor: string | null
}

export interface AdminMutationPreview {
  operationToken: string
  expiresAt: string
  summary: Record<string, number>
}

export interface DesktopCleanupTask {
  id: string
  installationId: string | null
  accountId: string
  mode: 'automatic' | 'manual_required'
  reason: DesktopCleanupReason
  state: 'pending' | 'completed'
  createdAt: string
  completedAt: string | null
}

export interface DesktopInstallationSyncResult {
  readyAccountIds: string[]
  blockedAccountIds: string[]
  manualRequiredAccountIds: string[]
}

export type AdminErrorCode =
  | 'ADMIN_WRITES_DISABLED'
  | 'REVISION_CONFLICT'
  | 'ORGANIZATION_INVARIANT'
  | 'CLIENT_UPDATE_REQUIRED'
  | 'DEVICE_CREDENTIAL_INVALID'
  | 'DEVICE_CLEANUP_PENDING'
  | 'OPERATION_PREVIEW_EXPIRED'
```

Also define request types named `AdminUserSearchRequest`, `AdminUserCreate`, `AdminUserUpdate`, `AdminTeamSearchRequest`, `AdminTeamCreate`, `AdminAgentTeamChange`, `AdminAccountSearchRequest`, `AdminAccountAssignmentPreviewRequest`, `AdminAccountAssignmentRequest`, `AdminOwnerTransferPreviewRequest`, and `AdminOwnerTransferRequest`. Every type that mutates an existing resource contains `baseRevision`; create types do not invent one. Execute request types contain `operationToken`. Limits are `1..100`, default `50`.

- [ ] **Step 4: Add non-sensitive wake-up events to `WsServerEvent`**

```ts
export interface WsSessionRevokedEvent { type: 'session_revoked' }
export interface WsOrganizationChangedEvent { type: 'organization_changed' }
export interface WsDesktopCleanupRequestedEvent { type: 'desktop_cleanup_requested' }
```

Export the new module from `index.ts` and append the three events to the exhaustive union in `ws.ts`.

- [ ] **Step 5: Run shared tests and typecheck**

Run: `pnpm exec vitest run packages/shared/src/organization-admin.test.ts packages/shared/src/keyword-alert.test.ts`

Expected: PASS.

Run: `pnpm --filter @im-hub/shared exec tsc --noEmit`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/organization-admin.ts packages/shared/src/organization-admin.test.ts packages/shared/src/ws.ts packages/shared/src/index.ts
git commit -m "feat(shared): define organization admin contracts"
```

---

### Task 2: Additive migration, database types and organization preflight

**Files:**
- Create: `packages/server/src/db/migrations/0016_organization_admin.ts`
- Create: `packages/server/src/db/migrations/0016_organization_admin.test.ts`
- Create: `packages/server/src/db/organization-preflight.ts`
- Create: `packages/server/src/db/organization-preflight.test.ts`
- Modify: `packages/server/src/db/types.ts`
- Modify: `packages/server/src/db/migration-provider.test.ts`
- Modify: `packages/server/src/db/preflight.ts`
- Modify: `packages/server/src/db/seed.ts`
- Modify: `packages/server/src/keyword-alert/rule-repo.test.ts`

**Interfaces:**
- Produces: typed `session_version`, `must_change_password`, `temporary_password_expires_at`, `revision`, team archival, account revision, `desktop_installations`, `account_device_mounts`, `desktop_cleanup_tasks`.
- Produces: `organizationPreflight(db): Promise<OrganizationPreflightReport>`.
- Consumes: current `Database`, Kysely migration provider and seed identities.

- [ ] **Step 1: Write failing migration tests**

Create an isolated schema using the pattern from `0015_keyword_alerts.test.ts`; build the original `users`, `teams`, `team_members`, and `accounts`, insert one valid owner/manager/team, then call `up`.

```ts
expect(await columnNames(isolated, 'users')).toEqual(expect.arrayContaining([
  'session_version', 'must_change_password', 'temporary_password_expires_at',
  'revision', 'updated_at',
]))
expect(await tableNames(isolated)).toEqual(expect.arrayContaining([
  'desktop_installations', 'account_device_mounts', 'desktop_cleanup_tasks',
]))
```

Add cases proving a second enabled owner and a second lead for one team fail with named constraints.

- [ ] **Step 2: Run migration tests and confirm RED**

Load the environment without printing it, then run:

```bash
set -a
. ./.env
set +a
pnpm exec vitest run packages/server/src/db/migrations/0016_organization_admin.test.ts
```

Expected: FAIL because migration `0016_organization_admin` does not exist.

- [ ] **Step 3: Implement migration `up` and `down`**

Add these exact columns:

```ts
// users
session_version integer not null default 1
must_change_password boolean not null default false
temporary_password_expires_at timestamptz null
revision integer not null default 1
updated_at timestamptz not null default now()

// teams
disabled_at timestamptz null
revision integer not null default 1
updated_at timestamptz not null default now()

// accounts
revision integer not null default 1
```

Create named partial unique indexes `users_single_enabled_owner_uq` on the constant expression for rows where `role='owner' and disabled_at is null`, and `team_members_single_lead_uq` on `team_id where is_lead=true`.

Create exact operational tables:

```ts
export interface DesktopInstallationsTable {
  id: string
  credential_sha256: string
  client_version: string
  capabilities: JSONColumnType<string[]>
  last_seen_at: RequiredTimestamp
  revoked_at: Timestamp | null
  created_at: Generated<Timestamp>
}

export interface AccountDeviceMountsTable {
  installation_id: string
  account_id: string
  owner_user_id: string
  last_seen_at: RequiredTimestamp
}

export interface DesktopCleanupTasksTable {
  id: Generated<string>
  installation_id: string | null
  account_id: string
  mode: 'automatic' | 'manual_required'
  reason: 'ownership_changed' | 'unsupported_client_override' | 'signal_official_unlink'
  state: 'pending' | 'completed'
  created_at: Generated<Timestamp>
  completed_at: Timestamp | null
}
```

Use composite primary key `(installation_id, account_id)` for mounts; index pending tasks by `(installation_id, state, created_at)` and account tasks by `(account_id, state)`. Use cascading foreign keys from mounts/tasks to account. Mounts always reference an installation; cleanup tasks reference an installation when an automatic cleanup target or known manual device exists, while account-level manual obligations may leave `installation_id` null. User ownership references remain restrictive. `down` drops task tables/indexes before removing columns and is documented as development-only.

- [ ] **Step 4: Write failing preflight tests**

```ts
expect((await organizationPreflight(validDb)).ok).toBe(true)
expect((await organizationPreflight(dbWithNoOwner)).issues).toContainEqual({
  code: 'enabled_owner_count', count: 0,
})
expect((await organizationPreflight(dbWithLeadlessTeam)).issues).toContainEqual({
  code: 'team_lead_count', count: 1,
})
expect((await organizationPreflight(dbWithMultiTeamAgent)).issues).toContainEqual({
  code: 'multi_team_agent', count: 1,
})
```

The report contains only issue code and count, never ids, emails, names or platform identity.

- [ ] **Step 5: Implement and wire the read-only preflight**

`organizationPreflight` runs aggregate queries for exactly one enabled owner, exactly one lead per non-archived team, no agent with more than one membership, no role-invalid memberships, and no invalid account owner/team relation. `db/preflight.ts` prints safe counts and exits non-zero when `ok=false`.

Update `migration-provider.test.ts` to expect migration 0016 in order. Update the one keyword rule repository test that creates two simultaneous owner rows so its second repository actor uses role `agent`; the repository actor id test remains valid without violating the new database invariant.

- [ ] **Step 6: Run migration, preflight and seed-focused tests**

```bash
set -a
. ./.env
set +a
pnpm exec vitest run packages/server/src/db/migrations/0016_organization_admin.test.ts packages/server/src/db/organization-preflight.test.ts packages/server/src/db/migration-provider.test.ts packages/server/src/keyword-alert/rule-repo.test.ts
```

Expected: PASS, and every test connection ends in `_test`.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/db packages/server/src/keyword-alert/rule-repo.test.ts
git commit -m "feat(db): add organization admin foundation"
```

---

### Task 3: Versioned sessions, forced first password change and immediate revocation

**Files:**
- Create: `packages/server/src/auth/initial-password.ts`
- Create: `packages/server/src/auth/initial-password.test.ts`
- Create: `packages/server/src/api/routes/auth.test.ts`
- Modify: `packages/server/src/auth/session.ts`
- Modify: `packages/server/src/auth/session.test.ts`
- Modify: `packages/server/src/api/actor.ts`
- Modify: `packages/server/src/api/actor.test.ts`
- Modify: `packages/server/src/api/routes/auth.ts`
- Modify: `packages/server/src/api/server.ts`
- Modify: `packages/server/src/api/server.test.ts`
- Modify: `packages/server/src/api/ws.ts`
- Modify: `packages/server/src/api/ws.test.ts`
- Modify: `packages/server/src/api/routes/accounts.test.ts`
- Modify: `packages/server/src/api/routes/conversations.test.ts`
- Modify: `packages/server/src/api/routes/customer-profile.test.ts`
- Modify: `packages/server/src/api/routes/customer-profiles.test.ts`
- Modify: `packages/server/src/api/routes/keyword-alerts.test.ts`
- Modify: `packages/server/src/api/routes/keyword-rules.test.ts`
- Modify: `packages/server/src/api/routes/messages.test.ts`
- Modify: `packages/server/src/api/routes/native.test.ts`
- Modify: `packages/server/src/api/routes/shadow-refresh.test.ts`
- Modify: `packages/server/src/api/routes/whatsapp-cloud.test.ts`

**Interfaces:**
- Produces: `SessionClaims { userId: string; sessionVersion: number }`.
- Produces: `signInitialPasswordSetup`, `verifyInitialPasswordSetup` with JWT typ `im-hub-initial-password+jwt` and 10-minute expiry.
- Produces: `WsHub.revokeUser(userId): void` and version-aware HTTP/WS authentication.
- Consumes: `LoginResponse`, `WsSessionRevokedEvent`, migrated user fields.

- [ ] **Step 1: Change session tests first**

```ts
const token = await signSession({ userId: 'u1', sessionVersion: 4 }, secret)
expect(await verifySession(token, secret)).toEqual({ userId: 'u1', sessionVersion: 4 })

const legacy = await new SignJWT({ userId: 'u1' })
  .setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('12h')
  .sign(new TextEncoder().encode(secret))
await expect(verifySession(legacy, secret)).rejects.toThrow()
```

Add cross-type tests proving setup tokens cannot pass `verifySession` and normal session tokens cannot pass `verifyInitialPasswordSetup`.

- [ ] **Step 2: Run auth unit tests and confirm RED**

Run: `pnpm exec vitest run packages/server/src/auth/session.test.ts packages/server/src/auth/initial-password.test.ts packages/server/src/api/actor.test.ts`

Expected: FAIL because `sessionVersion` and the setup-token module are absent.

- [ ] **Step 3: Implement token types and actor comparison**

```ts
export interface SessionClaims {
  userId: string
  sessionVersion: number
}

export async function loadActor(
  userId: string,
  expectedSessionVersion: number,
  repo: ActorRepo,
): Promise<Actor> {
  const user = await repo.findUser(userId)
  if (!user || user.disabled_at || user.session_version !== expectedSessionVersion) {
    throw new Error('invalid session actor')
  }
  const memberships = user.role === 'manager' ? await repo.findMemberships(userId) : []
  return {
    userId: user.id,
    role: user.role,
    leadTeamIds: memberships.filter(item => item.is_lead).map(item => item.team_id),
  }
}
```

`defaultActorRepo.findMemberships` joins `teams` and filters `teams.disabled_at is null`. Remove legacy JWT acceptance deliberately so deployment forces one new login.

- [ ] **Step 4: Write failing route tests for both login branches**

Cover normal login, valid temporary login, expired temporary password, initial completion, setup-token version mismatch, 11/12/128/129-character passwords, self-change with wrong current password, and self-change returning a replacement session.

```ts
expect(normal.json()).toMatchObject({ kind: 'authenticated' })
expect(temporary.json()).toMatchObject({
  kind: 'password_change_required',
  user: { role: 'agent' },
})
expect(temporary.json()).not.toHaveProperty('token')
```

- [ ] **Step 5: Implement auth routes without logging sensitive bodies**

`POST /api/auth/login` returns the discriminated `LoginResponse`. For `must_change_password=true`, verify expiry and return only a setup token. `POST /api/auth/initial-password/complete` validates a 12–128 character untrimmed password, locks the user row, compares setup version, hashes the password, clears temporary fields, increments `session_version` and returns an authenticated response. `POST /api/session/password` verifies current password, applies the same password policy, increments version and returns a replacement authenticated response.

Use generic invalid-credential timing behavior for unknown/disabled users. Do not place candidate passwords in errors or logger properties.

- [ ] **Step 6: Implement WS revocation and version-aware handshake**

```ts
revokeUser(userId: string): void {
  const payload = JSON.stringify({ type: 'session_revoked' } satisfies WsSessionRevokedEvent)
  for (const socket of this.sockets.get(userId) ?? []) {
    if (socket.readyState === socket.OPEN) socket.send(payload)
    socket.close(4001, 'session revoked')
  }
}
```

The `/ws` auth frame verifies JWT, then calls `loadActor(claims.userId, claims.sessionVersion, actorRepo)` before `hub.add`. Add tests for stale version rejection and revoke send-before-close ordering.

- [ ] **Step 7: Update all session fixtures and run focused tests**

Every `signSession` test call supplies `sessionVersion: 1`; every `ActorRepo.findUser` fixture supplies `session_version: 1`. Do not add a default that would let production accept missing versions.

```bash
set -a
. ./.env
set +a
pnpm exec vitest run packages/server/src/auth packages/server/src/api/actor.test.ts packages/server/src/api/routes/auth.test.ts packages/server/src/api/server.test.ts packages/server/src/api/ws.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/auth packages/server/src/api packages/server/src/db/types.ts
git commit -m "feat(auth): enforce versioned sessions and first login reset"
```

---

### Task 4: Desktop installation registration and cleanup task server

**Files:**
- Create: `packages/server/src/organization-admin/device-repo.ts`
- Create: `packages/server/src/organization-admin/device-repo.test.ts`
- Create: `packages/server/src/organization-admin/device-service.ts`
- Create: `packages/server/src/organization-admin/device-service.test.ts`
- Create: `packages/server/src/api/routes/desktop-installations.ts`
- Create: `packages/server/src/api/routes/desktop-installations.test.ts`
- Modify: `packages/server/src/api/server.ts`

**Interfaces:**
- Produces: `DeviceService.register`, `heartbeat`, `syncMounts`, `claimAutomaticTasks`, `completeAutomaticTask`, `confirmManualTask`, `enqueueOwnershipChange`.
- Produces: capability name `partition_cleanup_v1`; Signal tasks always use `manual_required`.
- Consumes: installation/mount/task tables and current authenticated actor.

- [ ] **Step 1: Write repository and service tests**

```ts
expect(await service.register(actor, {
  installationId,
  credential: 'synthetic-device-credential',
  clientVersion: '0.0.0-test',
  capabilities: ['partition_cleanup_v1'],
})).toEqual({ registered: true })

expect(await service.register(otherActor, {
  ...sameDevicePayload,
  credential: 'synthetic-device-credential',
})).toEqual({ registered: true })

await expect(service.register(otherActor, {
  ...sameDevicePayload,
  credential: 'wrong-device-credential',
})).rejects.toMatchObject({ code: 'DEVICE_CREDENTIAL_INVALID' })
```

Add tests that `syncMounts` accepts actor-owned mounts, rejects unowned mounts and rejects an installation/account pair while either an automatic or manual cleanup task is pending. Verify credential hashes are stored instead of plaintext, completed automatic tasks cannot be claimed again, completing/confirming a task removes its old mount, completed tasks older than 30 days are deleted, and Signal produces `manual_required` without entering claims.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
set -a
. ./.env
set +a
pnpm exec vitest run packages/server/src/organization-admin/device-repo.test.ts packages/server/src/organization-admin/device-service.test.ts
```

Expected: FAIL because the device modules do not exist.

- [ ] **Step 3: Implement credential verification and task state transitions**

Hash device credentials with SHA-256 before storage and compare fixed-length buffers with `timingSafeEqual`. Registration accepts a new installation id once; subsequent calls from any valid company user require the same credential. Registration never mutates mounts. `syncMounts` validates every account is currently owned by the actor and has no pending cleanup task for this installation before upserting `(installation_id, account_id)`; otherwise it returns `DEVICE_CLEANUP_PENDING`. Completing or manually confirming a task removes the corresponding old mount in the same transaction.

```ts
export interface OwnershipChange {
  accountId: string
  previousOwnerUserId: string
  connectionMode: AccountConnectionMode
}

export interface CleanupEnqueueResult {
  pendingAutomatic: number
  manualRequired: number
  unsupportedOnlineInstallations: number
}
```

For `native_desktop`, enqueue manual tasks only; use the known installation id when a mount exists and otherwise create one account-level manual obligation with `installation_id = null`. For `web_shell` and patched local webviews, enqueue automatic tasks for every known installation mount. Adapter and Cloud API require no cleanup task.

- [ ] **Step 4: Add authenticated device routes**

Use `X-Im-Hub-Installation-Id` and `X-Im-Hub-Device-Credential` headers with strict length limits. Routes still require the normal Bearer user session. Add `req.headers.x-im-hub-device-credential` to Fastify logger redaction and assert the synthetic credential sentinel is absent from route errors and captured logs.

Implement:

```text
POST /api/desktop/installations/register
POST /api/desktop/installations/heartbeat
POST /api/desktop/installations/sync-mounts
POST /api/desktop/cleanup-tasks/claim
POST /api/desktop/cleanup-tasks/:id/complete
```

All five routes bind the installation to a valid company session and credential. The owner-only manual confirmation
route is added with the account admin boundary in Task 7, after `admin-guard.ts` exists.

- [ ] **Step 5: Run API tests**

```bash
set -a
. ./.env
set +a
pnpm exec vitest run packages/server/src/api/routes/desktop-installations.test.ts packages/server/src/organization-admin/device-repo.test.ts packages/server/src/organization-admin/device-service.test.ts
```

Expected: PASS, with assertions that response/log snapshots contain no synthetic credential sentinel.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/organization-admin packages/server/src/api/routes/desktop-installations.ts packages/server/src/api/routes/desktop-installations.test.ts packages/server/src/api/server.ts
git commit -m "feat(server): track desktop cleanup obligations"
```

---

### Task 5: Owner-only employee queries, creation, reset and re-enable

**Files:**
- Create: `packages/server/src/organization-admin/admin-guard.ts`
- Create: `packages/server/src/organization-admin/operation-token.ts`
- Create: `packages/server/src/organization-admin/operation-token.test.ts`
- Create: `packages/server/src/organization-admin/read-repo.ts`
- Create: `packages/server/src/organization-admin/read-repo.test.ts`
- Create: `packages/server/src/organization-admin/user-service.ts`
- Create: `packages/server/src/organization-admin/user-service.test.ts`
- Create: `packages/server/src/api/routes/admin-users.ts`
- Create: `packages/server/src/api/routes/admin-users.test.ts`
- Modify: `packages/server/src/config.ts`
- Modify: `packages/server/src/api/server.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `OrganizationReadRepo.searchUsers`, `UserAdminService.create`, `update`, `resetPassword`, `enable`.
- Produces: 5-minute `AdminOperationTokenService` used by later high-risk previews.
- Consumes: shared employee contracts, password hashing, current owner actor, user revisions.

- [ ] **Step 1: Write guard, token and user service tests**

Cover owner success; manager/auditor/agent `403`; write flag off; stable cursor pagination; duplicate email; temp password expiry; plaintext absence from DB/log; stale revision; owner role rejected in normal create/update; and role update blockers when memberships/accounts exist.

```ts
expect(await service.create(ownerActor, {
  email: 'new.agent@example.test',
  displayName: 'New Agent',
  role: 'agent',
  teamId: null,
}, now)).toMatchObject({
  user: { role: 'agent', revision: 1 },
  temporaryPasswordExpiresAt: '2026-09-06T00:00:00.000Z',
})
expect(stored.password_hash).not.toContain(result.temporaryPassword)
```

- [ ] **Step 2: Run tests and confirm RED**

```bash
set -a
. ./.env
set +a
pnpm exec vitest run packages/server/src/organization-admin/operation-token.test.ts packages/server/src/organization-admin/read-repo.test.ts packages/server/src/organization-admin/user-service.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement focused services**

`read-repo.ts` owns stable owner-only JSON-body search and opaque cursors. `user-service.ts` generates 24 random bytes with `randomBytes(24).toString('base64url')`, hashes immediately, sets `must_change_password=true`, sets expiry to `now + 24h`, and increments `session_version` for reset/enable. `update` only performs display-name changes or role changes with no blockers; it never mutates owner.

```ts
export type UserMutationResult =
  | { kind: 'updated'; user: AdminUser; revokeSession: boolean }
  | { kind: 'not_found' }
  | { kind: 'conflict'; current: AdminUser }
  | { kind: 'blocked'; blockers: OrganizationBlocker[] }
```

`operation-token.ts` uses JOSE typ `im-hub-admin-operation+jwt`, binds operation kind, owner user id, normalized input digest and all revisions, and expires after 5 minutes. It stores no operation journal.

- [ ] **Step 4: Add config and routes**

Add `ORGANIZATION_ADMIN_WRITES_ENABLED` as `'true' | 'false'`, default `false`, to config and `.env.example`. Search remains available to owner while writes are off. Each write checks the flag and returns `503` with code `ADMIN_WRITES_DISABLED` before reading a target.

Implement the user endpoints from spec section 9.1 except disable and owner transfer, which belong to Tasks 7 and 8. Route error mapping is exhaustive over `UserMutationResult`; route files receive services through `buildServer` dependencies and do not import `db`.

- [ ] **Step 5: Run user API tests and typecheck**

```bash
set -a
. ./.env
set +a
pnpm exec vitest run packages/server/src/api/routes/admin-users.test.ts packages/server/src/organization-admin/user-service.test.ts packages/server/src/organization-admin/read-repo.test.ts
pnpm --filter @im-hub/server exec tsc --noEmit
```

Expected: PASS and exit 0.

- [ ] **Step 6: Commit**

```bash
git add .env.example packages/server/src/config.ts packages/server/src/organization-admin packages/server/src/api/routes/admin-users.ts packages/server/src/api/routes/admin-users.test.ts packages/server/src/api/server.ts
git commit -m "feat(server): add owner employee administration"
```

---

### Task 6: Team lifecycle and consistent account creation context

**Files:**
- Create: `packages/server/src/organization-admin/team-service.ts`
- Create: `packages/server/src/organization-admin/team-service.test.ts`
- Create: `packages/server/src/api/routes/admin-teams.ts`
- Create: `packages/server/src/api/routes/admin-teams.test.ts`
- Modify: `packages/server/src/organization-admin/read-repo.ts`
- Modify: `packages/server/src/api/routes/accounts.ts`
- Modify: `packages/server/src/api/routes/accounts.test.ts`
- Modify: `packages/server/src/api/server.ts`

**Interfaces:**
- Produces: `TeamAdminService.create`, `changeManager`, `changeAgentTeam`, `previewArchive`, `archive`, `restore`.
- Produces: `GET /api/account-creation-context` and role-aware `POST /api/accounts { teamId? }`.
- Consumes: device cleanup writer, operation token, team/account revisions.

- [ ] **Step 1: Write failing team invariant tests**

Cover one manager per enabled team, manager leading multiple teams, owner/auditor membership rejection, agent second-team rejection, agent move carrying all owned accounts, move to ungrouped, manager replacement transferring that manager's team accounts to owner, archive behavior, restore requiring a manager, stale revision and transaction rollback.

```ts
const moved = await service.changeAgentTeam(ownerActor, {
  agentUserId,
  teamId: nextTeamId,
  baseRevision: agentRevision,
})
expect(moved.kind).toBe('changed')
expect(await accountTeams(agentUserId)).toEqual([nextTeamId, nextTeamId])
```

- [ ] **Step 2: Run team tests and confirm RED**

```bash
set -a
. ./.env
set +a
pnpm exec vitest run packages/server/src/organization-admin/team-service.test.ts packages/server/src/api/routes/admin-teams.test.ts
```

Expected: FAIL because team service/routes do not exist.

- [ ] **Step 3: Implement transactions in deterministic lock order**

For every command, lock user ids sorted ascending, then team ids sorted ascending, then account ids sorted ascending. Increment affected row revisions with `revision + 1`. `changeManager` transfers old-manager-owned accounts in that team to the unique owner and calls `DeviceService.enqueueOwnershipChange` before commit. `archive` performs the same transfer, removes memberships, nulls all remaining account team ids, then sets `disabled_at`.

```ts
export type TeamMutationResult =
  | { kind: 'changed'; team: AdminTeam; affectedUserIds: string[] }
  | { kind: 'preview'; preview: AdminMutationPreview }
  | { kind: 'not_found' }
  | { kind: 'conflict'; current: AdminTeam }
  | { kind: 'blocked'; blockers: OrganizationBlocker[] }
```

- [ ] **Step 4: Implement owner-only team routes and tests**

Map `POST /api/admin/teams/search`, create, patch, change-manager, archive preview/execute, restore, and agent change-team exactly as the spec. `change-manager` and `archive` each use their single documented endpoint with a discriminated request body: `{ phase: 'preview', baseRevision, input }` returns the impact preview and `{ phase: 'execute', operationToken }` executes it. Execute requires the preview operation token and revalidates bound revisions in the transaction.

- [ ] **Step 5: Fix ordinary account creation to respect the same invariant**

Add `/api/account-creation-context` returning only teams valid for the current actor. `POST /api/accounts` behavior becomes:

```text
agent   -> ignore team choice and use its zero/one membership
manager -> require teamId and verify it is in current leadTeamIds
owner   -> accept null or any enabled teamId
auditor -> 403
```

Remove the current `orderBy('is_lead').executeTakeFirst()` ambiguity. Keep `owner_user_id` forced from the authenticated actor.

- [ ] **Step 6: Run team and account route tests**

```bash
set -a
. ./.env
set +a
pnpm exec vitest run packages/server/src/organization-admin/team-service.test.ts packages/server/src/api/routes/admin-teams.test.ts packages/server/src/api/routes/accounts.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/organization-admin packages/server/src/api/routes/admin-teams.ts packages/server/src/api/routes/admin-teams.test.ts packages/server/src/api/routes/accounts.ts packages/server/src/api/routes/accounts.test.ts packages/server/src/api/server.ts
git commit -m "feat(server): enforce managed team lifecycle"
```

---

### Task 7: Platform account assignment and employee disable transaction

**Files:**
- Create: `packages/server/src/organization-admin/account-service.ts`
- Create: `packages/server/src/organization-admin/account-service.test.ts`
- Create: `packages/server/src/api/routes/admin-accounts.ts`
- Create: `packages/server/src/api/routes/admin-accounts.test.ts`
- Modify: `packages/server/src/organization-admin/user-service.ts`
- Modify: `packages/server/src/organization-admin/user-service.test.ts`
- Modify: `packages/server/src/api/routes/admin-users.ts`
- Modify: `packages/server/src/api/routes/admin-users.test.ts`
- Modify: `packages/server/src/api/server.ts`
- Modify: `packages/server/src/api/ws.ts`

**Interfaces:**
- Produces: `AccountAdminService.previewAssignment`, `assign`, `UserAdminService.previewDisable`, `disable`.
- Produces: post-commit effects `{ organizationChangedUserIds, cleanupRequestedUserIds, revokedUserIds }`.
- Consumes: account/team/user locks, device cleanup enqueue, operation token, `WsHub`.

- [ ] **Step 1: Write failing assignment matrix tests**

Cover agent forced team, teamless agent, manager only in led teams, manager with no teams, owner any enabled/null team, auditor rejection, disabled target, archived team, stale revision, adapter/Cloud no cleanup, web partition automatic cleanup, Signal manual cleanup, online unsupported web client blocker and manual override.

```ts
expect(await service.previewAssignment(ownerActor, {
  accountId: webAccountId,
  ownerUserId: nextAgentId,
  teamId: nextTeamId,
  baseRevision: 1,
  allowManualCleanup: false,
})).toMatchObject({
  kind: 'preview',
  preview: { summary: { accountsChanged: 1, automaticCleanupTasks: 1 } },
})
```

- [ ] **Step 2: Write disable transaction tests**

Cover agent accounts moving to owner while retaining team; native control version increments; manager requiring a replacement/archive resolution per team; all changes rolling back on one invalid resolution; user disabled/version incremented; and post-commit `session_revoked` only after successful commit.

- [ ] **Step 3: Run tests and confirm RED**

```bash
set -a
. ./.env
set +a
pnpm exec vitest run packages/server/src/organization-admin/account-service.test.ts packages/server/src/organization-admin/user-service.test.ts
```

Expected: FAIL because assignment and disable methods are absent.

- [ ] **Step 4: Implement assignment and disable services**

```ts
export interface OrganizationPostCommitEffects {
  organizationChangedUserIds: string[]
  cleanupRequestedUserIds: string[]
  revokedUserIds: string[]
}
```

Transactions return effects but never call WS while a transaction is open. Route composition publishes `organization_changed`, publishes `desktop_cleanup_requested`, then calls `hub.revokeUser` for revoked users after commit. Deduplicate and sort ids before publishing.

Assignment increments both `revision` and `native_control_version`; it never changes account id, credential reference or child records. Disable transfers every owned account to the unique owner, preserves `team_id`, creates cleanup tasks by connection mode, sets `disabled_at`, increments user/session version and resolves all led teams in the same transaction.

- [ ] **Step 5: Implement preview/execute routes**

Add account search plus assignment preview/execute. Add user disable preview/execute to `admin-users.ts`; its single documented endpoint likewise distinguishes `{ phase: 'preview', baseRevision, input }` from `{ phase: 'execute', operationToken }`. Add
`POST /api/admin/desktop/cleanup-tasks/:id/confirm-manual`; only owner can close a Signal/manual task, and the response
uses wording “已确认官方解除” rather than “本机已擦除”. Execute binds the exact target ids, normalized desired
assignment, manual-cleanup choice and revisions from its operation token.

- [ ] **Step 6: Run route and existing native-control regressions**

```bash
set -a
. ./.env
set +a
pnpm exec vitest run packages/server/src/api/routes/admin-accounts.test.ts packages/server/src/api/routes/admin-users.test.ts packages/server/src/api/routes/native.test.ts packages/server/src/auth/native-control-grant.test.ts
```

Expected: PASS, including old grant rejection after `native_control_version` changes.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/organization-admin packages/server/src/api/routes/admin-accounts.ts packages/server/src/api/routes/admin-accounts.test.ts packages/server/src/api/routes/admin-users.ts packages/server/src/api/routes/admin-users.test.ts packages/server/src/api/server.ts packages/server/src/api/ws.ts
git commit -m "feat(server): transfer accounts and disable employees safely"
```

---

### Task 8: Atomic unique-owner transfer

**Files:**
- Create: `packages/server/src/organization-admin/owner-transfer-service.ts`
- Create: `packages/server/src/organization-admin/owner-transfer-service.test.ts`
- Create: `packages/server/src/api/routes/admin-owner-transfer.ts`
- Create: `packages/server/src/api/routes/admin-owner-transfer.test.ts`
- Modify: `packages/server/src/api/server.ts`
- Modify: `packages/server/src/api/ws.ts`

**Interfaces:**
- Produces: `OwnerTransferService.preview`, `execute`.
- Consumes: password verification, operation token, team/account/device services, post-commit effects.

- [ ] **Step 1: Write exhaustive owner-transfer tests**

Test target agent/manager/auditor origins, old owner becoming agent/manager/auditor, target manager teams requiring replacement/archive, old owner manager-team selection, account normalization, incorrect current password, stale preview, concurrent transfer, database failure rollback, exactly one enabled owner before/after, and both users' session versions incrementing.

```ts
const result = await service.execute(currentOwnerActor, {
  operationToken: preview.operationToken,
  currentPassword: 'synthetic-current-password',
})
expect(result.kind).toBe('transferred')
expect(await enabledOwnerIds()).toEqual([targetUserId])
expect(await sessionVersions([currentOwnerId, targetUserId])).toEqual([2, 2])
```

- [ ] **Step 2: Run tests and confirm RED**

```bash
set -a
. ./.env
set +a
pnpm exec vitest run packages/server/src/organization-admin/owner-transfer-service.test.ts packages/server/src/api/routes/admin-owner-transfer.test.ts
```

Expected: FAIL because transfer service/routes do not exist.

- [ ] **Step 3: Implement one locked transaction**

Preview resolves every affected membership/account and returns counts plus a token binding both user revisions, all affected team/account revisions and the requested resolution digest. Execute verifies current owner password in memory, locks all rows in deterministic order, revalidates token and invariants, then swaps roles in one SQL statement so `users_single_enabled_owner_uq` is never violated.

After role swap, remove owner/auditor memberships; normalize old-owner agent/manager accounts; resolve displaced managers; enqueue automatic/manual cleanup obligations; increment both user session versions. Return post-commit effects and never log the password or token.

- [ ] **Step 4: Add owner-transfer routes**

Implement `/api/admin/owner-transfer/preview` and `/api/admin/owner-transfer`. Non-owner requests stop at `403`; write flag off stops before password verification; wrong password uses a generic forbidden response; success revokes both users after commit.

- [ ] **Step 5: Run transfer, auth and RBAC regressions**

```bash
set -a
. ./.env
set +a
pnpm exec vitest run packages/server/src/organization-admin/owner-transfer-service.test.ts packages/server/src/api/routes/admin-owner-transfer.test.ts packages/server/src/api/server.test.ts packages/server/src/rbac
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/organization-admin/owner-transfer-service.ts packages/server/src/organization-admin/owner-transfer-service.test.ts packages/server/src/api/routes/admin-owner-transfer.ts packages/server/src/api/routes/admin-owner-transfer.test.ts packages/server/src/api/server.ts packages/server/src/api/ws.ts
git commit -m "feat(server): add atomic owner transfer"
```

---

### Task 9: Electron device credential, mount sync and automatic partition cleanup

**Files:**
- Create: `packages/desktop/src/main/desktop-installation-store.ts`
- Create: `packages/desktop/src/main/desktop-installation-store.test.ts`
- Create: `packages/desktop/src/main/desktop-installation-manager.ts`
- Create: `packages/desktop/src/main/desktop-installation-manager.test.ts`
- Create: `packages/desktop/src/main/native-control-host.cleanup.test.ts`
- Create: `packages/desktop/src/desktop-installation-ipc.ts`
- Modify: `packages/desktop/src/main/imhub-window-runtime.ts`
- Modify: `packages/desktop/src/main/native-control-host.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/renderer/types.d.ts`

**Interfaces:**
- Produces renderer bridge `desktopInstallation.syncMounts(accountIds): Promise<DesktopInstallationSyncResult>`.
- Produces `NativeControlHost.purgeAccount(accountId): Promise<void>` for automatic web partition cleanup.
- Consumes session token already held by trusted main runtime after `session:save/load`, device server API and `persist:native-<accountId>`.

- [ ] **Step 1: Write secure store tests**

Inject filesystem, random bytes and safeStorage adapters. Prove first load creates an id/32-byte credential, disk bytes do not contain the credential sentinel, later loads restore the same identity, unavailable encryption returns `{ available: false }`, and corrupt files fail closed without printing ciphertext.

- [ ] **Step 2: Write manager tests**

Use a fake fetch and fake partition cleaner. Test register/sync, custom credential headers, auto task claim, purge-before-complete ordering, failed purge left pending, duplicate completed task ignored, and Signal/manual tasks never passed to the partition cleaner.

```ts
expect(calls).toEqual([
  'register',
  'claim',
  `purge:${webAccountId}`,
  `complete:${cleanupTaskId}`,
  'sync-mounts',
])
```

- [ ] **Step 3: Run Electron main tests and confirm RED**

Run: `pnpm exec vitest run packages/desktop/src/main/desktop-installation-store.test.ts packages/desktop/src/main/desktop-installation-manager.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement trusted-main ownership of secrets**

Store `installation.bin` under the existing im-hub session namespace using `safeStorage`; renderer never receives the device credential. `session:save` and successful `session:load` update an in-memory active Bearer token; `session:clear` removes it. The installation IPC accepts only validated UUID account ids and uses that main-process token.

Expose a public `purgeAccount` method that releases grants, closes matching guests, then calls `session.fromPartition('persist:native-' + accountId).clearStorageData()` and `clearCache()`. Existing remove-account IPC delegates to the same method.

The manager always registers, claims and completes automatic cleanup before syncing the current account mounts. Failed automatic cleanup and same-installation Signal/manual tasks remain in `blockedAccountIds`; those accounts are not synced or exposed as ready. Signal account ids are reported for server visibility but never sent to `purgeAccount`; a manual task for an old installation does not block the same account on a different installation.

- [ ] **Step 5: Wire preload and renderer declaration**

```ts
desktopInstallation: {
  syncMounts: (accountIds: string[]): Promise<DesktopInstallationSyncResult> =>
    ipcRenderer.invoke(DESKTOP_INSTALLATION_SYNC_CHANNEL, { accountIds }),
}
```

Apply the same trusted-host check used by session/native-control IPC. Do not expose arbitrary URL, headers, credential, file or partition arguments.

- [ ] **Step 6: Run desktop main/preload tests and build**

Run: `pnpm exec vitest run packages/desktop/src/main packages/desktop/src/preload`

Expected: PASS.

Run: `pnpm --filter @im-hub/desktop build`

Expected: main, preload and renderer build successfully.

- [ ] **Step 7: Commit**

```bash
git add packages/desktop/src/main packages/desktop/src/preload/index.ts packages/desktop/src/renderer/types.d.ts packages/desktop/src/desktop-installation-ipc.ts
git commit -m "feat(desktop): manage installation cleanup securely"
```

---

### Task 10: Desktop first-login, self-password change and revocation flow

**Files:**
- Create: `packages/desktop/src/renderer/components/InitialPasswordPage.tsx`
- Create: `packages/desktop/src/renderer/components/InitialPasswordPage.test.tsx`
- Create: `packages/desktop/src/renderer/components/ChangePasswordDialog.tsx`
- Create: `packages/desktop/src/renderer/components/ChangePasswordDialog.test.tsx`
- Modify: `packages/desktop/src/renderer/api/client.ts`
- Modify: `packages/desktop/src/renderer/api/client.test.ts`
- Modify: `packages/desktop/src/renderer/components/LoginPage.tsx`
- Modify: `packages/desktop/src/renderer/App.tsx`
- Modify: `packages/desktop/src/renderer/types.d.ts`
- Modify: `packages/desktop/src/renderer/components/AccountTabs.tsx`

**Interfaces:**
- Produces: `api.login(): Promise<LoginResponse>`, `api.completeInitialPassword`, `api.changePassword`.
- Produces: App auth state `checking | loggedOut | changingInitialPassword | loggedIn`.
- Consumes: shared auth/WS contracts and `desktopInstallation.syncMounts`.

- [ ] **Step 1: Write API and pure-render tests first**

Assert temporary login never persists `setupToken`, initial completion replaces it with an authenticated session, self-change atomically replaces the persisted token, 401 clears session, and password inputs are cleared after success/unmount.

```ts
const result = await api.login('agent@example.test', 'temporary-password')
expect(result.kind).toBe('password_change_required')
expect(sessionBridge.save).not.toHaveBeenCalled()
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `pnpm exec vitest run packages/desktop/src/renderer/api/client.test.ts packages/desktop/src/renderer/components/InitialPasswordPage.test.tsx packages/desktop/src/renderer/components/ChangePasswordDialog.test.tsx`

Expected: FAIL because the response union and components are absent.

- [ ] **Step 3: Implement auth client state**

Keep normal token and current user module-private. Keep setup token in a separate module-private variable that is never passed to `sessionBridge.save`. `completeInitialPassword` sends the setup token in Authorization with its dedicated scheme, clears it in `finally`, then persists only the returned ordinary token/user. `changePassword` returns and persists the replacement session before resolving.

- [ ] **Step 4: Implement first-change and self-change UI**

Both forms use two new-password fields, enforce 12–128 characters client-side without trim, preserve non-password field state on network errors, and clear password states on completion/unmount. `AccountTabs` opens the self-change dialog from the current-user menu.

- [ ] **Step 5: Handle `session_revoked` and organization wake-ups**

In App's exhaustive WS switch:

```ts
if (event.type === 'session_revoked') {
  backToLogin()
  return
}
if (event.type === 'organization_changed') {
  void refreshOrganizationScopedBootstrap()
  return
}
if (event.type === 'desktop_cleanup_requested') {
  void syncOwnedLocalMounts()
  return
}
```

After `listAccounts`, derive only current-user-owned local account ids and call `desktopInstallation.syncMounts`. A changed owner list causes React to unmount old webviews/Signal view before the cleanup cycle. Keep affected local panes unavailable until the returned `readyAccountIds` includes them; show an application-only blocking notice for failed automatic cleanup or same-installation manual work instead of mounting early.

- [ ] **Step 6: Run auth UI tests and desktop typecheck**

Run: `pnpm exec vitest run packages/desktop/src/renderer/api/client.test.ts packages/desktop/src/renderer/components/InitialPasswordPage.test.tsx packages/desktop/src/renderer/components/ChangePasswordDialog.test.tsx packages/desktop/src/renderer/bootstrap-retry.test.ts`

Expected: PASS.

Run: `pnpm --filter @im-hub/desktop exec tsc --noEmit`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/desktop/src/renderer
git commit -m "feat(desktop): enforce first login password change"
```

---

### Task 11: Typed admin client and race-safe management controllers

**Files:**
- Create: `packages/desktop/src/renderer/organization-admin/request-controller.ts`
- Create: `packages/desktop/src/renderer/organization-admin/request-controller.test.ts`
- Create: `packages/desktop/src/renderer/organization-admin/employee-controller.ts`
- Create: `packages/desktop/src/renderer/organization-admin/employee-controller.test.ts`
- Create: `packages/desktop/src/renderer/organization-admin/team-controller.ts`
- Create: `packages/desktop/src/renderer/organization-admin/team-controller.test.ts`
- Create: `packages/desktop/src/renderer/organization-admin/account-controller.ts`
- Create: `packages/desktop/src/renderer/organization-admin/account-controller.test.ts`
- Modify: `packages/desktop/src/renderer/api/client.ts`
- Modify: `packages/desktop/src/renderer/api/client.test.ts`

**Interfaces:**
- Produces typed API methods for every spec section 9 endpoint.
- Produces controllers with `load`, `loadMore`, `preview`, `execute`, `cancel`, and generation-based stale-response rejection.
- Consumes shared admin contracts and existing `HttpError`/`NetworkError`.

- [ ] **Step 1: Write typed request tests**

For users, teams and accounts, assert POST search bodies, AbortSignal forwarding, base revisions, preview token forwarding, and stable error code extraction. Assert no email/search term enters URL.

- [ ] **Step 2: Write controller race tests**

Cover old search response after filter change, old owner identity after session replacement, stale preview after row revision change, double execute, `409` latest snapshot, network result unknown followed by refresh, and temporary password kept only in the immediate command result.

```ts
const first = deferred<AdminPage<AdminUser>>()
const second = deferred<AdminPage<AdminUser>>()
controller.load({ q: 'old' }, () => first.promise)
controller.load({ q: 'new' }, () => second.promise)
second.resolve(pageFor('new'))
first.resolve(pageFor('old'))
expect(controller.snapshot().items).toEqual(pageFor('new').items)
```

- [ ] **Step 3: Run controller tests and confirm RED**

Run: `pnpm exec vitest run packages/desktop/src/renderer/organization-admin packages/desktop/src/renderer/api/client.test.ts`

Expected: FAIL because controllers and API methods do not exist.

- [ ] **Step 4: Implement request generations and result-unknown state**

Each controller owns one AbortController and monotonically increasing generation. Execute is single-flight. `NetworkError` after a mutation sets `outcome='unknown'`, disables repeat, calls the relevant search, and only then returns to idle. `REVISION_CONFLICT` replaces the row snapshot but retains the user's unsent form values for explicit re-confirmation.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm exec vitest run packages/desktop/src/renderer/organization-admin packages/desktop/src/renderer/api/client.test.ts`

Expected: PASS.

```bash
git add packages/desktop/src/renderer/organization-admin packages/desktop/src/renderer/api/client.ts packages/desktop/src/renderer/api/client.test.ts
git commit -m "feat(desktop): add organization admin state controllers"
```

---

### Task 12: Owner-only management center UI

**Files:**
- Create: `packages/desktop/src/renderer/components/OrganizationAdminView.tsx`
- Create: `packages/desktop/src/renderer/components/OrganizationAdminView.test.tsx`
- Create: `packages/desktop/src/renderer/components/OrganizationAdminEmployees.tsx`
- Create: `packages/desktop/src/renderer/components/OrganizationAdminEmployees.test.tsx`
- Create: `packages/desktop/src/renderer/components/OrganizationAdminTeams.tsx`
- Create: `packages/desktop/src/renderer/components/OrganizationAdminTeams.test.tsx`
- Create: `packages/desktop/src/renderer/components/OrganizationAdminAccounts.tsx`
- Create: `packages/desktop/src/renderer/components/OrganizationAdminAccounts.test.tsx`
- Create: `packages/desktop/src/renderer/components/AdminConfirmationDialog.tsx`
- Create: `packages/desktop/src/renderer/components/TemporaryPasswordDialog.tsx`
- Modify: `packages/desktop/src/renderer/components/FunctionCenter.tsx`
- Modify: `packages/desktop/src/renderer/components/FunctionCenter.test.tsx`
- Modify: `packages/desktop/src/renderer/components/AddAccountDialog.tsx`
- Modify: `packages/desktop/src/renderer/App.tsx`

**Interfaces:**
- Produces: owner-only `organizationAdmin` view with employee/team/account tabs.
- Consumes: Task 11 controllers, current server-refreshed role, account creation context.

- [ ] **Step 1: Write owner visibility and tab tests**

Render each role. Only owner sees “管理中心”; direct rendering with non-owner returns no admin controls. Verify employee filters/actions, team manager/count/status, account owner/team/cleanup state, and no account-delete action.

- [ ] **Step 2: Write sensitive/high-risk dialog tests**

Assert temporary password appears only after success, copy only happens on explicit click, close invokes a clear callback, component markup has no hidden persistence field, owner password stays local to transfer dialog, preview counts render before execute, and network-unknown state disables repeated execution.

Signal rows must contain “需在 Signal 官方已关联设备中人工解除” and must not contain “自动清理 Signal”。

- [ ] **Step 3: Run component tests and confirm RED**

Run: `pnpm exec vitest run packages/desktop/src/renderer/components/OrganizationAdminView.test.tsx packages/desktop/src/renderer/components/OrganizationAdminEmployees.test.tsx packages/desktop/src/renderer/components/OrganizationAdminTeams.test.tsx packages/desktop/src/renderer/components/OrganizationAdminAccounts.test.tsx`

Expected: FAIL because the components do not exist.

- [ ] **Step 4: Implement the three-tab management center**

Use existing theme/ui primitives and scroll behavior. Employee rows show status, role, zero/one team and account count. Team rows show manager, member/account counts and archived state. Account rows show platform, connection mode, status, owner, team, pending cleanup count and the four-state cleanup badge.

Create/reset returns `TemporaryPasswordDialog`; never put its value in zustand, localStorage or sessionStorage. Disable/archive/assign/owner-transfer use `AdminConfirmationDialog` with the preview operation token held only in component/controller memory.

- [ ] **Step 5: Make ordinary Add Account role-aware**

Load `/api/account-creation-context`: agent has no selector; manager selects one led team; owner selects an enabled team or ungrouped. Submit `teamId` only for manager/owner. Keep auditor blocked and do not let a request body set `owner_user_id`.

- [ ] **Step 6: Wire App and exhaustive navigation**

Add `organizationAdmin` to `ViewKey`, pass current role to `FunctionCenter`, hide the entry for non-owner, render `OrganizationAdminView` only when `user.role==='owner'`, and force `view='chat'` if a refreshed session role ceases to be owner.

- [ ] **Step 7: Run desktop component regression and build**

Run: `pnpm exec vitest run packages/desktop/src/renderer/components packages/desktop/src/renderer/organization-admin packages/desktop/src/renderer/navigation.test.ts packages/desktop/src/renderer/layout.test.ts`

Expected: PASS.

Run: `pnpm --filter @im-hub/desktop build`

Expected: main, preload and renderer build successfully.

- [ ] **Step 8: Commit**

```bash
git add packages/desktop/src/renderer
git commit -m "feat(desktop): add owner organization management center"
```

---

### Task 13: Cross-package regression, rollout documentation and delivery checkpoint

**Files:**
- Modify: `docs/RUNBOOK.md`
- Modify: `docs/features/06-需求缺口.md`
- Modify: `docs/superpowers/specs/2026-08-26-m0-product-scope.md`
- Modify: `docs/superpowers/specs/2026-09-05-m4-organization-admin-design.md`

**Interfaces:**
- Produces: verified M4-4 implementation checkpoint and exact internal rollout/rollback procedure.
- Consumes: all previous tasks.

- [ ] **Step 1: Run targeted security and domain suites together**

```bash
set -a
. ./.env
set +a
pnpm exec vitest run packages/shared/src/organization-admin.test.ts packages/server/src/auth packages/server/src/db/migrations/0016_organization_admin.test.ts packages/server/src/db/organization-preflight.test.ts packages/server/src/organization-admin packages/server/src/api/routes/admin-users.test.ts packages/server/src/api/routes/admin-teams.test.ts packages/server/src/api/routes/admin-accounts.test.ts packages/server/src/api/routes/admin-owner-transfer.test.ts packages/server/src/api/routes/desktop-installations.test.ts packages/desktop/src/main packages/desktop/src/renderer/organization-admin packages/desktop/src/renderer/components/OrganizationAdminView.test.tsx
```

Expected: PASS with zero failures.

- [ ] **Step 2: Run full typecheck**

Run: `pnpm typecheck`

Expected: exit 0. Fix exhaustive unions and fixture session versions directly; do not use casts that weaken production types.

- [ ] **Step 3: Run full automated regression on the isolated test database**

Before running, verify the resolved test URL database name ends exactly in `_test` without printing credentials.

```bash
set -a
. ./.env
set +a
pnpm test
```

Expected: all test files pass; existing intentional todo count does not increase.

- [ ] **Step 4: Run production desktop build**

Run: `pnpm --filter @im-hub/desktop build`

Expected: Electron main, preload and renderer bundles all succeed.

- [ ] **Step 5: Update operating documentation**

Document exact sequence: organization preflight → migration 0016 → server with writes disabled → macOS/Windows client upgrade → mount inventory → owner preview → enable writes. State that old JWTs require login again, completed cleanup tasks are operational state retained 30 days, Signal is always manual, and no production/dev migration was run by automated tests.

Update requirement-gap and product-scope wording from “management backend unimplemented” to the verified state only after automated implementation passes. Add the exact automated test counts and build result to design section 15; do not claim macOS/Windows manual acceptance until the user actually performs it.

- [ ] **Step 6: Review the complete diff for secrets and unrelated changes**

Run: `git status --short`

Run: `git diff --check`

Run: `git diff --name-only origin/main`

Expected: only M4-4 code/tests/docs; no `.env`, `data/`, platform profile/session, build output, token, QR, password or unrelated source files.

- [ ] **Step 7: Request whole-branch code review and resolve findings**

Invoke `superpowers:requesting-code-review` against `origin/main..HEAD`. Require reviewers to check RBAC route boundaries, transaction lock ordering, unique owner/lead constraints, password/token secrecy, WebSocket revocation, local partition cleanup, Signal manual-only handling, and result-unknown UI. Resolve every valid finding and rerun the affected test plus Tasks 13.2–13.4.

- [ ] **Step 8: Commit final documentation/checkpoint**

```bash
git add docs/RUNBOOK.md docs/features/06-需求缺口.md docs/superpowers/specs/2026-08-26-m0-product-scope.md docs/superpowers/specs/2026-09-05-m4-organization-admin-design.md
git commit -m "docs: record M4 organization admin checkpoint"
```

- [ ] **Step 9: Stop before real deployment or manual platform acceptance**

Do not run migration 0016 against the development/production database, enable organization writes, change real employee identities, transfer real platform accounts, or perform macOS/Windows manual acceptance without the user's explicit authorization. Hand off the verified branch, automated evidence, remaining manual checklist and rollback notes.
