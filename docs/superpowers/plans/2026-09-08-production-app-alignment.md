# Production App Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align production provider checks, packaged platform capabilities, and desktop translation errors so the installed app reports only what it can actually do.

**Architecture:** Keep provider configuration and probing in the server production preflight, expose a small build/runtime capability object to the renderer, and split translation and native-composer failures at the existing desktop boundary. No database or session changes.

**Tech Stack:** Node.js 22, TypeScript, Fastify, Vitest, Electron 33, React 19, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-08-production-app-alignment-design.md`

## Global Constraints

- Do not read, print, persist, or commit secrets, `.env`, tokens, sessions, QR codes, verification codes, or 2FA passwords.
- Preserve development Telegram `http://localhost:1234/` and Signal integrated-host behavior.
- Keep the main checkout untouched; all changes stay in `/private/tmp/im-hub-m3-outbox`.
- Use test-first changes and run affected tests before broader verification.

### Task 1: Make production DeepL checks truthful

**Files:**
- Modify: `packages/server/src/production/preflight.ts`
- Modify: `packages/server/src/production/preflight.test.ts`
- Modify: `deploy/scripts/init-production-config.sh`
- Modify: `deploy/env/app.env.example`
- Modify: `docs/RUNBOOK.md`

**Interfaces:**
- `runProductionPreflight` continues returning named checks; the DeepL check now performs a redacted HTTP status probe.
- The script preserves an explicitly supplied `DEEPL_ENDPOINT` and never writes a provider key or response body.

- [ ] **Step 1: Write the failing tests**

  Add tests proving a configured endpoint is probed, a 2xx/401 response is classified without exposing credentials, and the production init template does not overwrite an explicit endpoint.

- [ ] **Step 2: Run the focused tests and verify the expected failure**

  Run `pnpm exec vitest run packages/server/src/production/preflight.test.ts`.
  Expected: the new probe assertions fail because production preflight currently only checks non-empty strings.

- [ ] **Step 3: Implement the minimal probe and config preservation**

  Reuse the existing server HTTP/test patterns, report only endpoint host and status, and update the shell template to use `${DEEPL_ENDPOINT:-https://api-free.deepl.com/v2/translate}` without printing the value.

- [ ] **Step 4: Run tests and config checks**

  Run `pnpm exec vitest run packages/server/src/production/preflight.test.ts packages/server/src/config.test.ts` and `bash -n deploy/scripts/init-production-config.sh`.
  Expected: PASS with no secret-like output.

- [ ] **Step 5: Update the runbook wording**

  Document that paid accounts must explicitly set the paid endpoint and that preflight performs a live status check.

### Task 2: Gate platform capabilities in the packaged desktop

**Files:**
- Modify: `packages/desktop/src/renderer/components/AddAccountDialog.tsx`
- Modify: `packages/desktop/src/renderer/components/NativeClient.tsx`
- Modify: `packages/desktop/src/renderer/components/NativeClient.test.ts`
- Modify: `packages/desktop/src/renderer/components/AddAccountDialog.product.test.tsx`
- Modify: `packages/desktop/src/main/native-host-policy.ts`
- Modify: `packages/desktop/src/main/renderer-server.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/package.json`

**Interfaces:**
- Add a renderer-readable `imHub.capabilities` object with booleans for `whatsappWeb`, `telegramStatic`, and `signalDesktop`.
- Development defaults retain Telegram localhost and integrated Signal; packaged builds set only capabilities they actually ship.

- [ ] **Step 1: Write failing capability tests**

  Assert that a standalone packaged capability set disables Telegram and Signal account creation/opening while keeping WhatsApp enabled; assert that development overrides preserve the existing localhost route.

- [ ] **Step 2: Run focused desktop tests and verify failure**

  Run `pnpm exec vitest run packages/desktop/src/renderer/components/NativeClient.test.ts packages/desktop/src/renderer/components/AddAccountDialog.product.test.tsx`.
  Expected: the new packaged-capability assertions fail because all three platforms are currently marked ready.

- [ ] **Step 3: Implement the smallest capability boundary**

  Define one typed capability object in preload, derive its values from an explicit build/runtime flag, and make both UI entry points consult it. Do not remove development URLs or modify session handling.

- [ ] **Step 4: Run the focused desktop tests and typecheck**

  Run the two focused test files, then `pnpm typecheck`.
  Expected: PASS and no new TypeScript errors.

### Task 3: Split translation and native write failures

**Files:**
- Modify: `packages/desktop/src/renderer/components/TranslationDock.tsx`
- Modify: `packages/desktop/src/renderer/components/TranslationDock.test.tsx`
- Modify: `packages/desktop/src/preload/whatsapp-web-translation.ts`

**Interfaces:**
- Translation API rejection maps to a provider/server error state.
- `nativeComposerBridge.setDraft` rejection maps to a native-write error state.
- WhatsApp bubble retry continues to call the same retry action.

- [ ] **Step 1: Write failing error-boundary tests**

  Add one test for a rejected translation request and one for a rejected native draft write; assert that their user-facing messages differ and identify the failing boundary.

- [ ] **Step 2: Run the focused test and verify failure**

  Run `pnpm exec vitest run packages/desktop/src/renderer/components/TranslationDock.test.tsx`.
  Expected: both new assertions fail because the current catch block uses one combined message.

- [ ] **Step 3: Implement separate catches**

  Keep the existing request order, catch translation before attempting native write, and catch only the composer call around `setDraft`. Do not log payloads or provider responses.

- [ ] **Step 4: Run desktop tests and build**

  Run the focused TranslationDock tests, the full desktop renderer test set, and `pnpm --filter @im-hub/desktop build`.
  Expected: PASS and a successful Electron build.

### Task 4: Cross-check and release gate

**Files:**
- Review only: `docs/superpowers/specs/2026-09-08-production-app-alignment-design.md`, `docs/RUNBOOK.md`, package manifests and test output.

- [ ] **Step 1: Run the relevant server and desktop suites**

  Run `pnpm exec vitest run packages/server/src/production/preflight.test.ts packages/server/src/config.test.ts packages/desktop/src/renderer/components/NativeClient.test.ts packages/desktop/src/renderer/components/AddAccountDialog.product.test.tsx packages/desktop/src/renderer/components/TranslationDock.test.tsx`.

- [ ] **Step 2: Run typecheck and desktop build**

  Run `pnpm typecheck` and `pnpm --filter @im-hub/desktop build`.

- [ ] **Step 3: Inspect the diff and sensitive-file guard**

  Run `git diff --check`, `git status --short`, and `git diff --name-only`; verify no `.env`, `data/`, build artifacts, credentials, session paths, QR strings, or 2FA values are present.

- [ ] **Step 4: Report remaining second-phase work**

  Do not create a new installer yet. Report that Telegram static bundling, Signal host integration, and installed-app production E2E remain a separate release gate.
