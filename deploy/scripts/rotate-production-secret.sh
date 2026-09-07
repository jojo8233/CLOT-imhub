#!/usr/bin/env bash
set -euo pipefail
exec 7>&2

config_root="${IMHUB_CONFIG_ROOT:-/etc/im-hub}"
state_root="${IMHUB_RELEASE_STATE_ROOT:-/var/lib/im-hub/releases}"
compose_file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)/compose.prod.yml"
state_file="$state_root/state"
variable="${1:-}"
test_input=false
lock_dir=''
tmp_file=''
backup_file=''
replacement=''
rollback_required=false
activation_started=false
operation_committed=false
readiness_attempts=60
readiness_sleep_seconds=1

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

restore_previous_config() {
  local restart_required=false

  test -n "$backup_file" && test -f "$backup_file" || return 1
  if "$activation_started"; then
    restart_required=true
  fi
  mv -f "$backup_file" "$config_root/app.env" || return 1
  backup_file=''
  rollback_required=false

  if "$restart_required"; then
    if restart_and_wait; then
      activation_started=false
    else
      return 1
    fi
  fi
}

cleanup() {
  local status="$?"
  set +e
  trap '' HUP INT QUIT TERM
  test -z "$tmp_file" || rm -f "$tmp_file"
  if "$rollback_required" && ! "$operation_committed"; then
    if restore_previous_config; then
      printf 'interrupted rotation restored and verified previous config for %s\n' "$variable" >&7
    else
      printf 'interrupted rotation could not restore and verify previous config for %s; immediate operator action required\n' \
        "$variable" >&7
    fi
  fi
  if ! "$rollback_required"; then
    test -z "$backup_file" || rm -f "$backup_file"
  fi
  test -z "$lock_dir" || rmdir "$lock_dir" 2>/dev/null || true
  unset replacement
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

case "$#" in
  1) ;;
  2)
    test "$2" = '--test-input' || fail 'usage: rotate-production-secret.sh VARIABLE [--test-input]'
    test_input=true
    ;;
  *) fail 'usage: rotate-production-secret.sh VARIABLE [--test-input]' ;;
esac

case "$variable" in
  DEEPL_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|TELEGRAM_API_ID|TELEGRAM_API_HASH) ;;
  *) fail 'variable is not allowed for rotation' ;;
esac

if "$test_input"; then
  test "$config_root" != '/etc/im-hub' || fail 'test input cannot target /etc/im-hub'
  test "$state_root" != '/var/lib/im-hub/releases' || fail 'test input requires a disposable release state root'
  test -n "${IMHUB_TEST_INPUT_FILE:-}" || fail 'test input file is required'
  test -f "$IMHUB_TEST_INPUT_FILE" || fail 'test input file is unavailable'
  readiness_attempts="${IMHUB_ROTATION_ATTEMPTS:-1}"
  readiness_sleep_seconds="${IMHUB_ROTATION_SLEEP_SECONDS:-0}"
  [[ "$readiness_attempts" =~ ^[1-9][0-9]*$ ]] || fail 'test readiness attempts are invalid'
  [[ "$readiness_sleep_seconds" =~ ^[0-9]+$ ]] || fail 'test readiness delay is invalid'
else
  test "$config_root" = '/etc/im-hub' || fail 'production config root must be /etc/im-hub'
  test "$state_root" = '/var/lib/im-hub/releases' || fail 'production release state root is fixed'
  test "$(id -u)" -eq 0 || fail 'run as root'
  test -t 0 || fail 'interactive terminal required'
fi

test -f "$config_root/app.env" || fail 'application config is unavailable'

compose() {
  IMHUB_APP_ENV_FILE="$config_root/app.env" \
  IMHUB_POSTGRES_ENV_FILE="$config_root/postgres.env" \
  IMHUB_REDIS_ENV_FILE="$config_root/redis.env" \
  docker compose -f "$compose_file" "$@"
}

if "$test_input"; then
  exec 3< "$IMHUB_TEST_INPUT_FILE"
  IFS= read -r replacement <&3 || fail 'invalid test input'
  extra=''
  if IFS= read -r extra <&3 || test -n "$extra"; then
    fail 'invalid test input'
  fi
  exec 3<&-
else
  IFS= read -r -s -p "New value for $variable: " replacement
  printf '\n' >&2
fi

valid_secret_token() {
  test -n "$1" && [[ "$1" =~ ^[A-Za-z0-9._:+/=-]+$ ]]
}

case "$variable" in
  TELEGRAM_API_ID)
    [[ "$replacement" =~ ^[1-9][0-9]{0,9}$ ]] || fail 'replacement is invalid'
    (( 10#$replacement <= 2147483647 )) || fail 'replacement is invalid'
    ;;
  TELEGRAM_API_HASH)
    [[ "$replacement" =~ ^[A-Fa-f0-9]{32}$ ]] || fail 'replacement is invalid'
    ;;
  *) valid_secret_token "$replacement" || fail 'replacement is invalid' ;;
esac

command -v flock >/dev/null 2>&1 || fail 'flock is unavailable'
test -d "$state_root" || fail 'release state is unavailable'
exec 9> "$state_root/operation.lock"
flock -n 9 || fail 'another release operation is active'

test -f "$state_file" || fail 'release state is unavailable'
test "$(wc -l < "$state_file" | tr -d ' ')" = '2' || fail 'release state is invalid'
IFS= read -r current_line < "$state_file" || true
previous_line="$(sed -n '2p' "$state_file")"
[[ "$current_line" =~ ^current=([0-9a-f]{40})$ ]] || fail 'recorded current release is invalid'
current_image="im-hub-server:${BASH_REMATCH[1]}"
[[ "$previous_line" =~ ^previous=([0-9a-f]{40})?$ ]] || fail 'recorded previous release is invalid'

app_container="$(compose ps -q app 2>/dev/null)"
test -n "$app_container" || fail 'application container is not running'
running_image="$(docker inspect --format '{{.Config.Image}}' "$app_container" 2>/dev/null)"
test "$running_image" = "$current_image" || fail 'running application image does not match release state'

umask 077
lock_dir="$config_root/.rotate.lock"
mkdir "$lock_dir" || fail 'secret rotation is already running'
tmp_file="$(mktemp "$config_root/.app.env.XXXXXX")"
backup_file="$config_root/app.env.rollback.$$"
cp -p "$config_root/app.env" "$backup_file"
chmod 600 "$backup_file"
rollback_required=true

found=0
while IFS= read -r line || test -n "$line"; do
  key="${line%%=*}"
  if test "$key" = "$variable"; then
    found=$((found + 1))
    printf '%s=%s\n' "$variable" "$replacement" >> "$tmp_file"
  else
    printf '%s\n' "$line" >> "$tmp_file"
  fi
done < "$config_root/app.env"

test "$found" -eq 1 || fail 'variable is missing or duplicated in application config'
chmod 600 "$tmp_file"
if ! "$test_input"; then
  chown root:root "$tmp_file" "$backup_file"
fi
mv "$tmp_file" "$config_root/app.env"
tmp_file=''

restart_and_wait() {
  activation_started=true
  IMHUB_APP_IMAGE="$current_image" compose up -d --no-deps --force-recreate app >/dev/null 2>&1 || return 1
  for ((attempt = 0; attempt < readiness_attempts; attempt += 1)); do
    if IMHUB_APP_IMAGE="$current_image" compose exec -T app node -e \
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

if ! restart_and_wait; then
  if restore_previous_config; then
    fail "rotation failed for $variable; previous config restored and verified"
  fi
  fail "rotation failed for $variable; previous config could not be restored and verified; immediate operator action required"
fi

trap '' HUP INT QUIT TERM
rm -f "$backup_file"
backup_file=''
rollback_required=false
operation_committed=true
install_signal_traps
activation_started=false
printf 'rotated %s and verified readiness\n' "$variable"
