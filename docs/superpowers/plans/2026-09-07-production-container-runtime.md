# Production Container Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reproducible single-host Docker Compose runtime with Caddy TLS, internal PostgreSQL/Redis, persistent TDLib data, safe secret initialization, backups, deploy, and rollback commands.

**Architecture:** Package the Node.js 22 TypeScript server in an immutable glibc-based image, expose only Caddy on ports 80/443, and isolate application/data networks. Keep production values in root-owned host files outside the repository; scripts generate local infrastructure secrets, validate exact release SHAs, and never delete volumes.

**Tech Stack:** Docker Engine/Compose plugin, Node.js 22 bookworm-slim, pnpm 10, Caddy 2, PostgreSQL 16, Redis 7 AOF, Bash, Vitest/Node validation scripts.

**Spec:** `docs/superpowers/specs/2026-09-07-production-server-deployment-design.md`

## Global Constraints

- Complete the translation-provider and production-app-readiness plans first; `/health/live`, `/health/ready`, `preflight:production`, and `bootstrap-owner` must exist.
- Work only in `/private/tmp/im-hub-m3-outbox`; this plan creates deployment artifacts but does not connect to or mutate the production server.
- Use Node.js 22 and pnpm 10 with `pnpm-lock.yaml`; application runtime must use a glibc base compatible with `prebuilt-tdlib` and `argon2`.
- Only Caddy publishes host ports 80/443. Application 4000, PostgreSQL 5432, and Redis 6379 remain on Docker networks.
- Redis uses AOF and a persistent volume; PostgreSQL, TDLib, Signal fallback data, Caddy data/config/logs use separate persistent volumes.
- Production files under `/etc/im-hub` are mode `600` and never copied into Git/build context/image layers or printed by validation commands.
- No deployment/rollback script may run `docker compose down -v`, prune named volumes, or execute migration `down()`.
- `WHATSAPP_CLOUD_ENABLED=false`, `DEFAULT_TRANSLATION_PROVIDER=deepl`, `TRUSTED_PROXY_CIDRS=172.30.0.2/32`, and exact origin `https://imhub.jojo2333.net` are fixed production policy.

---

### Task 1: Create the immutable server image

**Files:**
- Create: `.dockerignore`
- Create: `deploy/Dockerfile.server`
- Create: `deploy/scripts/container-smoke.mjs`
- Modify: `package.json`
- Modify: `packages/server/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: image entrypoint `pnpm --filter @im-hub/server start`.
- Produces: the same image can run `migrate`, `preflight:production`, and `bootstrap-owner` scripts.

- [ ] **Step 1: Write a failing image-structure smoke test**

```js
const response = await fetch('http://127.0.0.1:4000/health/live')
if (response.status !== 200) throw new Error(`health status ${response.status}`)
const body = await response.json()
if (body.status !== 'live') throw new Error('unexpected health body')
```

Add a test command that inspects the built image and asserts the runtime user is not root and `.env`/`data` do not exist in `/app`.

- [ ] **Step 2: Add the production start command and runtime dependency**

Pin the workspace package manager with `"packageManager": "pnpm@10.18.1"`. Move `tsx` from server
`devDependencies` to `dependencies` and add:

```json
"start": "tsx src/index.ts"
```

Run: `pnpm install --lockfile-only`

Expected: only the pnpm lockfile changes; no npm/yarn lockfile.

- [ ] **Step 3: Create a multi-stage glibc Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS dependencies
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.18.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
RUN pnpm install --frozen-lockfile --prod --filter @im-hub/server...

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.18.1 --activate \
  && install -d -o node -g node /var/lib/im-hub/tdlib /var/lib/im-hub/signal
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/packages ./packages
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/src packages/shared/src
COPY packages/server/src packages/server/src
COPY packages/server/tdlib-types.d.ts packages/server/tdlib-types.d.ts
USER node
CMD ["pnpm", "--filter", "@im-hub/server", "start"]
```

Adjust copy locations after inspecting the actual pnpm filtered install output; do not broaden `.dockerignore`. Ignore `.git`, `.env*` except `.env.example`, `data`, build outputs, platform sessions, dumps, and desktop artifacts.

- [ ] **Step 4: Build and smoke the image with disposable dependencies**

Run: `docker build -f deploy/Dockerfile.server -t im-hub-server:plan-smoke .`

Expected: build succeeds using the frozen lockfile.

Run the image against disposable PostgreSQL/Redis with synthetic test-only env, wait for `/health/live`, run `container-smoke.mjs`, then remove only the named smoke containers/network.

Expected: health returns 200; runtime uid is nonzero; no ignored secret/session paths are present.

- [ ] **Step 5: Commit the image**

```bash
git add .dockerignore deploy/Dockerfile.server deploy/scripts/container-smoke.mjs package.json packages/server/package.json pnpm-lock.yaml
git commit -m "build: package the production server image"
```

### Task 2: Define production Compose and Caddy ingress

**Files:**
- Create: `deploy/compose.prod.yml`
- Create: `deploy/Caddyfile`
- Create: `deploy/caddy/cloudflare-trusted-proxies.caddy`
- Create: `deploy/env/app.env.example`
- Create: `deploy/env/postgres.env.example`
- Create: `deploy/env/redis.env.example`
- Create: `deploy/env/compose.env.example`
- Create: `deploy/scripts/validate-runtime.mjs`
- Create: `deploy/scripts/validate-runtime.test.ts`

**Interfaces:**
- Produces: services `caddy`, `app`, `migrate`, `bootstrap-owner`, `postgres`, `redis` and networks `edge`, `data`.
- Produces: Caddy active health target `/health/ready` and automatic HTTPS for the exact company host.
- Consumes: Task 1 image and app plan health endpoints.

- [ ] **Step 1: Write failing runtime-policy tests**

```ts
import { execFileSync } from 'node:child_process'

type JsonObject = Record<string, unknown>
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object')
  return value as JsonObject
}

function loadComposeWithExampleEnv(): JsonObject {
  const rendered = execFileSync('docker', [
    'compose', '-f', 'deploy/compose.prod.yml',
    '--env-file', 'deploy/env/compose.env.example',
    'config', '--format', 'json',
  ], { encoding: 'utf8' })
  return object(JSON.parse(rendered) as unknown)
}

it('publishes only caddy and retains every production volume', async () => {
  const runtime = await loadComposeWithExampleEnv()
  const services = object(runtime.services)
  expect(object(services.caddy).ports).toHaveLength(2)
  expect(object(services.app).ports).toBeUndefined()
  expect(object(services.postgres).ports).toBeUndefined()
  expect(object(services.redis).ports).toBeUndefined()
  expect(Object.keys(object(runtime.volumes))).toEqual(expect.arrayContaining([
    'postgres_data', 'redis_data', 'tdlib_data', 'signal_data',
    'caddy_data', 'caddy_config', 'caddy_logs',
  ]))
})
```

Also assert Redis command enables `appendonly yes`, WhatsApp Cloud is false in example policy, app joins edge+data, DB/Redis join data only, and no example contains `imhub_dev` or `change-me-in-production`.

- [ ] **Step 2: Run the test and verify deployment files are missing**

Run: `pnpm exec vitest run deploy/scripts/validate-runtime.test.ts`

Expected: FAIL because `compose.prod.yml` and examples do not exist.

- [ ] **Step 3: Create Compose services and health ordering**

```yaml
services:
  app:
    build:
      context: ..
      dockerfile: deploy/Dockerfile.server
    env_file: ${IMHUB_APP_ENV_FILE:-/etc/im-hub/app.env}
    networks: [edge, data]
    volumes:
      - tdlib_data:/var/lib/im-hub/tdlib
      - signal_data:/var/lib/im-hub/signal
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    restart: unless-stopped
```

Add a one-shot `migrate` service using the same image, `postgres:16` with `pg_isready`, `redis:7` with `--appendonly yes --requirepass`, and `caddy:2` with only `80:80` and `443:443`. Pin image major versions; release scripts tag the app with exact SHA.

Define `edge` with a fixed non-overlapping IPv4 subnet `172.30.0.0/24`, assign Caddy `172.30.0.2`, and inject
`TRUSTED_PROXY_CIDRS=172.30.0.2/32` into the application policy. The application must never use
`trustProxy: true` or numeric hop-count trust.

- [ ] **Step 4: Add Caddy TLS, WebSocket proxy, logging, and health policy**

```caddyfile
{
  import /etc/caddy/cloudflare-trusted-proxies.caddy
}

imhub.jojo2333.net {
  request_body { max_size 2MB }
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer"
    Cache-Control "no-store"
    -Server
  }
  reverse_proxy app:4000 {
    health_uri /health/ready
    health_interval 10s
    health_timeout 3s
    health_fails 3
    health_passes 2
  }
  log {
    output file /var/log/caddy/access.json {
      roll_size 20MiB
      roll_keep 10
      roll_keep_for 168h
    }
    format filter {
      request>uri delete
    }
  }
}
```

The trusted-proxy snippet uses Cloudflare's official IPv4/IPv6 CIDRs plus `trusted_proxies_strict`; Caddy's standard
reverse proxy handles WebSocket upgrades. Access logs delete the full request URI, append only the query-free path,
and do not include request/response bodies or authorization headers. Cross-check the syntax against Caddy's official
[`trusted_proxies` documentation](https://caddyserver.com/docs/caddyfile/options#trusted-proxies) and
[`reverse_proxy` health options](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#active-health-checks).

- [ ] **Step 5: Validate and commit the runtime definition**

Run: `node deploy/scripts/validate-runtime.mjs --examples`

Expected: exits 0 without printing composed environment values.

Run: `pnpm exec vitest run deploy/scripts/validate-runtime.test.ts`

Expected: PASS.

```bash
git add deploy/compose.prod.yml deploy/Caddyfile deploy/caddy deploy/env deploy/scripts/validate-runtime.mjs deploy/scripts/validate-runtime.test.ts
git commit -m "build: define the production compose runtime"
```

### Task 3: Initialize production secrets without disclosure

**Files:**
- Create: `deploy/scripts/init-production-config.sh`
- Create: `deploy/scripts/init-production-config.test.sh`
- Create: `deploy/scripts/rotate-production-secret.sh`
- Modify: `deploy/env/app.env.example`
- Modify: `docs/RUNBOOK.md`

**Interfaces:**
- Produces: `/etc/im-hub/app.env`, `/etc/im-hub/postgres.env`, `/etc/im-hub/redis.env`, all root-owned mode 600.
- Consumes: administrator's hidden interactive DeepL, Claude, OpenAI and Telegram values.

- [ ] **Step 1: Write a failing shell test with a disposable config root**

```bash
config_root="$(mktemp -d)"
trap 'rm -rf "$config_root"' EXIT
IMHUB_CONFIG_ROOT="$config_root" IMHUB_TEST_INPUT_FILE="$fixture" \
  bash deploy/scripts/init-production-config.sh --test-input
test "$(stat -f '%Lp' "$config_root/app.env" 2>/dev/null || stat -c '%a' "$config_root/app.env")" = 600
! grep -R 'synthetic-deepl-secret' "$test_log"
```

Test refusal to overwrite existing files, missing/blank provider values, invalid Telegram numeric id/hash, newline/control characters, and successful fixed policy values.

- [ ] **Step 2: Run the shell test and verify the script is missing**

Run: `bash deploy/scripts/init-production-config.test.sh`

Expected: FAIL because the initializer does not exist.

- [ ] **Step 3: Implement local generation and hidden prompts**

```bash
umask 077
install -d -m 700 "$config_root"
db_password="$(openssl rand -hex 32)"
redis_password="$(openssl rand -hex 32)"
jwt_secret="$(openssl rand -base64 48 | tr -d '\n')"
read -r -s -p 'DeepL API Key: ' deepl_key; printf '\n' >&2
read -r -s -p 'Claude API Key: ' anthropic_key; printf '\n' >&2
read -r -s -p 'OpenAI API Key: ' openai_key; printf '\n' >&2
```

Write via temporary files then `chmod 600`, `chown root:root`, and atomic rename. `app.env` fixes production origin, paths, default provider, Cloud false, admin writes true, and uses generated hex passwords in internal URLs. Unset all secret variables before exit. Print only created file paths and configured/missing names.

- [ ] **Step 4: Add an allowlisted atomic rotation command**

`rotate-production-secret.sh` accepts only `DEEPL_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`TELEGRAM_API_ID`, or `TELEGRAM_API_HASH`; it reads the replacement without echo, atomically updates only that key
in `/etc/im-hub/app.env`, restarts only the app, and requires readiness before deleting its mode-600 rollback copy.
If readiness fails it restores the old file and restarts the old configuration. The script prints the variable name and
status only, never old/new values. It holds the same release-operation lock as deploy/rollback and revalidates the
recorded and running app image under that lock before changing configuration. Failure or termination after activation
must restore the old file, recreate the app with it, and verify readiness; failed recovery emits an urgent operator alert.

- [ ] **Step 5: Verify non-disclosure and syntax**

Run: `bash -n deploy/scripts/init-production-config.sh deploy/scripts/rotate-production-secret.sh && bash deploy/scripts/init-production-config.test.sh`

Expected: PASS; captured stdout/stderr contains none of the synthetic secret sentinels.

- [ ] **Step 6: Commit initializer, rotation, and operator instructions**

```bash
git add deploy/scripts/init-production-config.sh deploy/scripts/init-production-config.test.sh deploy/scripts/rotate-production-secret.sh deploy/env/app.env.example docs/RUNBOOK.md
git commit -m "ops: initialize production secrets safely"
```

### Task 4: Add daily/weekly PostgreSQL backup and restore smoke scripts

**Files:**
- Create: `deploy/scripts/backup-postgres.sh`
- Create: `deploy/scripts/restore-postgres-smoke.sh`
- Create: `deploy/scripts/backup-postgres.test.sh`
- Create: `deploy/systemd/im-hub-backup.service`
- Create: `deploy/systemd/im-hub-backup.timer`
- Modify: `docs/RUNBOOK.md`

**Interfaces:**
- Produces: compressed custom-format dumps under `/var/backups/im-hub/daily` and `/var/backups/im-hub/weekly`.
- Produces: retention of 7 newest daily and 4 newest weekly files.
- Produces: restore target fixed to `imhub_restore_smoke` and always removed in `finally`/trap.

- [ ] **Step 1: Write failing retention and redaction tests**

```bash
for day in {01..9}; do touch -t "202609${day}0000" "$daily/imhub-$day.dump"; done
for week in {01..6}; do touch -t "20260${week}010000" "$weekly/imhub-$week.dump"; done
IMHUB_BACKUP_ROOT="$root" IMHUB_BACKUP_TEST_MODE=1 bash deploy/scripts/backup-postgres.sh
test "$(find "$daily" -type f | wc -l | tr -d ' ')" = 7
test "$(find "$weekly" -type f | wc -l | tr -d ' ')" = 4
```

Assert logs do not contain synthetic DB passwords or dump contents and the restore script rejects every database name except its hard-coded smoke name.

- [ ] **Step 2: Run tests and verify scripts are missing**

Run: `bash deploy/scripts/backup-postgres.test.sh`

Expected: FAIL because backup scripts do not exist.

- [ ] **Step 3: Implement atomic compressed backups and exact-count retention**

Use `docker compose exec -T postgres pg_dump --format=custom --dbname="$POSTGRES_DB"` to a mode-600 temporary file, validate with `pg_restore --list`, then atomically rename. On the weekly schedule copy the validated daily artifact to weekly. Sort filenames by timestamp and delete only files matching `^imhub-[0-9]{8}T[0-9]{6}Z\.dump$` beyond the exact counts.

- [ ] **Step 4: Implement isolated restore smoke and systemd timer**

The restore script creates `imhub_restore_smoke`, restores the selected dump, verifies migration-table and non-sensitive table counts, then drops only `imhub_restore_smoke` in a trap. The timer runs daily with `Persistent=true`; service uses the fixed Compose file and root config path.

Run: `bash -n deploy/scripts/backup-postgres.sh deploy/scripts/restore-postgres-smoke.sh && bash deploy/scripts/backup-postgres.test.sh`

Expected: PASS.

- [ ] **Step 5: Commit backup operations**

```bash
git add deploy/scripts/backup-postgres.sh deploy/scripts/restore-postgres-smoke.sh deploy/scripts/backup-postgres.test.sh deploy/systemd docs/RUNBOOK.md
git commit -m "ops: back up and restore the production database"
```

### Task 5: Add exact-SHA deploy and application rollback scripts

**Files:**
- Create: `deploy/scripts/deploy-release.sh`
- Create: `deploy/scripts/rollback-release.sh`
- Create: `deploy/scripts/release-policy.test.sh`
- Modify: `docs/RUNBOOK.md`

**Interfaces:**
- Produces: release tags `im-hub-server:$RELEASE_SHA` where `RELEASE_SHA` is validated as 40 lowercase hex, a root-only atomic state manifest under `/var/lib/im-hub/releases`, and an atomic `/opt/im-hub/current` release link.
- Consumes: backup script, migrate service, production preflight and readiness endpoint.
- Produces: rollback changes application image only and never runs migration down.

- [ ] **Step 1: Write failing release safety tests**

```bash
! bash deploy/scripts/deploy-release.sh main
! bash deploy/scripts/rollback-release.sh latest
! rg -n 'down -v|volume prune|system prune' deploy/scripts/deploy-release.sh deploy/scripts/rollback-release.sh
```

Use a fake `docker` executable to record calls and assert the order is backup, build exact SHA, migrate, start, readiness, preflight, record state.

- [ ] **Step 2: Run tests and verify scripts are missing**

Run: `bash deploy/scripts/release-policy.test.sh`

Expected: FAIL because release scripts do not exist.

- [ ] **Step 3: Implement exact-SHA deploy**

```bash
release_sha="$1"
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'release SHA must be 40 lowercase hex' >&2; exit 2; }
git cat-file -e "${release_sha}^{commit}"
test -z "$(git status --porcelain)"
```

Record and verify the current image before building. Hold a shared release lock, run backup, build the exact checked-out commit, run the one-shot migrate service, start app/Caddy, poll `/health/ready` with a bounded timeout, run production preflight inside the app network, recheck the activated image, then atomically update the current link and current/previous manifest without requiring host Node.js. From the first app replacement onward, any failed activation restores and verifies recorded current; a failed first release stops app/Caddy, falls back to forced termination if needed, and reports an urgent operator action if neither can be confirmed. No secret values enter command output.

- [ ] **Step 4: Implement bounded application rollback**

Validate the target tag exists and is the recorded previous SHA. Point Compose to that app image, start it, and require readiness. Print a warning that schema is not rolled back; if the old image cannot use the migrated schema, stop and use the documented restore decision rather than dropping data.

Run: `bash -n deploy/scripts/deploy-release.sh deploy/scripts/rollback-release.sh && bash deploy/scripts/release-policy.test.sh`

Expected: PASS and recorded fake calls contain no destructive volume command.

- [ ] **Step 5: Commit release operations**

```bash
git add deploy/scripts/deploy-release.sh deploy/scripts/rollback-release.sh deploy/scripts/release-policy.test.sh docs/RUNBOOK.md
git commit -m "ops: deploy and roll back exact server releases"
```

### Task 6: Container-runtime verification checkpoint

**Files:**
- Modify: `docs/RUNBOOK.md`
- Test: Dockerfile, Compose, Caddy, secret initializer, backup, restore, release, full application.

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: repository artifacts ready for the production-server-rollout plan.

- [ ] **Step 1: Validate all static and shell artifacts**

Run: `bash -n deploy/scripts/*.sh`

Expected: PASS.

Run: `pnpm exec vitest run deploy/scripts/validate-runtime.test.ts`

Expected: PASS.

Run: `bash deploy/scripts/init-production-config.test.sh && bash deploy/scripts/backup-postgres.test.sh && bash deploy/scripts/release-policy.test.sh`

Expected: PASS with no secret sentinel in output.

- [ ] **Step 2: Render Compose without printing values**

Run: `node deploy/scripts/validate-runtime.mjs --examples`

Expected: PASS; command uses `docker compose config --quiet` and policy assertions without writing the rendered environment to stdout.

- [ ] **Step 3: Build and run the disposable runtime smoke**

Run: `docker build -f deploy/Dockerfile.server -t im-hub-server:plan-smoke .`

Expected: PASS.

Start the example Compose project under a unique smoke project name, run migrations, test `/health/live` and `/health/ready`, restart app/PostgreSQL/Redis, verify the health endpoints recover, then remove only the smoke project and its explicitly named disposable volumes.

- [ ] **Step 4: Run repository-wide verification and inspect files**

Run: `pnpm typecheck && pnpm test && pnpm --filter @im-hub/desktop build`

Expected: PASS.

Run: `git diff --check && git status --short && git diff --name-only`

Expected: intended Docker/deploy/source/docs/lockfile only; no real env, dump, session, credential, image tar, QR, code, or build output.

- [ ] **Step 5: Commit the final runtime documentation**

```bash
git add docs/RUNBOOK.md
git commit -m "docs: finalize production runtime operations"
```
