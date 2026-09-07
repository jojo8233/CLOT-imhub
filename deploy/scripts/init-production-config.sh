#!/usr/bin/env bash
set -euo pipefail

config_root="${IMHUB_CONFIG_ROOT:-/etc/im-hub}"
test_input=false
lock_dir=''
tmp_app=''
tmp_postgres=''
tmp_redis=''
deepl_key=''
anthropic_key=''
openai_key=''
telegram_api_id=''
telegram_api_hash=''
db_password=''
redis_password=''
jwt_secret=''

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

cleanup() {
  test -z "$tmp_app" || rm -f "$tmp_app"
  test -z "$tmp_postgres" || rm -f "$tmp_postgres"
  test -z "$tmp_redis" || rm -f "$tmp_redis"
  test -z "$lock_dir" || rmdir "$lock_dir" 2>/dev/null || true
  unset deepl_key anthropic_key openai_key telegram_api_id telegram_api_hash
  unset db_password redis_password jwt_secret
}
trap cleanup EXIT

case "$#" in
  0) ;;
  1)
    test "$1" = '--test-input' || fail 'usage: init-production-config.sh [--test-input]'
    test_input=true
    ;;
  *) fail 'usage: init-production-config.sh [--test-input]' ;;
esac

if "$test_input"; then
  test "$config_root" != '/etc/im-hub' || fail 'test input cannot target /etc/im-hub'
  test -n "${IMHUB_TEST_INPUT_FILE:-}" || fail 'test input file is required'
  test -f "$IMHUB_TEST_INPUT_FILE" || fail 'test input file is unavailable'
else
  test "$config_root" = '/etc/im-hub' || fail 'production config root must be /etc/im-hub'
  test "$(id -u)" -eq 0 || fail 'run as root'
  test -t 0 || fail 'interactive terminal required'
fi

umask 077
install -d -m 700 "$config_root"
lock_dir="$config_root/.init.lock"
mkdir "$lock_dir" || fail 'production config initialization is already running'

for name in app.env postgres.env redis.env; do
  test ! -e "$config_root/$name" || fail 'production config already exists; refusing to overwrite'
done

read_hidden() {
  local prompt="$1"
  local variable="$2"
  local value=''
  IFS= read -r -s -p "$prompt: " value
  printf '\n' >&2
  printf -v "$variable" '%s' "$value"
}

if "$test_input"; then
  exec 3< "$IMHUB_TEST_INPUT_FILE"
  IFS= read -r deepl_key <&3 || fail 'invalid test input'
  IFS= read -r anthropic_key <&3 || fail 'invalid test input'
  IFS= read -r openai_key <&3 || fail 'invalid test input'
  IFS= read -r telegram_api_id <&3 || fail 'invalid test input'
  IFS= read -r telegram_api_hash <&3 || fail 'invalid test input'
  extra=''
  if IFS= read -r extra <&3 || test -n "$extra"; then
    fail 'invalid test input'
  fi
  exec 3<&-
else
  read_hidden 'DeepL API key' deepl_key
  read_hidden 'Claude API key' anthropic_key
  read_hidden 'OpenAI API key' openai_key
  read_hidden 'Telegram API ID' telegram_api_id
  read_hidden 'Telegram API hash' telegram_api_hash
fi

valid_secret_token() {
  test -n "$1" && [[ "$1" =~ ^[A-Za-z0-9._:+/=-]+$ ]]
}

valid_secret_token "$deepl_key" || fail 'DEEPL_API_KEY is invalid'
valid_secret_token "$anthropic_key" || fail 'ANTHROPIC_API_KEY is invalid'
valid_secret_token "$openai_key" || fail 'OPENAI_API_KEY is invalid'
[[ "$telegram_api_id" =~ ^[1-9][0-9]{0,9}$ ]] || fail 'TELEGRAM_API_ID is invalid'
(( 10#$telegram_api_id <= 2147483647 )) || fail 'TELEGRAM_API_ID is invalid'
[[ "$telegram_api_hash" =~ ^[A-Fa-f0-9]{32}$ ]] || fail 'TELEGRAM_API_HASH is invalid'

db_password="$(openssl rand -hex 32)"
redis_password="$(openssl rand -hex 32)"
jwt_secret="$(openssl rand -base64 48 | tr -d '\n')"

tmp_app="$(mktemp "$config_root/.app.env.XXXXXX")"
tmp_postgres="$(mktemp "$config_root/.postgres.env.XXXXXX")"
tmp_redis="$(mktemp "$config_root/.redis.env.XXXXXX")"

{
  printf 'APP_ENV=production\n'
  printf 'PUBLIC_ORIGIN=https://imhub.jojo2333.net\n'
  printf 'TRUSTED_PROXY_CIDRS=172.30.0.2/32\n'
  printf 'DATABASE_URL=postgres://imhub:%s@postgres:5432/imhub\n' "$db_password"
  printf 'REDIS_URL=redis://:%s@redis:6379\n' "$redis_password"
  printf 'JWT_SECRET=%s\n' "$jwt_secret"
  printf 'DEEPL_API_KEY=%s\n' "$deepl_key"
  printf 'DEEPL_ENDPOINT=https://api-free.deepl.com/v2/translate\n'
  printf 'ANTHROPIC_API_KEY=%s\n' "$anthropic_key"
  printf 'OPENAI_API_KEY=%s\n' "$openai_key"
  printf 'DEFAULT_TRANSLATION_PROVIDER=deepl\n'
  printf 'TDLIB_DATA_DIR=/var/lib/im-hub/tdlib\n'
  printf 'SIGNAL_CLI_BINARY=signal-cli\n'
  printf 'SIGNAL_DATA_DIR=/var/lib/im-hub/signal\n'
  printf 'TELEGRAM_API_ID=%s\n' "$telegram_api_id"
  printf 'TELEGRAM_API_HASH=%s\n' "$telegram_api_hash"
  printf 'TELEGRAM_TDLIB_SHADOW_ACCOUNT_IDS=\n'
  printf 'WHATSAPP_CLOUD_ENABLED=false\n'
  printf 'ORGANIZATION_ADMIN_WRITES_ENABLED=true\n'
  printf 'PORT=4000\n'
} > "$tmp_app"

{
  printf 'POSTGRES_USER=imhub\n'
  printf 'POSTGRES_PASSWORD=%s\n' "$db_password"
  printf 'POSTGRES_DB=imhub\n'
} > "$tmp_postgres"

printf 'REDIS_PASSWORD=%s\n' "$redis_password" > "$tmp_redis"

chmod 600 "$tmp_app" "$tmp_postgres" "$tmp_redis"
if ! "$test_input"; then
  chown root:root "$tmp_app" "$tmp_postgres" "$tmp_redis"
fi

mv "$tmp_app" "$config_root/app.env"
tmp_app=''
mv "$tmp_postgres" "$config_root/postgres.env"
tmp_postgres=''
mv "$tmp_redis" "$config_root/redis.env"
tmp_redis=''

printf 'created %s\n' "$config_root/app.env"
printf 'created %s\n' "$config_root/postgres.env"
printf 'created %s\n' "$config_root/redis.env"
printf 'configured DEEPL_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY TELEGRAM_API_ID TELEGRAM_API_HASH\n'

