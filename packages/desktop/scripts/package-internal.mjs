import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptPath = fileURLToPath(import.meta.url)
const desktopRoot = resolve(dirname(scriptPath), '..')
const releaseDirectory = resolve(desktopRoot, 'release')

const signingEnvironmentKeys = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'CSC_NAME',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
]

export function builderArguments(target) {
  if (target === 'mac') return ['--mac', 'dmg', '--publish', 'never']
  if (target === 'win') return ['--win', 'nsis', '--x64', '--publish', 'never']
  throw new Error('internal package target must be mac or win')
}

export function licenseArguments() {
  return ['--silent', '--filter', '@im-hub/desktop', 'licenses:prod']
}

export function unsignedBuildEnvironment(environment) {
  const unsignedEnvironment = {
    ...environment,
    IM_HUB_INTERNAL_RELEASE: '1',
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  }
  for (const key of signingEnvironmentKeys) delete unsignedEnvironment[key]
  return unsignedEnvironment
}

export function createInternalBuildManifest({
  commit,
  version,
  target,
  arch,
  serverOrigin,
  artifacts,
}) {
  return {
    commit,
    version,
    platform: target,
    arch,
    serverOrigin,
    channel: 'internal-unsigned',
    artifacts,
  }
}

function pnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    env: options.env,
    encoding: 'utf8',
    shell: false,
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${options.label ?? command} failed with exit code ${result.status ?? 'unknown'}`)
  }
  return result.stdout ?? ''
}

function validateTarget(target) {
  if (target !== 'mac' && target !== 'win') {
    throw new Error('internal package target must be mac or win')
  }
  if (target === 'mac' && process.platform !== 'darwin') {
    throw new Error('mac internal packages must be built on macOS')
  }
  if (target === 'win' && process.platform !== 'win32') {
    throw new Error('Windows internal packages must be built on Windows')
  }
}

function productionLicenseInventory(environment) {
  const rawInventory = run(
    pnpmCommand(),
    licenseArguments(),
    { capture: true, env: environment, label: 'production license inventory' },
  )
  let inventory
  try {
    inventory = JSON.parse(rawInventory)
  } catch {
    throw new Error('production license inventory was not valid JSON')
  }
  if (
    typeof inventory !== 'object'
    || inventory === null
    || Array.isArray(inventory)
    || Object.prototype.hasOwnProperty.call(inventory, 'error')
  ) {
    throw new Error('production license inventory was not a license object')
  }
  return inventory
}

function artifactBasenames(target) {
  const extension = target === 'mac' ? '.dmg' : '.exe'
  return readdirSync(releaseDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => name.includes('internal-unsigned') && name.endsWith(extension))
    .sort()
}

function packageMetadata() {
  return JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'))
}

function currentCommit(environment) {
  return run('git', ['rev-parse', '--short', 'HEAD'], {
    capture: true,
    env: environment,
    label: 'git revision lookup',
  }).trim()
}

export function packageInternal(target, environment = process.env) {
  validateTarget(target)
  if (!environment.IM_HUB_SERVER_URL) {
    throw new Error('IM_HUB_SERVER_URL is required for internal packaging')
  }

  const serverOrigin = new URL(environment.IM_HUB_SERVER_URL).origin
  const unsignedEnvironment = unsignedBuildEnvironment(environment)
  run(pnpmCommand(), ['exec', 'electron-vite', 'build'], {
    env: unsignedEnvironment,
    label: 'desktop build',
  })
  run(pnpmCommand(), ['exec', 'electron-builder', ...builderArguments(target)], {
    env: unsignedEnvironment,
    label: 'desktop package',
  })

  const metadata = packageMetadata()
  const version = metadata.version
  const licenses = productionLicenseInventory(unsignedEnvironment)
  mkdirSync(releaseDirectory, { recursive: true })
  writeFileSync(
    resolve(
      releaseDirectory,
      `im-hub-${version}-internal-unsigned-third-party-licenses.json`,
    ),
    `${JSON.stringify(licenses, null, 2)}\n`,
  )

  const artifacts = artifactBasenames(target)
  if (artifacts.length === 0) {
    throw new Error('internal package did not produce the expected artifact')
  }
  const manifest = createInternalBuildManifest({
    commit: currentCommit(unsignedEnvironment),
    version,
    target,
    arch: target === 'win' ? 'x64' : process.arch,
    serverOrigin,
    artifacts,
  })
  writeFileSync(
    resolve(
      releaseDirectory,
      `im-hub-${version}-${target}-${manifest.arch}-internal-unsigned.manifest.json`,
    ),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
}

if (process.argv[1] && scriptPath === resolve(process.argv[1])) {
  try {
    packageInternal(process.argv[2])
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'internal packaging failed')
    process.exitCode = 1
  }
}
