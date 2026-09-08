import { execFileSync } from 'node:child_process'
import { setDefaultResultOrder } from 'node:dns'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

setDefaultResultOrder('ipv4first')

export const REQUIRED_DESKTOP_ARTIFACT_FILES = [
  'out/main/index.js',
  'out/preload/index.mjs',
  'out/renderer/index.html',
]

const TEST_ONLY_FLAG = /IM_HUB_(?:TEST|CI|SMOKE)(?:_|\b)/

function exactHttpsOrigin(value) {
  const parsed = new URL(value)
  const exact = value === parsed.origin || value === `${parsed.origin}/`
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !exact) {
    throw new Error('artifact smoke requires an exact HTTPS server origin')
  }
  return parsed.origin
}

export function validateDesktopArtifact(files, serverOrigin) {
  const origin = exactHttpsOrigin(serverOrigin)
  for (const required of REQUIRED_DESKTOP_ARTIFACT_FILES) {
    if (typeof files[required] !== 'string') {
      throw new Error(`desktop artifact is missing ${required}`)
    }
  }

  const output = Object.entries(files)
    .map(([path, content]) => `${path}\n${content}`)
    .join('\n')
  if (/\blocalhost\b/i.test(output)) {
    throw new Error('desktop production artifact contains localhost')
  }
  if (TEST_ONLY_FLAG.test(output)) {
    throw new Error('desktop production artifact contains a test-only feature flag')
  }
  if (!output.includes(origin)) {
    throw new Error(`desktop artifact is not attested to server origin ${origin}`)
  }
  if (!output.includes('capabilities')) {
    throw new Error('desktop artifact is missing runtime capability handoff')
  }
}

function collectFiles(root, relativeRoot = root) {
  const files = {}
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name)
    if (entry.isDirectory()) {
      Object.assign(files, collectFiles(absolute, relativeRoot))
      continue
    }
    const relative = absolute.slice(relativeRoot.length + 1).split('\\').join('/')
    files[`out/${relative}`] = readFileSync(absolute, 'utf8')
  }
  return files
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function smoke() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const serverOrigin = exactHttpsOrigin(
    argument('--server-origin') ?? process.env.IM_HUB_SERVER_URL ?? '',
  )
  const healthUrl = argument('--health-url') ?? `${serverOrigin}/health/ready`
  const environment = { ...process.env }
  delete environment.ELECTRON_RENDERER_URL
  environment.IM_HUB_INTERNAL_RELEASE = '1'
  environment.IM_HUB_SERVER_URL = serverOrigin

  const pnpmCommand = process.env.PNPM_COMMAND
    ?? (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
  execFileSync(pnpmCommand, [
    '--filter', '@im-hub/desktop', 'build',
  ], { cwd: repositoryRoot, env: environment, stdio: 'inherit' })

  const files = collectFiles(join(repositoryRoot, 'packages/desktop/out'))
  validateDesktopArtifact(files, serverOrigin)

  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) })
      if (!response.ok) {
        throw new Error(`runtime readiness probe returned HTTP ${response.status}`)
      }
      const body = await response.json()
      if (body?.status !== 'ready') {
        throw new Error('runtime readiness probe did not return ready')
      }
      process.stdout.write('desktop artifact smoke passed\n')
      return
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1_000))
    }
  }
  const message = lastError instanceof Error ? lastError.message : 'unknown probe error'
  throw new Error(`runtime readiness probe failed after 3 attempts: ${message}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await smoke()
}
