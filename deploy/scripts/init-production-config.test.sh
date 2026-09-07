#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
initializer="$repo_root/deploy/scripts/init-production-config.sh"
rotator="$repo_root/deploy/scripts/rotate-production-secret.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

mode_of() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

write_input() {
  local target="$1"
  shift
  printf '%s\n' "$@" > "$target"
  chmod 600 "$target"
}

valid_input="$test_root/valid-input"
write_input "$valid_input" \
  'synthetic-deepl-secret' \
  'synthetic-anthropic-secret' \
  'synthetic-openai-secret' \
  '123456' \
  '0123456789abcdef0123456789abcdef'

config_root="$test_root/config"
init_log="$test_root/init.log"
IMHUB_CONFIG_ROOT="$config_root" IMHUB_TEST_INPUT_FILE="$valid_input" \
  bash "$initializer" --test-input > "$init_log" 2>&1

for file in app.env postgres.env redis.env; do
  test -f "$config_root/$file"
  test "$(mode_of "$config_root/$file")" = '600'
done

grep -qx 'APP_ENV=production' "$config_root/app.env"
grep -qx 'PUBLIC_ORIGIN=https://imhub.jojo2333.net' "$config_root/app.env"
grep -qx 'TRUSTED_PROXY_CIDRS=172.30.0.2/32' "$config_root/app.env"
grep -qx 'DEFAULT_TRANSLATION_PROVIDER=deepl' "$config_root/app.env"
grep -qx 'WHATSAPP_CLOUD_ENABLED=false' "$config_root/app.env"
grep -qx 'ORGANIZATION_ADMIN_WRITES_ENABLED=true' "$config_root/app.env"
grep -qx 'DEEPL_API_KEY=synthetic-deepl-secret' "$config_root/app.env"
grep -qx 'ANTHROPIC_API_KEY=synthetic-anthropic-secret' "$config_root/app.env"
grep -qx 'OPENAI_API_KEY=synthetic-openai-secret' "$config_root/app.env"
grep -qx 'TELEGRAM_API_ID=123456' "$config_root/app.env"
grep -qx 'TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef' "$config_root/app.env"

if grep -Eq 'synthetic-.*-secret|0123456789abcdef' "$init_log"; then
  echo 'initializer disclosed synthetic input' >&2
  exit 1
fi

before_hash="$(shasum -a 256 "$config_root/app.env" | awk '{print $1}')"
if IMHUB_CONFIG_ROOT="$config_root" IMHUB_TEST_INPUT_FILE="$valid_input" \
  bash "$initializer" --test-input > "$test_root/overwrite.log" 2>&1; then
  echo 'initializer overwrote existing config' >&2
  exit 1
fi
after_hash="$(shasum -a 256 "$config_root/app.env" | awk '{print $1}')"
test "$before_hash" = "$after_hash"

expect_invalid() {
  local name="$1"
  shift
  local input="$test_root/$name.input"
  local root="$test_root/$name.root"
  write_input "$input" "$@"
  if IMHUB_CONFIG_ROOT="$root" IMHUB_TEST_INPUT_FILE="$input" \
    bash "$initializer" --test-input > "$test_root/$name.log" 2>&1; then
    echo "initializer accepted invalid case: $name" >&2
    exit 1
  fi
  test ! -e "$root/app.env"
}

expect_invalid blank-provider \
  '' 'synthetic-anthropic-secret' 'synthetic-openai-secret' '123456' \
  '0123456789abcdef0123456789abcdef'
expect_invalid invalid-api-id \
  'synthetic-deepl-secret' 'synthetic-anthropic-secret' 'synthetic-openai-secret' '12x' \
  '0123456789abcdef0123456789abcdef'
expect_invalid invalid-api-hash \
  'synthetic-deepl-secret' 'synthetic-anthropic-secret' 'synthetic-openai-secret' '123456' 'not-a-hash'
expect_invalid control-character \
  $'synthetic-deepl\tsecret' 'synthetic-anthropic-secret' 'synthetic-openai-secret' '123456' \
  '0123456789abcdef0123456789abcdef'
expect_invalid extra-input \
  'synthetic-deepl-secret' 'synthetic-anthropic-secret' 'synthetic-openai-secret' '123456' \
  '0123456789abcdef0123456789abcdef' 'unexpected-extra-line'

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "%s\\n" "$*" >> "$IMHUB_DOCKER_TEST_LOG"' \
  'if [[ "$*" == *"compose -f "*" ps -q app"* ]]; then printf "%s\\n" app-container; fi' \
  'if [[ "$*" == "inspect --format {{.Config.Image}} app-container" ]]; then printf "%s\\n" "im-hub-server:0123456789abcdef0123456789abcdef01234567"; fi' \
  'if [[ "$*" == *"compose -f "*" exec -T app"* ]] && [[ "${IMHUB_DOCKER_SIGNAL_ON_READY:-false}" = true ]] && [[ ! -e "$IMHUB_DOCKER_SIGNAL_MARKER" ]]; then touch "$IMHUB_DOCKER_SIGNAL_MARKER"; kill -TERM "$PPID"; exit 1; fi' \
  'if [[ "$*" == *"compose -f "*" exec -T app"* ]] && [[ "${IMHUB_DOCKER_READY:-true}" != true ]]; then exit 1; fi' \
  'exit 0' > "$fake_bin/docker"
chmod 700 "$fake_bin/docker"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'test "${IMHUB_FLOCK_FAIL:-false}" != true' > "$fake_bin/flock"
chmod 700 "$fake_bin/flock"

state_root="$test_root/release-state"
mkdir -p "$state_root"
printf '%s\n%s\n' \
  'current=0123456789abcdef0123456789abcdef01234567' \
  'previous=' > "$state_root/state"

rotation_log="$test_root/rotation.log"
docker_log="$test_root/docker.log"
new_deepl="$test_root/new-deepl"
write_input "$new_deepl" 'synthetic-new-deepl-secret'
PATH="$fake_bin:$PATH" IMHUB_CONFIG_ROOT="$config_root" \
  IMHUB_RELEASE_STATE_ROOT="$state_root" \
  IMHUB_TEST_INPUT_FILE="$new_deepl" IMHUB_DOCKER_TEST_LOG="$docker_log" \
  bash "$rotator" DEEPL_API_KEY --test-input > "$rotation_log" 2>&1

grep -qx 'DEEPL_API_KEY=synthetic-new-deepl-secret' "$config_root/app.env"
if grep -q 'synthetic-new-deepl-secret' "$rotation_log" "$docker_log"; then
  echo 'rotation disclosed the replacement' >&2
  exit 1
fi

if PATH="$fake_bin:$PATH" IMHUB_CONFIG_ROOT="$config_root" \
  IMHUB_RELEASE_STATE_ROOT="$state_root" \
  IMHUB_TEST_INPUT_FILE="$new_deepl" IMHUB_DOCKER_TEST_LOG="$docker_log" \
  bash "$rotator" JWT_SECRET --test-input > "$test_root/disallowed.log" 2>&1; then
  echo 'rotation accepted a disallowed variable' >&2
  exit 1
fi

before_rollback_hash="$(shasum -a 256 "$config_root/app.env" | awk '{print $1}')"
new_openai="$test_root/new-openai"
write_input "$new_openai" 'synthetic-new-openai-secret'
if PATH="$fake_bin:$PATH" IMHUB_CONFIG_ROOT="$config_root" \
  IMHUB_RELEASE_STATE_ROOT="$state_root" \
  IMHUB_TEST_INPUT_FILE="$new_openai" IMHUB_DOCKER_TEST_LOG="$docker_log" \
  IMHUB_DOCKER_READY=false IMHUB_ROTATION_ATTEMPTS=1 IMHUB_ROTATION_SLEEP_SECONDS=0 \
  bash "$rotator" OPENAI_API_KEY --test-input \
  > "$test_root/rollback.log" 2>&1; then
  echo 'rotation ignored a failed readiness check' >&2
  exit 1
fi
after_rollback_hash="$(shasum -a 256 "$config_root/app.env" | awk '{print $1}')"
test "$before_rollback_hash" = "$after_rollback_hash"
grep -q 'previous config could not be restored and verified; immediate operator action required' \
  "$test_root/rollback.log"

before_signal_hash="$(shasum -a 256 "$config_root/app.env" | awk '{print $1}')"
signal_input="$test_root/signal-input"
signal_marker="$test_root/signal-marker"
signal_docker_log="$test_root/signal-docker.log"
write_input "$signal_input" 'synthetic-signal-deepl-secret'
if PATH="$fake_bin:$PATH" IMHUB_CONFIG_ROOT="$config_root" \
  IMHUB_RELEASE_STATE_ROOT="$state_root" IMHUB_DOCKER_SIGNAL_ON_READY=true \
  IMHUB_DOCKER_SIGNAL_MARKER="$signal_marker" IMHUB_TEST_INPUT_FILE="$signal_input" \
  IMHUB_DOCKER_TEST_LOG="$signal_docker_log" \
  bash "$rotator" DEEPL_API_KEY --test-input > "$test_root/signal.log" 2>&1; then
  echo 'rotation ignored a termination signal' >&2
  exit 1
fi
after_signal_hash="$(shasum -a 256 "$config_root/app.env" | awk '{print $1}')"
test "$before_signal_hash" = "$after_signal_hash"
test "$(grep -c 'force-recreate app' "$signal_docker_log")" -eq 2
if ! grep -q 'interrupted rotation restored and verified previous config' "$test_root/signal.log"; then
  sed -n '1,20p' "$test_root/signal.log" >&2
  echo 'rotation did not report verified interrupted recovery' >&2
  exit 1
fi

: > "$docker_log"
if PATH="$fake_bin:$PATH" IMHUB_CONFIG_ROOT="$config_root" \
  IMHUB_RELEASE_STATE_ROOT="$state_root" IMHUB_FLOCK_FAIL=true \
  IMHUB_TEST_INPUT_FILE="$new_deepl" IMHUB_DOCKER_TEST_LOG="$docker_log" \
  bash "$rotator" DEEPL_API_KEY --test-input > "$test_root/rotation-locked.log" 2>&1; then
  echo 'rotation ignored an active release lock' >&2
  exit 1
fi
if grep -q 'force-recreate app' "$docker_log"; then
  echo 'rotation restarted the application without the release lock' >&2
  exit 1
fi

if find "$config_root" -maxdepth 1 -name '*.rollback.*' -print -quit | grep -q .; then
  echo 'rotation left a rollback copy behind' >&2
  exit 1
fi

echo 'production config tests passed'
