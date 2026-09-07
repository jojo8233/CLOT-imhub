#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
backup_script="$repo_root/deploy/scripts/backup-postgres.sh"
restore_script="$repo_root/deploy/scripts/restore-postgres-smoke.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

mode_of() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "%s\\n" "$*" >> "$IMHUB_DOCKER_TEST_LOG"' \
  'if [[ "$*" == *"pg_dump --format=custom"* ]]; then printf "%s\\n" "synthetic-dump-contents"; exit 0; fi' \
  'if [[ "$*" == *"pg_restore --list"* ]]; then cat >/dev/null; exit 0; fi' \
  'if [[ "$*" == *"pg_restore --exit-on-error"* ]]; then cat >/dev/null; [[ "${IMHUB_DOCKER_RESTORE_FAIL:-false}" != true ]]; exit; fi' \
  'if [[ "$*" == *"psql "* ]]; then printf "17\\n0\\n0\\n"; exit 0; fi' \
  'exit 0' > "$fake_bin/docker"
chmod 700 "$fake_bin/docker"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'if test "${IMHUB_CP_FAIL:-false}" = true; then printf partial > "$2"; exit 1; fi' \
  'exec /bin/cp "$@"' > "$fake_bin/cp"
chmod 700 "$fake_bin/cp"

backup_root="$test_root/backups"
daily="$backup_root/daily"
weekly="$backup_root/weekly"
mkdir -p "$daily" "$weekly"

for day in 01 02 03 04 05 06 07 08 09; do
  touch -t "202609${day}0000" "$daily/imhub-202609${day}T000000Z.dump"
done
for week in 01 02 03 04 05 06; do
  touch -t "2026${week}010000" "$weekly/imhub-2026${week}01T000000Z.dump"
done
touch "$daily/manual.dump"

docker_log="$test_root/docker.log"
backup_log="$test_root/backup.log"
PATH="$fake_bin:$PATH" IMHUB_BACKUP_ROOT="$backup_root" IMHUB_BACKUP_TEST_MODE=1 \
  IMHUB_BACKUP_FORCE_WEEKLY=1 IMHUB_DOCKER_TEST_LOG="$docker_log" \
  bash "$backup_script" > "$backup_log" 2>&1

test "$(find "$daily" -type f -name 'imhub-*.dump' | wc -l | tr -d ' ')" = '7'
test "$(find "$weekly" -type f -name 'imhub-*.dump' | wc -l | tr -d ' ')" = '4'
test -f "$daily/manual.dump"

latest_dump="$(awk '/^created / { print $2; exit }' "$backup_log")"
test -n "$latest_dump"
mode="$(mode_of "$latest_dump")"
test "$mode" = '600'

if grep -q 'synthetic-dump-contents' "$backup_log" "$docker_log"; then
  echo 'backup disclosed dump contents' >&2
  exit 1
fi

failed_backup_root="$test_root/failed-backups"
if PATH="$fake_bin:$PATH" IMHUB_BACKUP_ROOT="$failed_backup_root" IMHUB_BACKUP_TEST_MODE=1 \
  IMHUB_BACKUP_FORCE_WEEKLY=1 IMHUB_CP_FAIL=true IMHUB_DOCKER_TEST_LOG="$docker_log" \
  bash "$backup_script" > "$test_root/failed-weekly.log" 2>&1; then
  echo 'backup accepted a failed weekly copy' >&2
  exit 1
fi
if find "$failed_backup_root/weekly" -type f -print -quit | grep -q .; then
  echo 'backup left a partial weekly artifact' >&2
  exit 1
fi

restore_log="$test_root/restore.log"
PATH="$fake_bin:$PATH" IMHUB_BACKUP_ROOT="$backup_root" IMHUB_BACKUP_TEST_MODE=1 \
  IMHUB_DOCKER_TEST_LOG="$docker_log" bash "$restore_script" "$latest_dump" \
  > "$restore_log" 2>&1

grep -q 'createdb.*imhub_restore_smoke' "$docker_log"
grep -q 'dropdb.*imhub_restore_smoke' "$docker_log"
if grep -q 'synthetic-dump-contents' "$restore_log" "$docker_log"; then
  echo 'restore disclosed dump contents' >&2
  exit 1
fi

if PATH="$fake_bin:$PATH" IMHUB_BACKUP_ROOT="$backup_root" IMHUB_BACKUP_TEST_MODE=1 \
  IMHUB_RESTORE_DATABASE=another_database IMHUB_DOCKER_TEST_LOG="$docker_log" \
  bash "$restore_script" "$latest_dump" > "$test_root/invalid-db.log" 2>&1; then
  echo 'restore accepted a non-smoke database name' >&2
  exit 1
fi

failure_docker_log="$test_root/failure-docker.log"
if PATH="$fake_bin:$PATH" IMHUB_BACKUP_ROOT="$backup_root" IMHUB_BACKUP_TEST_MODE=1 \
  IMHUB_DOCKER_RESTORE_FAIL=true IMHUB_DOCKER_TEST_LOG="$failure_docker_log" \
  bash "$restore_script" "$latest_dump" > "$test_root/failed-restore.log" 2>&1; then
  echo 'restore ignored a pg_restore failure' >&2
  exit 1
fi
grep -q 'createdb.*imhub_restore_smoke' "$failure_docker_log"
grep -q 'dropdb.*imhub_restore_smoke' "$failure_docker_log"

echo 'backup and restore tests passed'
