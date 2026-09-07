#!/usr/bin/env bash
set -euo pipefail

config_root="${IMHUB_CONFIG_ROOT:-/etc/im-hub}"
compose_file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)/compose.prod.yml"
variable="${1:-}"
test_input=false
lock_dir=''
tmp_file=''
backup_file=''
replacement=''
rollback_required=false
readiness_attempts=60
readiness_sleep_seconds=1

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

cleanup() {
  test -z "$tmp_file" || rm -f "$tmp_file"
  if "$rollback_required" && test -n "$backup_file" && test -f "$backup_file"; then
    mv -f "$backup_file" "$config_root/app.env"
  fi
  test -z "$backup_file" || rm -f "$backup_file"
  test -z "$lock_dir" || rmdir "$lock_dir" 2>/dev/null || true
  unset replacement
}
trap cleanup EXIT

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
  test -n "${IMHUB_TEST_INPUT_FILE:-}" || fail 'test input file is required'
  test -f "$IMHUB_TEST_INPUT_FILE" || fail 'test input file is unavailable'
  readiness_attempts="${IMHUB_ROTATION_ATTEMPTS:-1}"
  readiness_sleep_seconds="${IMHUB_ROTATION_SLEEP_SECONDS:-0}"
  [[ "$readiness_attempts" =~ ^[1-9][0-9]*$ ]] || fail 'test readiness attempts are invalid'
  [[ "$readiness_sleep_seconds" =~ ^[0-9]+$ ]] || fail 'test readiness delay is invalid'
else
  test "$config_root" = '/etc/im-hub' || fail 'production config root must be /etc/im-hub'
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

app_container="$(compose ps -q app 2>/dev/null)"
test -n "$app_container" || fail 'application container is not running'
current_image="$(docker inspect --format '{{.Config.Image}}' "$app_container" 2>/dev/null)"
test -n "$current_image" || fail 'application image cannot be determined'

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
  mv -f "$backup_file" "$config_root/app.env"
  backup_file=''
  rollback_required=false
  restart_and_wait || true
  fail "rotation failed for $variable; previous config restored"
fi

rm -f "$backup_file"
backup_file=''
rollback_required=false
printf 'rotated %s and verified readiness\n' "$variable"
