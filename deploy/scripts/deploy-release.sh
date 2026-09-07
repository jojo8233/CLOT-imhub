#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
compose_file="$repo_root/deploy/compose.prod.yml"
config_root="${IMHUB_CONFIG_ROOT:-/etc/im-hub}"
state_root="${IMHUB_RELEASE_STATE_ROOT:-/var/lib/im-hub/releases}"
backup_script="$repo_root/deploy/scripts/backup-postgres.sh"
test_mode=false
readiness_attempts=60
readiness_sleep_seconds=1

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

if test "${IMHUB_RELEASE_TEST_MODE:-}" = '1'; then
  test_mode=true
fi

test "$#" -eq 1 || fail 'usage: deploy-release.sh RELEASE_SHA'
release_sha="$1"
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'release SHA must be 40 lowercase hex'

if "$test_mode"; then
  test "$state_root" != '/var/lib/im-hub/releases' || fail 'test mode requires a disposable state root'
  backup_script="${IMHUB_BACKUP_SCRIPT:-$backup_script}"
  readiness_attempts="${IMHUB_RELEASE_READINESS_ATTEMPTS:-1}"
  readiness_sleep_seconds="${IMHUB_RELEASE_READINESS_SLEEP_SECONDS:-0}"
  [[ "$readiness_attempts" =~ ^[1-9][0-9]*$ ]] || fail 'test readiness attempts are invalid'
  [[ "$readiness_sleep_seconds" =~ ^[0-9]+$ ]] || fail 'test readiness delay is invalid'
else
  test "$config_root" = '/etc/im-hub' || fail 'production config root is fixed'
  test "$state_root" = '/var/lib/im-hub/releases' || fail 'production release state root is fixed'
  test -z "${IMHUB_BACKUP_SCRIPT:-}" || fail 'production backup script cannot be overridden'
  test "$(id -u)" -eq 0 || fail 'run as root'
fi

cd "$repo_root"
git cat-file -e "${release_sha}^{commit}" 2>/dev/null || fail 'release commit is unavailable'
head_sha="$(git rev-parse HEAD)"
test "$head_sha" = "$release_sha" || fail 'checkout does not match release SHA'
test -z "$(git status --porcelain)" || fail 'release checkout is not clean'
test -x "$backup_script" || fail 'backup script is unavailable'

umask 077
install -d -m 700 "$state_root"
if ! "$test_mode"; then
  chown root:root "$state_root"
fi

current_sha=''
if test -f "$state_root/current"; then
  IFS= read -r current_sha < "$state_root/current" || true
  [[ "$current_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'recorded current release is invalid'
fi

release_image="im-hub-server:$release_sha"

compose() {
  IMHUB_APP_IMAGE="$release_image" \
  IMHUB_APP_ENV_FILE="$config_root/app.env" \
  IMHUB_POSTGRES_ENV_FILE="$config_root/postgres.env" \
  IMHUB_REDIS_ENV_FILE="$config_root/redis.env" \
  docker compose -f "$compose_file" "$@"
}

docker build --platform linux/amd64 -f deploy/Dockerfile.server -t "$release_image" .
compose up -d --wait --wait-timeout 60 postgres redis
bash "$backup_script"
compose --profile tools run --rm migrate
compose up -d app caddy

ready=false
for ((attempt = 0; attempt < readiness_attempts; attempt += 1)); do
  if compose exec -T app node -e \
    "fetch('http://127.0.0.1:4000/health/ready',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1; then
    ready=true
    break
  fi
  if test "$readiness_sleep_seconds" -gt 0; then
    sleep "$readiness_sleep_seconds"
  fi
done
"$ready" || fail 'application readiness failed'

compose exec -T app pnpm --filter @im-hub/server preflight:production

write_state() {
  local target="$1"
  local value="$2"
  local temporary=''
  temporary="$(mktemp "$state_root/.release-state.XXXXXX")"
  if test -n "$value"; then
    printf '%s\n' "$value" > "$temporary"
  fi
  chmod 600 "$temporary"
  if ! "$test_mode"; then
    chown root:root "$temporary"
  fi
  mv "$temporary" "$target"
}

write_state "$state_root/previous" "$current_sha"
write_state "$state_root/current" "$release_sha"
printf 'deployed release %s; readiness and production preflight passed\n' "$release_sha"

