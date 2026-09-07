# Production Server Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely provision the confirmed empty Ubuntu server, deploy the exact reviewed im-hub release at `imhub.jojo2333.net`, harden ingress/SSH, bootstrap the first owner, validate macOS/Windows clients, and ramp Telegram to 50 accounts.

**Architecture:** First add and test repeatable host/firewall scripts in the repository, then mutate the server through explicit checkpoints: alternate SSH admin, Docker install, DNS-only TLS, secret entry, exact-SHA deploy, owner bootstrap, Cloudflare proxy, Cloudflare-only origin firewall, production smoke, and staged Telegram onboarding. Every destructive or lockout-prone operation has a read-only precheck and a second-session verification gate.

**Tech Stack:** Ubuntu 26.04 LTS, OpenSSH, Docker Engine/Compose plugin, UFW plus `DOCKER-USER`, Cloudflare DNS/SSL, Caddy, Git/GitHub Actions, curl, Bash.

**Spec:** `docs/superpowers/specs/2026-09-07-production-server-deployment-design.md`

## Global Constraints

- Complete and merge the translation-provider, application-readiness, and container-runtime plans before executing remote deployment.
- Local source work remains in `/private/tmp/im-hub-m3-outbox`; never modify either main checkout.
- Target is the confirmed fresh server at `139.180.218.42`; use `/Users/mac/.ssh/imhub_vultr` with `IdentitiesOnly=yes` and strict host-key checking.
- Do not print/read/commit/log `/etc/im-hub/*.env`, private keys, API keys, passwords, tokens, QR, codes, 2FA, platform session contents, customer text, or database dump contents.
- Never send production secrets through Codex chat or command arguments. The administrator enters them through hidden prompts in their own SSH terminal.
- Do not disable root SSH until `imhub-deploy` public-key login and `sudo -n true` both work in a second session.
- Do not switch the firewall to Cloudflare-only until proxied HTTPS/WSS works with Cloudflare `Full (strict)`.
- Do not run `docker compose down -v`, delete named volumes, prune system-wide Docker state, run development `seed.ts`, or point tests at production.
- Telegram rollout stops at 10, 25, and 50 with the specified observation windows and resource gates.
- Follow Docker's [official Ubuntu installation procedure](https://docs.docker.com/engine/install/ubuntu/), which lists Ubuntu 26.04 LTS as supported, and Cloudflare's [official origin allowlist guidance](https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/).

---

### Task 1: Add a repeatable Ubuntu host provisioner

**Files:**
- Create: `deploy/scripts/provision-ubuntu.sh`
- Create: `deploy/scripts/provision-ubuntu.test.sh`
- Modify: `docs/RUNBOOK.md`

**Interfaces:**
- Produces: `--check` read-only mode and `--apply` mutation mode.
- Produces: Docker Engine/Compose plugin, Git/curl/CA tools, UFW base policy, and `/opt`/`/etc`/backup/release directories.

- [ ] **Step 1: Write failing provision-policy tests**

```bash
bash deploy/scripts/provision-ubuntu.sh --check --root "$fixture_root"
grep -F 'docker-compose-plugin' "$recorded_apt_calls"
! grep -E 'get\.docker\.com|curl.*\|.*sh' "$recorded_commands"
grep -F 'ufw allow 22/tcp' "$recorded_commands"
```

Use fake `apt`, `systemctl`, `ufw`, `install`, and `docker` binaries. Assert `--check` performs no writes and `--apply` rejects unsupported OS/architecture before calling apt.

- [ ] **Step 2: Run the test and verify the script is missing**

Run: `bash deploy/scripts/provision-ubuntu.test.sh`

Expected: FAIL because the provisioner does not exist.

- [ ] **Step 3: Implement official-repository Docker installation**

The script verifies `ID=ubuntu`, `VERSION_ID=26.04`, `x86_64`, at least 4 CPUs, at least 10 GiB RAM, and sufficient disk. In `--apply`, install Docker from its signed apt repository:

```bash
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Create `/opt/im-hub/releases`, `/etc/im-hub`, `/var/backups/im-hub/{daily,weekly}`, and `/var/lib/im-hub/releases` with restrictive owners/modes. Enable Docker. Configure UFW only after allowing 22/tcp, 80/tcp and 443/tcp; Docker-published-port restriction is handled separately in Task 2.

- [ ] **Step 4: Run syntax and policy tests**

Run: `bash -n deploy/scripts/provision-ubuntu.sh && bash deploy/scripts/provision-ubuntu.test.sh`

Expected: PASS; no convenience installer or destructive package command is present.

- [ ] **Step 5: Commit the provisioner**

```bash
git add deploy/scripts/provision-ubuntu.sh deploy/scripts/provision-ubuntu.test.sh docs/RUNBOOK.md
git commit -m "ops: provision the production Ubuntu host"
```

### Task 2: Add Cloudflare range synchronization and Docker firewall policy

**Files:**
- Create: `deploy/scripts/sync-cloudflare-ranges.sh`
- Create: `deploy/scripts/enforce-cloudflare-origin.sh`
- Create: `deploy/scripts/cloudflare-firewall.test.sh`
- Create: `deploy/systemd/im-hub-cloudflare-origin.service`
- Modify: `deploy/caddy/cloudflare-trusted-proxies.caddy`
- Modify: `docs/RUNBOOK.md`

**Interfaces:**
- Produces: validated pinned CIDRs used by Caddy and `DOCKER-USER`.
- Produces: explicit `--audit` and `--enforce-after-proxy-check` modes.
- Consumes: only official `https://www.cloudflare.com/ips-v4` and `/ips-v6` data.

- [ ] **Step 1: Write failing range/firewall tests**

```bash
bash deploy/scripts/sync-cloudflare-ranges.sh --check-fixture "$valid_ranges"
! bash deploy/scripts/sync-cloudflare-ranges.sh --check-fixture "$html_instead_of_cidrs"
bash deploy/scripts/enforce-cloudflare-origin.sh --audit --iptables-save "$fixture_rules"
```

Assert the generated chain accepts established traffic and every pinned Cloudflare CIDR on TCP 80/443, then rejects other sources to those forwarded ports. Assert it never changes host port 22 and `--audit` never invokes `iptables-restore`.

- [ ] **Step 2: Run tests and verify scripts are missing**

Run: `bash deploy/scripts/cloudflare-firewall.test.sh`

Expected: FAIL because the range and firewall scripts do not exist.

- [ ] **Step 3: Implement validated range synchronization**

Download both official lists to temporary files, require HTTPS success, reject blank/non-CIDR/HTML content, sort
uniquely, and render a complete `trusted_proxies static` Caddy snippet with `trusted_proxies_strict`. In normal mode
show a diff and require a code review/commit; do not silently rewrite production firewall rules.

- [ ] **Step 4: Implement atomic `DOCKER-USER` enforcement**

Create a dedicated `IMHUB-CLOUDFLARE` chain and jump to it from `DOCKER-USER`; build the complete ruleset in a temporary file and validate with `iptables-restore --test` before applying. The mutation mode requires the exact flag `--enforce-after-proxy-check` and an already healthy HTTPS probe through Cloudflare.

```bash
iptables-restore --test < "$rules_file"
iptables-restore --noflush < "$rules_file"
```

Persist by systemd after Docker startup. Keep UFW host SSH policy independent. Provide `--audit` output containing only CIDRs/rule counts, never request data.

- [ ] **Step 5: Verify and commit firewall tooling**

Run: `bash -n deploy/scripts/sync-cloudflare-ranges.sh deploy/scripts/enforce-cloudflare-origin.sh && bash deploy/scripts/cloudflare-firewall.test.sh`

Expected: PASS.

```bash
git add deploy/scripts/sync-cloudflare-ranges.sh deploy/scripts/enforce-cloudflare-origin.sh deploy/scripts/cloudflare-firewall.test.sh deploy/systemd/im-hub-cloudflare-origin.service deploy/caddy/cloudflare-trusted-proxies.caddy docs/RUNBOOK.md
git commit -m "ops: restrict the origin to Cloudflare"
```

### Task 3: Verify host identity and establish the non-root deploy administrator

**Files:**
- Remote: `/home/imhub-deploy/.ssh/authorized_keys`
- Remote: `/etc/sudoers.d/imhub-deploy`
- Remote: `/etc/ssh/sshd_config.d/99-imhub-hardening.conf`

**Interfaces:**
- Produces: `imhub-deploy` key login and noninteractive sudo.
- Consumes: existing verified local key and current root recovery access.

- [ ] **Step 1: Re-run read-only identity and capacity checks**

Run locally:

```bash
ssh -i /Users/mac/.ssh/imhub_vultr -o IdentitiesOnly=yes -o BatchMode=yes \
  -o UserKnownHostsFile=/private/tmp/imhub-deploy-known-hosts -o StrictHostKeyChecking=yes \
  root@139.180.218.42 'id; . /etc/os-release; printf "%s %s\n" "$ID" "$VERSION_ID"; uname -m; nproc; free -h; df -h /'
```

Expected: root on Ubuntu 26.04 x86_64, 4 CPU, about 11 GiB RAM, and ample free root disk. Stop if host key verification or these facts differ.

- [ ] **Step 2: Create the deploy user without disabling root**

Run the reviewed commands over the root session: `adduser --disabled-password --gecos '' imhub-deploy`, create its `.ssh` directory mode 700, copy the already-installed public authorized key without printing it, set owner/mode 600, add the user to `sudo`, and install a mode-440 sudoers file containing only:

```text
imhub-deploy ALL=(ALL) NOPASSWD:ALL
```

Validate with `visudo -cf /etc/sudoers.d/imhub-deploy`.

- [ ] **Step 3: Verify a completely separate login and sudo path**

Run locally in a new SSH process:

```bash
ssh -i /Users/mac/.ssh/imhub_vultr -o IdentitiesOnly=yes -o BatchMode=yes \
  -o UserKnownHostsFile=/private/tmp/imhub-deploy-known-hosts -o StrictHostKeyChecking=yes \
  imhub-deploy@139.180.218.42 'id; sudo -n true; printf "deploy-login-ok\n"'
```

Expected: `deploy-login-ok` and exit 0. Do not continue if either login or sudo fails.

- [ ] **Step 4: Harden sshd only after the second-session proof**

Create:

```text
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
```

Run `sudo sshd -t`, reload (not stop) SSH, then open another new `imhub-deploy` session and run `sudo -n true`. Confirm a root SSH attempt is rejected while Vultr console recovery remains available.

- [ ] **Step 5: Record only non-sensitive verification facts**

Update the deployment checklist with date, OS, CPU/RAM/disk class, and “deploy login/root disabled: verified”. Do not record IP fingerprints, authorized-key contents, usernames from unrelated services, or secrets.

### Task 4: Provision Docker and stage the exact reviewed release

**Files:**
- Remote: `/opt/im-hub/releases/$RELEASE_SHA`, where the script validates `RELEASE_SHA` as 40 lowercase hex.
- Remote: `/opt/im-hub/current` symlink
- Remote: `/etc/systemd/system/im-hub-backup.*`
- Remote: `/etc/systemd/system/im-hub-cloudflare-origin.service`

**Interfaces:**
- Consumes: Tasks 1–2 scripts and a merged/reviewed 40-hex Git SHA.
- Produces: staged source and host runtime with no app started until secrets are entered.

- [ ] **Step 1: Run provisioner check, then apply**

Upload/checkout the exact reviewed repository commit under a SHA-named release directory. Run:

```bash
sudo bash deploy/scripts/provision-ubuntu.sh --check
sudo bash deploy/scripts/provision-ubuntu.sh --apply
docker version
docker compose version
```

Expected: check passes before mutation; Docker and Compose report versions; only 22 is required for SSH and 80/443 are ready for Caddy.

- [ ] **Step 2: Verify release identity and clean source**

Run: `git rev-parse HEAD`, `git status --porcelain`, and `git verify-commit HEAD` when the commit has a verifiable signature.

Expected: exact reviewed 40-hex SHA, empty status. If signature verification is unavailable, compare the SHA with the merged GitHub PR and record that comparison.

- [ ] **Step 3: Build the immutable app image without secrets**

Run `docker build -f deploy/Dockerfile.server -t "im-hub-server:$RELEASE_SHA" .` from the release directory before
`/etc/im-hub/*.env` exists.

Expected: build succeeds, demonstrating no secret is needed or copied at build time.

- [ ] **Step 4: Install systemd units but leave Cloudflare enforcement inactive**

Install the backup timer and Cloudflare-origin unit, run `systemd-analyze verify`, enable the backup timer only after its first manual smoke in Task 7. Do not enable the Cloudflare-only unit until Task 6.

- [ ] **Step 5: Verify no service/data port is public**

Run `ss -lntp` before app start.

Expected: SSH only; no host listener on 4000, 5432, or 6379.

### Task 5: Enter secrets, migrate, obtain TLS, and bootstrap the owner

**Files:**
- Remote: `/etc/im-hub/app.env`
- Remote: `/etc/im-hub/postgres.env`
- Remote: `/etc/im-hub/redis.env`
- Remote: Docker named volumes and Caddy certificate data.

**Interfaces:**
- Consumes: administrator-entered DeepL/Claude/OpenAI keys and Telegram production `API_ID/API_HASH`.
- Produces: fresh migrated DB, one forced-password-change owner, healthy DNS-only HTTPS origin.

- [ ] **Step 1: Confirm Cloudflare is temporarily DNS-only**

The administrator sets `imhub.jojo2333.net` to gray-cloud DNS-only and confirms its A record resolves directly to the production server. Do not put Cloudflare account credentials in the shell or repository.

- [ ] **Step 2: Have the administrator run the hidden secret initializer**

In the administrator's own interactive SSH terminal:

```bash
cd /opt/im-hub/current
sudo bash deploy/scripts/init-production-config.sh
```

Expected: prompts accept all three translation keys and Telegram values without echo; output lists file paths and configured names only. Codex does not capture, inspect, or validate the actual values.

- [ ] **Step 3: Start data services, migrate, and start the application**

Run the exact-SHA deployment script. It must start PostgreSQL/Redis, take the initial empty backup, run all migrations (ending at `0017_translation_provider_preferences`), start app/Caddy, and pass local `/health/live` and `/health/ready`.

Expected: no seed output, no demo users, no exposed 4000/5432/6379 host ports.

- [ ] **Step 4: Verify public TLS before enabling Cloudflare proxy**

Run a public `curl --fail --silent --show-error https://imhub.jojo2333.net/health/ready` from outside the server and inspect the certificate hostname/chain without printing headers containing credentials.

Expected: `{"status":"ready"}` and a publicly trusted certificate for the exact hostname.

- [ ] **Step 5: Bootstrap the first owner interactively**

In the administrator's own SSH terminal, run the app image's `bootstrap-owner` command without putting email/password in argv. Enter the previously confirmed owner email, display name, and the temporary password in its prompts.

Expected: exactly one owner created, no password/hash/token printed. A second invocation refuses because the users table is non-empty.

### Task 6: Enable Cloudflare proxy and lock the origin to Cloudflare

**Files:**
- Remote: Cloudflare DNS/SSL settings.
- Remote: `DOCKER-USER`/`IMHUB-CLOUDFLARE` firewall chain.

**Interfaces:**
- Consumes: working direct TLS from Task 5.
- Produces: proxied HTTPS/WSS with `Full (strict)` and no direct public Web origin path.

- [ ] **Step 1: Change Cloudflare settings manually**

Set the DNS record to proxied (orange cloud) and SSL/TLS encryption mode to `Full (strict)`. Do not enable Cloudflare Access browser challenges for this Electron API/WSS hostname.

- [ ] **Step 2: Verify proxied HTTP and WebSocket behavior before firewall mutation**

Confirm DNS now resolves to Cloudflare, HTTPS readiness remains 200, Caddy receives the request, and an installed desktop client can complete WebSocket auth-first-frame. Confirm the server sees distinct trusted client IPs in a temporary redacted diagnostic without logging full headers.

- [ ] **Step 3: Audit the future firewall rules**

Run:

```bash
sudo bash deploy/scripts/enforce-cloudflare-origin.sh --audit
```

Expected: all pinned Cloudflare IPv4/IPv6 ranges present, direct sources would be rejected on 80/443, and host SSH rules are untouched.

- [ ] **Step 4: Enforce and immediately retest through two paths**

Run `--enforce-after-proxy-check`. Verify proxied HTTPS/WSS still work. From a non-Cloudflare source, direct-IP HTTP/HTTPS with the hostname forced to the origin must fail; SSH via IP must remain available.

- [ ] **Step 5: Enable persistence and simulate a Docker restart**

Enable `im-hub-cloudflare-origin.service`, restart Docker during the controlled window, then re-run firewall audit and proxied health. Stop and restore the previously saved iptables rules if Cloudflare traffic fails.

### Task 7: Complete production authentication, translation, data, and platform smoke

**Files:**
- Remote: production runtime and root-only backup directory.
- Local: macOS/Windows internal artifacts built from the same release SHA.

**Interfaces:**
- Consumes: healthy locked origin and the first owner.
- Produces: signed-off release before employee/Telegram expansion.

- [ ] **Step 1: Validate owner first-login and session invalidation**

Log in with the temporary owner password, verify the app permits only initial password completion, set a new password, then confirm the temporary credential and old setup/session token no longer work. Do not capture either password.

- [ ] **Step 2: Validate RBAC and internal product surfaces**

Create synthetic employee accounts through owner UI and verify owner/manager/auditor/agent visibility, owner-only organization writes and keyword rules, self-account alerts, customer profile library, keyword hit, filters, detail, edit/save, and short excerpts. Remove synthetic records through normal owner UI after validation.

- [ ] **Step 3: Validate all translation paths**

Run non-sensitive synthetic text through DeepL, Claude, and OpenAI separately. Save a personal default and override a
single translation. Verify fallback and the actual-provider notice in the already-tested disposable runtime with a
stubbed failing provider; do not invalidate or rotate a live production credential merely to create a failure.

- [ ] **Step 4: Validate platform entry points at minimum scale**

Connect one Telegram account and verify status, basic non-sensitive receive/send, and controlled app-container restart reconnect. Validate Signal native and WhatsApp Web on employee devices, including fail-closed im-hub controls when service/grant is unavailable while the official page remains usable.

- [ ] **Step 5: Validate backup and recovery**

Run one manual backup and `restore-postgres-smoke.sh`; enable/start the systemd backup timer only after success. Confirm 7-daily/4-weekly retention policy, root-only permissions, and Vultr Automatic Backups still enabled. Do not inspect dump business contents.

- [ ] **Step 6: Build/verify both desktop platforms**

Set GitHub Environment `internal-test` variable `IM_HUB_SERVER_URL` to the exact HTTPS origin, build macOS and Windows `internal-unsigned` artifacts from the same SHA, verify manifests/hashes, then install and test each on its own OS. The value is an origin, never a credential.

### Task 8: Ramp Telegram 10 → 25 → 50 and close the rollout

**Files:**
- Modify: `docs/RUNBOOK.md`
- Create: `docs/deployments/2026-09-production-rollout.md`

**Interfaces:**
- Consumes: Task 7 signed-off release.
- Produces: non-sensitive capacity evidence and explicit stop/go decisions at 10, 25, and 50 accounts.

- [ ] **Step 1: Start the 10-account stage**

Onboard at most 10 Telegram adapter accounts. Record release SHA, start/end times, peak container/host memory percentage, restart/OOM counts, queue lag summary, and message-delay summary for at least 24 hours. Do not record account ids, names, contacts, or messages.

Collect aggregates with `docker stats --no-stream --format`, `docker inspect` limited to container
`State.OOMKilled`/restart status, `free`, `df`, the minimal health endpoints, and backup timer status. Filter journal output
to lifecycle/error codes and counts; do not export raw adapter or request logs into the rollout record.

- [ ] **Step 2: Apply the first stop/go gate**

Continue only if memory stays below 80%, OOM count is zero, app/TDLib containers do not repeatedly restart, and message delay is acceptable. Otherwise stop onboarding and open the Telegram worker-split design.

- [ ] **Step 3: Run the 25-account stage**

Increase to at most 25 accounts and collect the same non-sensitive evidence for at least 48 hours. Re-run backup success, HTTPS/WSS health, translation provider availability and one controlled container restart.

- [ ] **Step 4: Apply the second stop/go gate and run the 50-account stage**

Only after the 25-account gate passes, increase to at most 50 and observe for 7 days. Never register more than 50 server-side Telegram sessions under this design.

- [ ] **Step 5: Finalize the deployment record and commit documentation**

Record only version/SHA, dates, aggregate capacity metrics, backup result, macOS/Windows result, platform status, and unresolved non-sensitive risks. Explicitly note that off-host database object storage and external uptime/resource alerts remain future work.

```bash
git add docs/RUNBOOK.md docs/deployments/2026-09-production-rollout.md
git commit -m "docs: record the production rollout"
```
