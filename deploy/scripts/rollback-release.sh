#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
compose_file="$repo_root/deploy/compose.prod.yml"
config_root="${IMHUB_CONFIG_ROOT:-/etc/im-hub}"
state_root="${IMHUB_RELEASE_STATE_ROOT:-/var/lib/im-hub/releases}"
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

test "$#" -eq 1 || fail 'usage: rollback-release.sh PREVIOUS_RELEASE_SHA'
target_sha="$1"
[[ "$target_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'rollback SHA must be 40 lowercase hex'

if "$test_mode"; then
  test "$state_root" != '/var/lib/im-hub/releases' || fail 'test mode requires a disposable state root'
  readiness_attempts="${IMHUB_RELEASE_READINESS_ATTEMPTS:-1}"
  readiness_sleep_seconds="${IMHUB_RELEASE_READINESS_SLEEP_SECONDS:-0}"
  [[ "$readiness_attempts" =~ ^[1-9][0-9]*$ ]] || fail 'test readiness attempts are invalid'
  [[ "$readiness_sleep_seconds" =~ ^[0-9]+$ ]] || fail 'test readiness delay is invalid'
else
  test "$config_root" = '/etc/im-hub' || fail 'production config root is fixed'
  test "$state_root" = '/var/lib/im-hub/releases' || fail 'production release state root is fixed'
  test "$(id -u)" -eq 0 || fail 'run as root'
fi

test -f "$state_root/current" || fail 'current release state is unavailable'
test -f "$state_root/previous" || fail 'previous release state is unavailable'
IFS= read -r current_sha < "$state_root/current" || true
IFS= read -r previous_sha < "$state_root/previous" || true
[[ "$current_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'recorded current release is invalid'
[[ "$previous_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'recorded previous release is invalid'
test "$target_sha" = "$previous_sha" || fail 'rollback target is not the recorded previous release'

current_image="im-hub-server:$current_sha"
target_image="im-hub-server:$target_sha"
docker image inspect "$target_image" >/dev/null 2>&1 || fail 'recorded previous image is unavailable'

compose_with_image() {
  local image="$1"
  shift
  IMHUB_APP_IMAGE="$image" \
  IMHUB_APP_ENV_FILE="$config_root/app.env" \
  IMHUB_POSTGRES_ENV_FILE="$config_root/postgres.env" \
  IMHUB_REDIS_ENV_FILE="$config_root/redis.env" \
  docker compose -f "$compose_file" "$@"
}

restart_and_wait() {
  local image="$1"
  compose_with_image "$image" up -d --no-deps --force-recreate app >/dev/null 2>&1 || return 1
  for ((attempt = 0; attempt < readiness_attempts; attempt += 1)); do
    if compose_with_image "$image" exec -T app node -e \
      "fetch('http://127.0.0.1:4000/health/ready',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
      return 0
    fi
    if test "$readiness_sleep_seconds" -gt 0; then
      sleep "$readiness_sleep_seconds"
    fi
  done
  return 1
}

printf 'warning: rollback changes only the application image; database schema is not rolled back\n' >&2
if ! restart_and_wait "$target_image"; then
  restart_and_wait "$current_image" || true
  fail 'rollback image did not become ready; current image restart attempted'
fi

write_state() {
  local target="$1"
  local value="$2"
  local temporary=''
  temporary="$(mktemp "$state_root/.release-state.XXXXXX")"
  printf '%s\n' "$value" > "$temporary"
  chmod 600 "$temporary"
  if ! "$test_mode"; then
    chown root:root "$temporary"
  fi
  mv "$temporary" "$target"
}

write_state "$state_root/previous" "$current_sha"
write_state "$state_root/current" "$target_sha"
printf 'rolled back application image to %s; schema unchanged\n' "$target_sha"
