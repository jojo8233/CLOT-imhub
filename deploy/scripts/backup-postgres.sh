#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

test_mode=false
if test "${IMHUB_BACKUP_TEST_MODE:-}" = '1'; then
  test_mode=true
fi

backup_root="${IMHUB_BACKUP_ROOT:-/var/backups/im-hub}"
config_root="${IMHUB_CONFIG_ROOT:-/etc/im-hub}"
compose_file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)/compose.prod.yml"
daily_dir="$backup_root/daily"
weekly_dir="$backup_root/weekly"
tmp_file=''

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

cleanup() {
  test -z "$tmp_file" || rm -f "$tmp_file"
}
trap cleanup EXIT

test "$#" -eq 0 || fail 'backup-postgres.sh does not accept arguments'
if "$test_mode"; then
  test "$backup_root" != '/var/backups/im-hub' || fail 'test mode requires a disposable backup root'
else
  test "$backup_root" = '/var/backups/im-hub' || fail 'production backup root is fixed'
  test "$config_root" = '/etc/im-hub' || fail 'production config root is fixed'
  test "$(id -u)" -eq 0 || fail 'run as root'
fi

umask 077
install -d -m 700 "$daily_dir" "$weekly_dir"

compose() {
  IMHUB_APP_ENV_FILE="$config_root/app.env" \
  IMHUB_POSTGRES_ENV_FILE="$config_root/postgres.env" \
  IMHUB_REDIS_ENV_FILE="$config_root/redis.env" \
  docker compose -f "$compose_file" "$@"
}

timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
final_file="$daily_dir/imhub-$timestamp.dump"
test ! -e "$final_file" || fail 'backup timestamp already exists'
tmp_file="$(mktemp "$daily_dir/.imhub-$timestamp.XXXXXX")"
chmod 600 "$tmp_file"

if ! compose exec -T postgres sh -eu -c \
  'exec pg_dump --format=custom --no-owner --no-privileges --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"' \
  > "$tmp_file"; then
  fail 'PostgreSQL backup failed'
fi

test -s "$tmp_file" || fail 'PostgreSQL backup is empty'
if ! compose exec -T postgres pg_restore --list < "$tmp_file" >/dev/null; then
  fail 'PostgreSQL backup validation failed'
fi

mv "$tmp_file" "$final_file"
tmp_file=''
chmod 600 "$final_file"

weekly=false
if test "$(date -u '+%u')" = '7'; then
  weekly=true
fi
if "$test_mode" && test "${IMHUB_BACKUP_FORCE_WEEKLY:-}" = '1'; then
  weekly=true
fi

weekly_file=''
if "$weekly"; then
  weekly_file="$weekly_dir/imhub-$timestamp.dump"
  test ! -e "$weekly_file" || fail 'weekly backup timestamp already exists'
  cp "$final_file" "$weekly_file"
  chmod 600 "$weekly_file"
fi

prune_backups() {
  local directory="$1"
  local keep="$2"
  local files=()
  local file=''
  local name=''
  local excess=0
  local index=0

  shopt -s nullglob
  for file in "$directory"/imhub-*.dump; do
    name="${file##*/}"
    if [[ "$name" =~ ^imhub-[0-9]{8}T[0-9]{6}Z\.dump$ ]]; then
      files+=("$file")
    fi
  done
  shopt -u nullglob

  excess=$((${#files[@]} - keep))
  if test "$excess" -le 0; then
    return
  fi
  while test "$index" -lt "$excess"; do
    rm -f -- "${files[$index]}"
    index=$((index + 1))
  done
}

prune_backups "$daily_dir" 7
prune_backups "$weekly_dir" 4

printf 'created %s\n' "$final_file"
if test -n "$weekly_file"; then
  printf 'created %s\n' "$weekly_file"
fi

