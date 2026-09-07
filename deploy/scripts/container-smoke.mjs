import { execFileSync } from 'node:child_process'

function option(name) {
  const index = process.argv.indexOf(name)
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error(`missing ${name}`)
  }
  return process.argv[index + 1]
}

const image = option('--image')
const healthUrl = option('--health-url')
const docker = process.env.DOCKER_COMMAND ?? 'docker'

const configuredUser = execFileSync(
  docker,
  ['image', 'inspect', '--format', '{{.Config.User}}', image],
  { encoding: 'utf8' },
).trim()
const architecture = execFileSync(
  docker,
  ['image', 'inspect', '--format', '{{.Architecture}}', image],
  { encoding: 'utf8' },
).trim()

if (!configuredUser || /^(?:0|root)(?::|$)/.test(configuredUser)) {
  throw new Error('image runtime user must be non-root')
}

execFileSync(docker, [
  'run',
  '--platform',
  `linux/${architecture}`,
  '--rm',
  '--entrypoint',
  'node',
  image,
  '-e',
  [
    "const { existsSync } = require('node:fs')",
    "if (typeof process.getuid !== 'function' || process.getuid() === 0) process.exit(20)",
    "if (existsSync('/app/.env') || existsSync('/app/data')) process.exit(21)",
  ].join(';'),
], { stdio: 'inherit' })

execFileSync(docker, [
  'run',
  '--platform',
  `linux/${architecture}`,
  '--rm',
  '--network',
  'none',
  image,
  'pnpm',
  '--version',
], { stdio: 'ignore' })

let lastError
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const response = await fetch(healthUrl)
    if (response.status !== 200) throw new Error(`health status ${response.status}`)
    const body = await response.json()
    if (body.status !== 'live') throw new Error('unexpected health body')
    process.stdout.write('container smoke passed\n')
    process.exit(0)
  } catch (error) {
    lastError = error
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
}

throw lastError
