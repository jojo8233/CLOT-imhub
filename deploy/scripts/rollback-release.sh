#!/usr/bin/env bash
set -euo pipefail
exec 7>&2

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
compose_file="$repo_root/deploy/compose.prod.yml"
config_root="${IMHUB_CONFIG_ROOT:-/etc/im-hub}"
state_root="${IMHUB_RELEASE_STATE_ROOT:-/var/lib/im-hub/releases}"
releases_root="${IMHUB_RELEASES_ROOT:-/opt/im-hub/releases}"
release_link="${IMHUB_RELEASE_LINK:-/opt/im-hub/current}"
state_file="$state_root/state"
test_mode=false
readiness_attempts=60
readiness_sleep_seconds=1
current_sha=''
previous_sha=''
rollback_started=false
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

test "$#" -eq 1 || fail 'usage: rollback-release.sh PREVIOUS_RELEASE_SHA'
target_sha="$1"
[[ "$target_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'rollback SHA must be 40 lowercase hex'

if "$test_mode"; then
  test "$state_root" != '/var/lib/im-hub/releases' || fail 'test mode requires a disposable state root'
  test "$releases_root" != '/opt/im-hub/releases' || fail 'test mode requires a disposable releases root'
  test "$release_link" != '/opt/im-hub/current' || fail 'test mode requires a disposable current link'
  readiness_attempts="${IMHUB_RELEASE_READINESS_ATTEMPTS:-1}"
  readiness_sleep_seconds="${IMHUB_RELEASE_READINESS_SLEEP_SECONDS:-0}"
  [[ "$readiness_attempts" =~ ^[1-9][0-9]*$ ]] || fail 'test readiness attempts are invalid'
  [[ "$readiness_sleep_seconds" =~ ^[0-9]+$ ]] || fail 'test readiness delay is invalid'
else
  test "$config_root" = '/etc/im-hub' || fail 'production config root is fixed'
  test "$state_root" = '/var/lib/im-hub/releases' || fail 'production release state root is fixed'
  test "$releases_root" = '/opt/im-hub/releases' || fail 'production releases root is fixed'
  test "$release_link" = '/opt/im-hub/current' || fail 'production current link is fixed'
  test "$(id -u)" -eq 0 || fail 'run as root'
fi

command -v flock >/dev/null 2>&1 || fail 'flock is unavailable'
test -d "$state_root" || fail 'release state is unavailable'
exec 9> "$state_root/operation.lock"
flock -n 9 || fail 'another release operation is active'

read_state() {
  local current_line=''
  local previous_line=''

  test -f "$state_file" || fail 'release state is unavailable'
  test "$(wc -l < "$state_file" | tr -d ' ')" = '2' || fail 'release state is invalid'
  IFS= read -r current_line < "$state_file" || true
  previous_line="$(sed -n '2p' "$state_file")"
  [[ "$current_line" =~ ^current=([0-9a-f]{40})$ ]] || fail 'recorded current release is invalid'
  current_sha="${BASH_REMATCH[1]}"
  [[ "$previous_line" =~ ^previous=([0-9a-f]{40})$ ]] || fail 'recorded previous release is invalid'
  previous_sha="${BASH_REMATCH[1]}"
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

assert_running_image() {
  local expected_image="$1"
  local app_container=''
  local running_image=''

  app_container="$(compose_with_image "$expected_image" ps -q app)"
  test -n "$app_container" || return 1
  running_image="$(docker inspect --format '{{.Config.Image}}' "$app_container" 2>/dev/null)"
  test "$running_image" = "$expected_image"
}

restart_and_wait() {
  local image="$1"
  compose_with_image "$image" up -d --no-deps --force-recreate app >/dev/null 2>&1 || return 1
  wait_ready "$image"
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
  if ! mv -Tf "$link_tmp_dir/current" "$release_link" 2>/dev/null; then
    mv -fh "$link_tmp_dir/current" "$release_link" || return 1
  fi
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
  local current_image="im-hub-server:$current_sha"
  restart_and_wait "$current_image" \
    && compose_with_image "$current_image" up -d caddy >/dev/null 2>&1 \
    && atomic_link "$releases_root/$current_sha"
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
  trap '' HUP INT QUIT TERM
  test -z "$state_tmp" || rm -f "$state_tmp"
  cleanup_link_tmp
  if test "$status" -ne 0 && "$rollback_started" && ! "$operation_committed"; then
    if recover_current; then
      printf 'failed rollback restored recorded current image; release state unchanged\n' >&7
    else
      printf 'failed rollback could not restore recorded current image\n' >&7
    fi
  fi
  cleanup_link_tmp
  exit "$status"
}
trap cleanup EXIT

install_signal_traps() {
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 131' QUIT
  trap 'exit 143' TERM
}
install_signal_traps

read_state
test "$target_sha" = "$previous_sha" || fail 'rollback target is not the recorded previous release'
test -d "$releases_root/$current_sha" || fail 'recorded current release checkout is unavailable'
test -d "$releases_root/$target_sha" || fail 'recorded previous release checkout is unavailable'
test -L "$release_link" || fail 'current release link is unavailable'
test "$(readlink "$release_link")" = "$releases_root/$current_sha" \
  || fail 'current release link does not match release state'

current_image="im-hub-server:$current_sha"
target_image="im-hub-server:$target_sha"
docker image inspect "$current_image" >/dev/null 2>&1 || fail 'recorded current image is unavailable'
docker image inspect "$target_image" >/dev/null 2>&1 || fail 'recorded previous image is unavailable'
assert_running_image "$current_image" || fail 'running application image does not match release state'

printf 'warning: rollback changes only the application image; database schema is not rolled back\n' >&2
rollback_started=true
restart_and_wait "$target_image" || fail 'rollback image did not become ready'
assert_running_image "$target_image" || fail 'activated application image does not match rollback target'
trap '' HUP INT QUIT TERM
atomic_link "$releases_root/$target_sha" || fail 'current release link update failed'
write_state "$target_sha" "$current_sha"
operation_committed=true
install_signal_traps
rollback_started=false
printf 'rolled back application image to %s; schema unchanged\n' "$target_sha"
