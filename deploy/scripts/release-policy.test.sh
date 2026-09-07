#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
deploy_script="$repo_root/deploy/scripts/deploy-release.sh"
rollback_script="$repo_root/deploy/scripts/rollback-release.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

release_sha='1234567890abcdef1234567890abcdef12345678'
previous_sha='abcdef1234567890abcdef1234567890abcdef12'
unrecorded_sha='9999999999999999999999999999999999999999'
state_root="$test_root/state"
call_log="$test_root/calls.log"

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "git %s\\n" "$*" >> "$IMHUB_RELEASE_CALL_LOG"' \
  'if [[ "$1 $2" == "rev-parse HEAD" ]]; then printf "%s\\n" "$IMHUB_TEST_HEAD"; exit 0; fi' \
  'if [[ "$1 $2" == "status --porcelain" ]]; then [[ "${IMHUB_TEST_DIRTY:-false}" != true ]] || printf "%s\\n" " M synthetic"; exit 0; fi' \
  'exit 0' > "$fake_bin/git"
chmod 700 "$fake_bin/git"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "docker %s\\n" "$*" >> "$IMHUB_RELEASE_CALL_LOG"' \
  'if [[ "$*" == *"exec -T app node -e"* ]] && [[ "${IMHUB_APP_IMAGE:-}" == "${IMHUB_DOCKER_FAIL_IMAGE:-never}" ]]; then exit 1; fi' \
  'exit 0' > "$fake_bin/docker"
chmod 700 "$fake_bin/docker"

fake_backup="$test_root/backup"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "%s\\n" backup >> "$IMHUB_RELEASE_CALL_LOG"' \
  'exit 0' > "$fake_backup"
chmod 700 "$fake_backup"

if PATH="$fake_bin:$PATH" IMHUB_RELEASE_TEST_MODE=1 IMHUB_RELEASE_STATE_ROOT="$state_root" \
  IMHUB_RELEASE_CALL_LOG="$call_log" IMHUB_TEST_HEAD="$release_sha" \
  IMHUB_BACKUP_SCRIPT="$fake_backup" bash "$deploy_script" main \
  > "$test_root/invalid-deploy.log" 2>&1; then
  echo 'deploy accepted a branch name' >&2
  exit 1
fi

PATH="$fake_bin:$PATH" IMHUB_RELEASE_TEST_MODE=1 IMHUB_RELEASE_STATE_ROOT="$state_root" \
  IMHUB_RELEASE_CALL_LOG="$call_log" IMHUB_TEST_HEAD="$release_sha" \
  IMHUB_BACKUP_SCRIPT="$fake_backup" IMHUB_RELEASE_READINESS_ATTEMPTS=1 \
  IMHUB_RELEASE_READINESS_SLEEP_SECONDS=0 bash "$deploy_script" "$release_sha" \
  > "$test_root/deploy.log" 2>&1

test "$(tr -d '\n' < "$state_root/current")" = "$release_sha"
test ! -s "$state_root/previous"

line_number() {
  grep -n "$1" "$call_log" | head -n 1 | cut -d: -f1
}

build_line="$(line_number 'docker build --platform linux/amd64')"
data_line="$(line_number 'docker compose .* up -d --wait --wait-timeout 60 postgres redis')"
backup_line="$(line_number '^backup$')"
migrate_line="$(line_number 'docker compose .* --profile tools run --rm migrate')"
app_line="$(line_number 'docker compose .* up -d app caddy')"
ready_line="$(line_number 'docker compose .* exec -T app node -e')"
preflight_line="$(line_number 'docker compose .* exec -T app pnpm --filter @im-hub/server preflight:production')"

test "$build_line" -lt "$data_line"
test "$data_line" -lt "$backup_line"
test "$backup_line" -lt "$migrate_line"
test "$migrate_line" -lt "$app_line"
test "$app_line" -lt "$ready_line"
test "$ready_line" -lt "$preflight_line"

if grep -Eq 'down -v|volume prune|system prune|migrate.*down' "$call_log"; then
  echo 'deploy issued a destructive command' >&2
  exit 1
fi

if PATH="$fake_bin:$PATH" IMHUB_RELEASE_TEST_MODE=1 IMHUB_RELEASE_STATE_ROOT="$state_root" \
  IMHUB_RELEASE_CALL_LOG="$call_log" IMHUB_TEST_HEAD="$release_sha" IMHUB_TEST_DIRTY=true \
  IMHUB_BACKUP_SCRIPT="$fake_backup" bash "$deploy_script" "$release_sha" \
  > "$test_root/dirty.log" 2>&1; then
  echo 'deploy accepted a dirty checkout' >&2
  exit 1
fi

printf '%s\n' "$release_sha" > "$state_root/current"
printf '%s\n' "$previous_sha" > "$state_root/previous"
PATH="$fake_bin:$PATH" IMHUB_RELEASE_TEST_MODE=1 IMHUB_RELEASE_STATE_ROOT="$state_root" \
  IMHUB_RELEASE_CALL_LOG="$call_log" IMHUB_TEST_HEAD="$release_sha" \
  IMHUB_RELEASE_READINESS_ATTEMPTS=1 IMHUB_RELEASE_READINESS_SLEEP_SECONDS=0 \
  bash "$rollback_script" "$previous_sha" > "$test_root/rollback.log" 2>&1

test "$(tr -d '\n' < "$state_root/current")" = "$previous_sha"
test "$(tr -d '\n' < "$state_root/previous")" = "$release_sha"

if PATH="$fake_bin:$PATH" IMHUB_RELEASE_TEST_MODE=1 IMHUB_RELEASE_STATE_ROOT="$state_root" \
  IMHUB_RELEASE_CALL_LOG="$call_log" IMHUB_TEST_HEAD="$release_sha" \
  bash "$rollback_script" latest > "$test_root/invalid-rollback.log" 2>&1; then
  echo 'rollback accepted a symbolic target' >&2
  exit 1
fi

if PATH="$fake_bin:$PATH" IMHUB_RELEASE_TEST_MODE=1 IMHUB_RELEASE_STATE_ROOT="$state_root" \
  IMHUB_RELEASE_CALL_LOG="$call_log" IMHUB_TEST_HEAD="$release_sha" \
  bash "$rollback_script" "$unrecorded_sha" > "$test_root/unrecorded.log" 2>&1; then
  echo 'rollback accepted an unrecorded target' >&2
  exit 1
fi

printf '%s\n' "$release_sha" > "$state_root/current"
printf '%s\n' "$previous_sha" > "$state_root/previous"
if PATH="$fake_bin:$PATH" IMHUB_RELEASE_TEST_MODE=1 IMHUB_RELEASE_STATE_ROOT="$state_root" \
  IMHUB_RELEASE_CALL_LOG="$call_log" IMHUB_TEST_HEAD="$release_sha" \
  IMHUB_DOCKER_FAIL_IMAGE="im-hub-server:$previous_sha" \
  IMHUB_RELEASE_READINESS_ATTEMPTS=1 IMHUB_RELEASE_READINESS_SLEEP_SECONDS=0 \
  bash "$rollback_script" "$previous_sha" > "$test_root/rollback-failure.log" 2>&1; then
  echo 'rollback ignored failed readiness' >&2
  exit 1
fi
test "$(tr -d '\n' < "$state_root/current")" = "$release_sha"
test "$(tr -d '\n' < "$state_root/previous")" = "$previous_sha"

if grep -Eq 'down -v|volume prune|system prune|migrate.*down' "$call_log"; then
  echo 'rollback issued a destructive command' >&2
  exit 1
fi

echo 'release policy tests passed'
