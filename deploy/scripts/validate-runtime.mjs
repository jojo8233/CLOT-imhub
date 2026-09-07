import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
  })
  if (result.status !== 0) throw new Error(`${label} failed`)
  return result.stdout
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

if (process.argv.length !== 3 || process.argv[2] !== '--examples') {
  process.stderr.write('usage: node deploy/scripts/validate-runtime.mjs --examples\n')
  process.exit(2)
}

run('docker', [
  'compose',
  '-f',
  'deploy/compose.prod.yml',
  '--env-file',
  'deploy/env/compose.env.example',
  '--profile',
  'tools',
  'config',
  '--quiet',
], 'compose validation')

const rendered = run('docker', [
  'compose',
  '-f',
  'deploy/compose.prod.yml',
  '--env-file',
  'deploy/env/compose.env.example',
  '--profile',
  'tools',
  'config',
  '--format',
  'json',
], 'compose policy rendering')
const runtime = object(JSON.parse(rendered), 'runtime')
const services = object(runtime.services, 'services')
const app = object(services.app, 'app')
const migrate = object(services.migrate, 'migrate')
const bootstrapOwner = object(services['bootstrap-owner'], 'bootstrap-owner')
const caddy = object(services.caddy, 'caddy')
const postgres = object(services.postgres, 'postgres')
const redis = object(services.redis, 'redis')

assert(Array.isArray(caddy.ports) && caddy.ports.length === 2, 'only Caddy ports are allowed')
assert(app.ports === undefined && postgres.ports === undefined && redis.ports === undefined,
  'application and data ports must remain private')
assert(bootstrapOwner.ports === undefined, 'owner bootstrap must remain private')

for (const [name, service] of Object.entries({ app, migrate, bootstrapOwner, caddy, postgres, redis })) {
  assert(service.platform === 'linux/amd64', `${name} platform is not pinned`)
}
assert(JSON.stringify(bootstrapOwner.command).includes('bootstrap-owner'),
  'owner bootstrap command is missing')
assert(bootstrapOwner.stdin_open === true && bootstrapOwner.tty === true,
  'owner bootstrap must require an interactive terminal')
assert(JSON.stringify(Object.keys(object(migrate.networks, 'migrate networks'))) === '["data"]',
  'migration service must remain on the data network')
assert(JSON.stringify(Object.keys(object(bootstrapOwner.networks, 'bootstrap-owner networks'))) === '["data"]',
  'owner bootstrap must remain on the data network')

const volumes = Object.keys(object(runtime.volumes, 'volumes'))
for (const volume of [
  'postgres_data',
  'redis_data',
  'tdlib_data',
  'signal_data',
  'caddy_data',
  'caddy_config',
  'caddy_logs',
]) {
  assert(volumes.includes(volume), `required volume ${volume} is missing`)
}

const appEnvironment = object(app.environment, 'app environment')
assert(appEnvironment.PUBLIC_ORIGIN === 'https://imhub.jojo2333.net', 'production origin is not fixed')
assert(appEnvironment.TRUSTED_PROXY_CIDRS === '172.30.0.2/32', 'proxy trust is not single-host')
assert(appEnvironment.WHATSAPP_CLOUD_ENABLED === 'false', 'WhatsApp Cloud must remain disabled')
assert(appEnvironment.DEFAULT_TRANSLATION_PROVIDER === 'deepl', 'DeepL must remain the company default')

const command = JSON.stringify(redis.command)
assert(command.includes('--appendonly yes'), 'Redis AOF must be enabled')
assert(command.includes('--requirepass'), 'Redis authentication must be enabled')
assert(!rendered.includes('imhub_dev') && !rendered.includes('change-me-in-production'),
  'development placeholder detected')

const caddyfile = resolve('deploy/Caddyfile')
const trustedProxies = resolve('deploy/caddy/cloudflare-trusted-proxies.caddy')
run('docker', [
  'run',
  '--rm',
  '--volume',
  `${caddyfile}:/etc/caddy/Caddyfile:ro`,
  '--volume',
  `${trustedProxies}:/etc/caddy/cloudflare-trusted-proxies.caddy:ro`,
  'caddy:2',
  'caddy',
  'validate',
  '--config',
  '/etc/caddy/Caddyfile',
  '--adapter',
  'caddyfile',
], 'Caddy validation')

process.stdout.write('production runtime examples valid\n')
