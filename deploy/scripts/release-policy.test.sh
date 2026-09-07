#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
deploy_script="$repo_root/deploy/scripts/deploy-release.sh"
rollback_script="$repo_root/deploy/scripts/rollback-release.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

release_sha='1234567890abcdef1234567890abcdef12345678'
previous_sha='abcdef1234567890abcdef1234567890abcdef12'
older_sha='1111111111111111111111111111111111111111'
unrecorded_sha='9999999999999999999999999999999999999999'
state_root="$test_root/state"
releases_root="$test_root/releases"
release_link="$test_root/current"
call_log="$test_root/calls.log"
running_image_file="$test_root/running-image"
mkdir -p "$releases_root/$release_sha" "$releases_root/$previous_sha" "$releases_root/$older_sha"

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
  'printf "image=%s docker %s\\n" "${IMHUB_APP_IMAGE:-none}" "$*" >> "$IMHUB_RELEASE_CALL_LOG"' \
  'if [[ "$*" == *"exec -T app node -e"* ]] && [[ "${IMHUB_APP_IMAGE:-}" == "${IMHUB_DOCKER_FAIL_IMAGE:-never}" ]]; then exit 1; fi' \
  'if [[ "$*" == *"preflight:production"* ]] && [[ "${IMHUB_APP_IMAGE:-}" == "${IMHUB_DOCKER_FAIL_PREFLIGHT_IMAGE:-never}" ]]; then exit 1; fi' \
  'if [[ "$*" == *" ps -q app"* ]]; then printf "%s\\n" synthetic-app-container; exit 0; fi' \
  'if [[ "$1 $2" == "inspect --format" ]]; then cat "$IMHUB_TEST_RUNNING_IMAGE_FILE"; exit 0; fi' \
  'exit 0' > "$fake_bin/docker"
chmod 700 "$fake_bin/docker"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "flock %s\\n" "$*" >> "$IMHUB_RELEASE_CALL_LOG"' \
  'test "${IMHUB_FLOCK_FAIL:-false}" != true' > "$fake_bin/flock"
chmod 700 "$fake_bin/flock"

fake_backup="$test_root/backup"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "%s\\n" backup >> "$IMHUB_RELEASE_CALL_LOG"' \
  'exit 0' > "$fake_backup"
chmod 700 "$fake_backup"

release_env=(
  PATH="$fake_bin:$PATH"
  IMHUB_RELEASE_TEST_MODE=1
  IMHUB_RELEASE_STATE_ROOT="$state_root"
  IMHUB_RELEASES_ROOT="$releases_root"
  IMHUB_RELEASE_LINK="$release_link"
  IMHUB_RELEASE_CALL_LOG="$call_log"
  IMHUB_TEST_RUNNING_IMAGE_FILE="$running_image_file"
  IMHUB_TEST_HEAD="$release_sha"
  IMHUB_BACKUP_SCRIPT="$fake_backup"
  IMHUB_RELEASE_READINESS_ATTEMPTS=1
  IMHUB_RELEASE_READINESS_SLEEP_SECONDS=0
)

if env "${release_env[@]}" bash "$deploy_script" main > "$test_root/invalid-deploy.log" 2>&1; then
  echo 'deploy accepted a branch name' >&2
  exit 1
fi

env "${release_env[@]}" bash "$deploy_script" "$release_sha" > "$test_root/deploy.log" 2>&1

test "$(sed -n 's/^current=//p' "$state_root/state")" = "$release_sha"
test -z "$(sed -n 's/^previous=//p' "$state_root/state")"
test "$(readlink "$release_link")" = "$repo_root"

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

if env "${release_env[@]}" IMHUB_TEST_DIRTY=true bash "$deploy_script" "$release_sha" \
  > "$test_root/dirty.log" 2>&1; then
  echo 'deploy accepted a dirty checkout' >&2
  exit 1
fi

printf 'current=%s\nprevious=%s\n' "$release_sha" "$previous_sha" > "$state_root/state"
printf 'im-hub-server:%s\n' "$release_sha" > "$running_image_file"
ln -sfn "$releases_root/$release_sha" "$release_link"
env "${release_env[@]}" bash "$rollback_script" "$previous_sha" > "$test_root/rollback.log" 2>&1

test "$(sed -n 's/^current=//p' "$state_root/state")" = "$previous_sha"
test "$(sed -n 's/^previous=//p' "$state_root/state")" = "$release_sha"
test "$(readlink "$release_link")" = "$releases_root/$previous_sha"

if env "${release_env[@]}" bash "$rollback_script" latest > "$test_root/invalid-rollback.log" 2>&1; then
  echo 'rollback accepted a symbolic target' >&2
  exit 1
fi

if env "${release_env[@]}" bash "$rollback_script" "$unrecorded_sha" > "$test_root/unrecorded.log" 2>&1; then
  echo 'rollback accepted an unrecorded target' >&2
  exit 1
fi

printf 'current=%s\nprevious=%s\n' "$release_sha" "$previous_sha" > "$state_root/state"
printf 'im-hub-server:%s\n' "$release_sha" > "$running_image_file"
ln -sfn "$releases_root/$release_sha" "$release_link"
if env "${release_env[@]}" IMHUB_DOCKER_FAIL_IMAGE="im-hub-server:$previous_sha" \
  bash "$rollback_script" "$previous_sha" > "$test_root/rollback-failure.log" 2>&1; then
  echo 'rollback ignored failed readiness' >&2
  exit 1
fi
test "$(sed -n 's/^current=//p' "$state_root/state")" = "$release_sha"
test "$(sed -n 's/^previous=//p' "$state_root/state")" = "$previous_sha"
test "$(readlink "$release_link")" = "$releases_root/$release_sha"

assert_failed_deploy_restores_current() {
  local failure_variable="$1"
  local failure_log="$2"

  printf 'current=%s\nprevious=%s\n' "$previous_sha" "$older_sha" > "$state_root/state"
  printf 'im-hub-server:%s\n' "$previous_sha" > "$running_image_file"
  ln -sfn "$releases_root/$previous_sha" "$release_link"
  : > "$call_log"
  if env "${release_env[@]}" "$failure_variable=im-hub-server:$release_sha" \
    bash "$deploy_script" "$release_sha" > "$failure_log" 2>&1; then
    echo 'deploy ignored an activation failure' >&2
    exit 1
  fi
  test "$(sed -n 's/^current=//p' "$state_root/state")" = "$previous_sha"
  test "$(sed -n 's/^previous=//p' "$state_root/state")" = "$older_sha"
  test "$(readlink "$release_link")" = "$releases_root/$previous_sha"
  grep -q "image=im-hub-server:$release_sha docker compose .* up -d app caddy" "$call_log"
  grep -q "image=im-hub-server:$previous_sha docker compose .* --force-recreate app" "$call_log"
}

assert_failed_deploy_restores_current IMHUB_DOCKER_FAIL_IMAGE "$test_root/deploy-readiness-failure.log"
assert_failed_deploy_restores_current IMHUB_DOCKER_FAIL_PREFLIGHT_IMAGE "$test_root/deploy-preflight-failure.log"

rm -f "$state_root/state" "$release_link"
: > "$call_log"
if env "${release_env[@]}" IMHUB_DOCKER_FAIL_IMAGE="im-hub-server:$release_sha" \
  bash "$deploy_script" "$release_sha" > "$test_root/first-deploy-failure.log" 2>&1; then
  echo 'first deploy ignored failed readiness' >&2
  exit 1
fi
test ! -e "$state_root/state"
test ! -e "$release_link"
grep -q 'docker compose .* stop caddy app' "$call_log"

: > "$call_log"
if env "${release_env[@]}" IMHUB_FLOCK_FAIL=true bash "$deploy_script" "$release_sha" \
  > "$test_root/locked.log" 2>&1; then
  echo 'deploy ignored an active release lock' >&2
  exit 1
fi
if grep -q 'docker build' "$call_log"; then
  echo 'deploy built an image without the release lock' >&2
  exit 1
fi

if grep -Eq 'down -v|volume prune|system prune|migrate.*down' "$call_log"; then
  echo 'release scripts issued a destructive command' >&2
  exit 1
fi

grep -q 'ConditionPathExists=/opt/im-hub/current/deploy/compose.prod.yml' \
  "$repo_root/deploy/systemd/im-hub-backup.service"

echo 'release policy tests passed'
