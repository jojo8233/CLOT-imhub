#!/usr/bin/env bash
set -euo pipefail

test_mode=false
if test "${IMHUB_BACKUP_TEST_MODE:-}" = '1'; then
  test_mode=true
fi

backup_root="${IMHUB_BACKUP_ROOT:-/var/backups/im-hub}"
config_root="${IMHUB_CONFIG_ROOT:-/etc/im-hub}"
compose_file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)/compose.prod.yml"
restore_database='imhub_restore_smoke'
created=false

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

compose() {
  IMHUB_APP_ENV_FILE="$config_root/app.env" \
  IMHUB_POSTGRES_ENV_FILE="$config_root/postgres.env" \
  IMHUB_REDIS_ENV_FILE="$config_root/redis.env" \
  docker compose -f "$compose_file" "$@"
}

cleanup() {
  if "$created"; then
    compose exec -T postgres sh -eu -c \
      'exec dropdb --if-exists --username "$POSTGRES_USER" imhub_restore_smoke' \
      >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

test "$#" -eq 1 || fail 'usage: restore-postgres-smoke.sh BACKUP_FILE'
if test -n "${IMHUB_RESTORE_DATABASE:-}" && test "$IMHUB_RESTORE_DATABASE" != "$restore_database"; then
  fail 'restore database is fixed to imhub_restore_smoke'
fi
if "$test_mode"; then
  test "$backup_root" != '/var/backups/im-hub' || fail 'test mode requires a disposable backup root'
else
  test "$backup_root" = '/var/backups/im-hub' || fail 'production backup root is fixed'
  test "$config_root" = '/etc/im-hub' || fail 'production config root is fixed'
  test "$(id -u)" -eq 0 || fail 'run as root'
fi

test -f "$1" || fail 'backup file is unavailable'
backup_root_real="$(cd "$backup_root" && pwd -P)"
dump_dir="$(cd "$(dirname "$1")" && pwd -P)"
dump_name="$(basename "$1")"
[[ "$dump_name" =~ ^imhub-[0-9]{8}T[0-9]{6}Z\.dump$ ]] || fail 'backup filename is invalid'
case "$dump_dir" in
  "$backup_root_real/daily"|"$backup_root_real/weekly") ;;
  *) fail 'backup file is outside the managed backup directories' ;;
esac
dump_file="$dump_dir/$dump_name"

if ! compose exec -T postgres sh -eu -c \
  'exec createdb --username "$POSTGRES_USER" imhub_restore_smoke'; then
  fail 'restore smoke database already exists or cannot be created'
fi
created=true

if ! compose exec -T postgres pg_restore \
  --exit-on-error --no-owner --no-privileges --dbname="$restore_database" \
  < "$dump_file" >/dev/null; then
  fail 'restore smoke failed'
fi

verification="$(compose exec -T postgres sh -eu -c \
  'exec psql --username "$POSTGRES_USER" --dbname imhub_restore_smoke --tuples-only --no-align --set ON_ERROR_STOP=1 --command "select count(*) from kysely_migration; select count(*) from users; select count(*) from accounts;"')" \
  || fail 'restore verification query failed'

verified_lines=0
while IFS= read -r count; do
  test -z "$count" && continue
  [[ "$count" =~ ^[0-9]+$ ]] || fail 'restore verification returned an invalid count'
  verified_lines=$((verified_lines + 1))
done <<< "$verification"
test "$verified_lines" -eq 3 || fail 'restore verification returned incomplete counts'

printf 'restore smoke passed; schema and table counts verified\n'
