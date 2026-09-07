#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
compose_file="$repo_root/deploy/compose.prod.yml"
config_root="${IMHUB_CONFIG_ROOT:-/etc/im-hub}"
state_root="${IMHUB_RELEASE_STATE_ROOT:-/var/lib/im-hub/releases}"
releases_root="${IMHUB_RELEASES_ROOT:-/opt/im-hub/releases}"
release_link="${IMHUB_RELEASE_LINK:-/opt/im-hub/current}"
state_file="$state_root/state"
backup_script="$repo_root/deploy/scripts/backup-postgres.sh"
test_mode=false
readiness_attempts=60
readiness_sleep_seconds=1
current_sha=''
previous_sha=''
activation_started=false
operation_committed=false
state_tmp=''
link_tmp_dir=''

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
  test "$releases_root" != '/opt/im-hub/releases' || fail 'test mode requires a disposable releases root'
  test "$release_link" != '/opt/im-hub/current' || fail 'test mode requires a disposable current link'
  backup_script="${IMHUB_BACKUP_SCRIPT:-$backup_script}"
  readiness_attempts="${IMHUB_RELEASE_READINESS_ATTEMPTS:-1}"
  readiness_sleep_seconds="${IMHUB_RELEASE_READINESS_SLEEP_SECONDS:-0}"
  [[ "$readiness_attempts" =~ ^[1-9][0-9]*$ ]] || fail 'test readiness attempts are invalid'
  [[ "$readiness_sleep_seconds" =~ ^[0-9]+$ ]] || fail 'test readiness delay is invalid'
else
  test "$config_root" = '/etc/im-hub' || fail 'production config root is fixed'
  test "$state_root" = '/var/lib/im-hub/releases' || fail 'production release state root is fixed'
  test "$releases_root" = '/opt/im-hub/releases' || fail 'production releases root is fixed'
  test "$release_link" = '/opt/im-hub/current' || fail 'production current link is fixed'
  test -z "${IMHUB_BACKUP_SCRIPT:-}" || fail 'production backup script cannot be overridden'
  test "$(id -u)" -eq 0 || fail 'run as root'
  test "$repo_root" = "$releases_root/$release_sha" || fail 'release checkout path does not match release SHA'
fi

cd "$repo_root"
git cat-file -e "${release_sha}^{commit}" 2>/dev/null || fail 'release commit is unavailable'
head_sha="$(git rev-parse HEAD)"
test "$head_sha" = "$release_sha" || fail 'checkout does not match release SHA'
test -z "$(git status --porcelain)" || fail 'release checkout is not clean'
test -x "$backup_script" || fail 'backup script is unavailable'
command -v flock >/dev/null 2>&1 || fail 'flock is unavailable'

umask 077
install -d -m 700 "$state_root"
install -d -m 755 "$(dirname "$release_link")"
if ! "$test_mode"; then
  chown root:root "$state_root" "$(dirname "$release_link")"
fi
exec 9> "$state_root/operation.lock"
flock -n 9 || fail 'another release operation is active'

read_state() {
  local current_line=''
  local previous_line=''

  test -f "$state_file" || return 0
  test "$(wc -l < "$state_file" | tr -d ' ')" = '2' || fail 'release state is invalid'
  IFS= read -r current_line < "$state_file" || true
  previous_line="$(sed -n '2p' "$state_file")"
  [[ "$current_line" =~ ^current=([0-9a-f]{40})$ ]] || fail 'recorded current release is invalid'
  current_sha="${BASH_REMATCH[1]}"
  [[ "$previous_line" =~ ^previous=([0-9a-f]{40})?$ ]] || fail 'recorded previous release is invalid'
  previous_sha="${BASH_REMATCH[1]:-}"
}

compose_with_image() {
  local image="$1"
  shift
  IMHUB_APP_IMAGE="$image" \
  IMHUB_APP_ENV_FILE="$config_root/app.env" \
  IMHUB_POSTGRES_ENV_FILE="$config_root/postgres.env" \
  IMHUB_REDIS_ENV_FILE="$config_root/redis.env" \
  docker compose -f "$compose_file" "$@"
}

wait_ready() {
  local image="$1"
  local attempt=0

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

atomic_link() {
  local target="$1"
  local parent=''
  parent="$(dirname "$release_link")"
  if test -e "$release_link" && ! test -L "$release_link"; then
    return 1
  fi
  link_tmp_dir="$(mktemp -d "$parent/.im-hub-current.XXXXXX")"
  ln -s "$target" "$link_tmp_dir/current" || return 1
  node -e "require('node:fs').renameSync(process.argv[1], process.argv[2])" \
    "$link_tmp_dir/current" "$release_link" || return 1
  rmdir "$link_tmp_dir" || return 1
  link_tmp_dir=''
}

write_state() {
  local new_current="$1"
  local new_previous="$2"
  state_tmp="$(mktemp "$state_root/.release-state.XXXXXX")"
  printf 'current=%s\nprevious=%s\n' "$new_current" "$new_previous" > "$state_tmp"
  chmod 600 "$state_tmp"
  if ! "$test_mode"; then
    chown root:root "$state_tmp"
  fi
  mv "$state_tmp" "$state_file"
  state_tmp=''
}

recover_current() {
  local current_image=''

  if test -z "$current_sha"; then
    compose_with_image "im-hub-server:$release_sha" stop caddy app >/dev/null 2>&1 || true
    if test -L "$release_link"; then
      rm -f "$release_link"
    fi
    printf 'failed first release stopped app and Caddy; release state was not created\n' >&2
    return 0
  fi

  current_image="im-hub-server:$current_sha"
  if ! compose_with_image "$current_image" up -d --no-deps --force-recreate app >/dev/null 2>&1 \
    || ! wait_ready "$current_image" \
    || ! compose_with_image "$current_image" up -d caddy >/dev/null 2>&1 \
    || ! atomic_link "$releases_root/$current_sha"; then
    printf 'failed release could not restore recorded current image\n' >&2
    return 1
  fi
  printf 'failed release restored recorded current image; release state unchanged\n' >&2
}

cleanup_link_tmp() {
  if test -n "$link_tmp_dir"; then
    rm -f "$link_tmp_dir/current"
    rmdir "$link_tmp_dir" 2>/dev/null || true
    link_tmp_dir=''
  fi
}

cleanup() {
  local status="$?"
  set +e
  test -z "$state_tmp" || rm -f "$state_tmp"
  cleanup_link_tmp
  if test "$status" -ne 0 && "$activation_started" && ! "$operation_committed"; then
    recover_current || true
  fi
  cleanup_link_tmp
  exit "$status"
}
trap cleanup EXIT

read_state
if test -n "$current_sha"; then
  current_image="im-hub-server:$current_sha"
  test -d "$releases_root/$current_sha" || fail 'recorded current release checkout is unavailable'
  test -L "$release_link" || fail 'current release link is unavailable'
  test "$(readlink "$release_link")" = "$releases_root/$current_sha" \
    || fail 'current release link does not match release state'
  docker image inspect "$current_image" >/dev/null 2>&1 || fail 'recorded current image is unavailable'
  app_container="$(compose_with_image "$current_image" ps -q app)"
  test -n "$app_container" || fail 'running application container is unavailable'
  running_image="$(docker inspect --format '{{.Config.Image}}' "$app_container" 2>/dev/null)"
  test "$running_image" = "$current_image" || fail 'running application image does not match release state'
elif test -e "$release_link" || test -L "$release_link"; then
  fail 'current release link exists without release state'
fi

release_image="im-hub-server:$release_sha"
docker build --platform linux/amd64 -f deploy/Dockerfile.server -t "$release_image" .
compose_with_image "$release_image" up -d --wait --wait-timeout 60 postgres redis
bash "$backup_script"
compose_with_image "$release_image" --profile tools run --rm migrate

activation_started=true
compose_with_image "$release_image" up -d app caddy
wait_ready "$release_image" || fail 'application readiness failed'
compose_with_image "$release_image" exec -T app pnpm --filter @im-hub/server preflight:production \
  || fail 'production preflight failed'
atomic_link "$repo_root" || fail 'current release link update failed'
write_state "$release_sha" "$current_sha"
operation_committed=true
activation_started=false
printf 'deployed release %s; readiness and production preflight passed\n' "$release_sha"
