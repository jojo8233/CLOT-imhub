import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptPath = fileURLToPath(import.meta.url)
const desktopRoot = resolve(dirname(scriptPath), '..')
const releaseDirectory = resolve(desktopRoot, 'release')
const outputDirectory = resolve(desktopRoot, 'out')
const attestationPath = resolve(outputDirectory, 'internal-release-attestation.json')
const requiredDesktopOutput = [
  'out/main/index.js',
  'out/preload/index.mjs',
  'out/renderer/index.html',
]
const requiredLicensePackages = [
  'electron',
  'qrcode',
  'react',
  'react-dom',
  'scheduler',
  'zustand',
]

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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalInternalOrigin(value) {
  try {
    const parsed = new URL(value)
    const exact = value === parsed.origin || value === `${parsed.origin}/`
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !exact) {
      throw new Error('invalid origin')
    }
    return parsed.origin
  } catch {
    throw new Error('internal release attestation verification failed')
  }
}

export function createInternalReleaseAttestation({ version, serverOrigin, fileHashes }) {
  return {
    channel: 'internal-unsigned',
    version,
    serverOriginSha256: sha256(canonicalInternalOrigin(serverOrigin)),
    fileHashes,
  }
}

export function verifyInternalReleaseAttestation(attestation, {
  environment,
  version,
  fileHashes,
}) {
  const failed = () => { throw new Error('internal release attestation verification failed') }
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) failed()
  if (environment.IM_HUB_INTERNAL_RELEASE !== '1' || !environment.IM_HUB_SERVER_URL) failed()
  let origin
  try {
    origin = canonicalInternalOrigin(environment.IM_HUB_SERVER_URL)
  } catch {
    failed()
  }
  if (
    attestation.channel !== 'internal-unsigned'
    || attestation.version !== version
    || attestation.serverOriginSha256 !== sha256(origin)
    || JSON.stringify(attestation.fileHashes) !== JSON.stringify(fileHashes)
    || requiredDesktopOutput.some(path => typeof fileHashes[path] !== 'string')
  ) failed()
}

function outputFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...outputFiles(path))
    if (entry.isFile()) files.push(path)
  }
  return files
}

export function collectDesktopOutputFileHashes(directory = outputDirectory) {
  const hashes = {}
  for (const path of outputFiles(directory).sort()) {
    if (resolve(path) === attestationPath) continue
    const key = `out/${relative(directory, path).split('\\').join('/')}`
    hashes[key] = sha256(readFileSync(path))
  }
  return hashes
}

export function expectedArtifactBasename({ version, target, arch }) {
  const extension = target === 'mac' ? 'dmg' : target === 'win' ? 'exe' : null
  if (!extension) throw new Error('internal package target must be mac or win')
  return `im-hub-${version}-${target}-${arch}-internal-unsigned.${extension}`
}

export function matchingInternalArtifactBasenames(entries, build) {
  const expected = expectedArtifactBasename(build)
  return entries.filter(name => name === expected)
}

export function unpackedOutputBasename({ target, arch }) {
  if (target === 'mac') return `mac-${arch}`
  if (target === 'win') return 'win-unpacked'
  throw new Error('internal package target must be mac or win')
}

function packageNameIsServerOnly(name) {
  return name === 'fastify'
    || name.startsWith('@fastify/')
    || name === 'kysely'
    || name === 'bullmq'
    || name === 'ioredis'
}

export function normalizeProductionLicenseInventory(inventory, runtimeComponents) {
  if (
    !inventory
    || typeof inventory !== 'object'
    || Array.isArray(inventory)
    || Object.prototype.hasOwnProperty.call(inventory, 'error')
  ) {
    throw new Error('production license inventory was not a license object')
  }

  const grouped = new Map()
  for (const [license, records] of Object.entries(inventory)) {
    if (!Array.isArray(records)) {
      throw new Error('production license inventory contained an invalid group')
    }
    for (const record of records) {
      const versions = typeof record?.version === 'string'
        ? [record.version]
        : record?.versions
      if (!record || typeof record !== 'object' || Array.isArray(record)
        || typeof record.name !== 'string' || !Array.isArray(versions)
        || versions.length === 0 || versions.some(version => typeof version !== 'string')) {
        throw new Error('production license inventory contained an invalid package')
      }
      if (packageNameIsServerOnly(record.name)) {
        throw new Error('production license inventory contained a server-only package')
      }
      const { paths: _paths, ...portableRecord } = record
      const key = `${record.name}@${versions.join(',')}`
      grouped.set(key, { license, record: portableRecord })
    }
  }

  for (const component of runtimeComponents) {
    if (!component || typeof component.name !== 'string'
      || typeof component.version !== 'string' || typeof component.license !== 'string') {
      throw new Error('production license inventory contained invalid runtime metadata')
    }
    const key = `${component.name}@${component.version}`
    if (!grouped.has(key)) {
      const { license, ...record } = component
      grouped.set(key, { license, record })
    }
  }

  const packageNames = new Set([...grouped.values()].map(value => value.record.name))
  if (requiredLicensePackages.some(name => !packageNames.has(name))) {
    throw new Error('production license inventory was missing a required desktop package')
  }

  const normalized = {}
  for (const { license, record } of [...grouped.values()]
    .sort((left, right) => left.record.name.localeCompare(right.record.name))) {
    normalized[license] ??= []
    normalized[license].push(record)
  }
  return Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)))
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
  return normalizeProductionLicenseInventory(inventory, runtimeLicenseComponents())
}

function runtimeLicenseComponents() {
  return ['electron'].map((name) => {
    const metadata = JSON.parse(readFileSync(
      resolve(desktopRoot, 'node_modules', name, 'package.json'),
      'utf8',
    ))
    if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string'
      || typeof metadata.license !== 'string') {
      throw new Error('production license inventory contained invalid runtime metadata')
    }
    return { name: metadata.name, version: metadata.version, license: metadata.license }
  })
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

  const serverOrigin = canonicalInternalOrigin(environment.IM_HUB_SERVER_URL)
  const unsignedEnvironment = unsignedBuildEnvironment(environment)
  const metadata = packageMetadata()
  const version = metadata.version
  const arch = target === 'win' ? 'x64' : process.arch
  const artifact = expectedArtifactBasename({ version, target, arch })
  const manifestName = `im-hub-${version}-${target}-${arch}-internal-unsigned.manifest.json`
  const licenseName = `im-hub-${version}-internal-unsigned-third-party-licenses.json`
  const releasePaths = [artifact, manifestName, licenseName]
    .map(name => resolve(releaseDirectory, name))
  mkdirSync(releaseDirectory, { recursive: true })
  for (const path of [...releasePaths, resolve(releaseDirectory, `${artifact}.blockmap`)]) {
    rmSync(path, { force: true })
  }
  rmSync(resolve(releaseDirectory, unpackedOutputBasename({ target, arch })), {
    recursive: true,
    force: true,
  })
  rmSync(resolve(releaseDirectory, 'builder-debug.yml'), { force: true })
  rmSync(resolve(releaseDirectory, 'builder-effective-config.yaml'), { force: true })
  rmSync(attestationPath, { force: true })

  let stagingDirectory = null
  try {
    run(pnpmCommand(), ['exec', 'electron-vite', 'build'], {
      env: unsignedEnvironment,
      label: 'desktop build',
    })
    const fileHashes = collectDesktopOutputFileHashes()
    const attestation = createInternalReleaseAttestation({
      version,
      serverOrigin,
      fileHashes,
    })
    writeFileSync(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`)

    const licenses = productionLicenseInventory(unsignedEnvironment)
    stagingDirectory = mkdtempSync(resolve(releaseDirectory, '.internal-staging-'))
    run(pnpmCommand(), [
      'exec',
      'electron-builder',
      ...builderArguments(target),
      `--config.directories.output=${stagingDirectory}`,
    ], {
      env: unsignedEnvironment,
      label: 'desktop package',
    })

    const artifacts = matchingInternalArtifactBasenames(
      readdirSync(stagingDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => entry.name),
      { version, target, arch },
    )
    if (artifacts.length !== 1) {
      throw new Error('internal package did not produce the exact expected artifact')
    }

    writeFileSync(resolve(stagingDirectory, licenseName),
      `${JSON.stringify(licenses, null, 2)}\n`,
    )
    const manifest = createInternalBuildManifest({
      commit: currentCommit(unsignedEnvironment),
      version,
      target,
      arch,
      serverOrigin,
      artifacts,
    })
    writeFileSync(resolve(stagingDirectory, manifestName), `${JSON.stringify(manifest, null, 2)}\n`)

    // 三项全部成功后才发布。任一 rename 失败会进入 catch 并清掉这一版本的全部目标，
    // 避免 release 中留下没有清单或没有许可信息的孤立安装包。
    for (const name of [artifact, manifestName, licenseName]) {
      const staged = resolve(stagingDirectory, name)
      const destination = resolve(releaseDirectory, name)
      try {
        renameSync(staged, destination)
      } catch {
        copyFileSync(staged, destination)
        rmSync(staged, { force: true })
      }
    }
  } catch (error) {
    for (const path of releasePaths) rmSync(path, { force: true })
    throw error
  } finally {
    rmSync(attestationPath, { force: true })
    if (stagingDirectory) rmSync(stagingDirectory, { recursive: true, force: true })
  }
}

if (process.argv[1] && scriptPath === resolve(process.argv[1])) {
  try {
    packageInternal(process.argv[2])
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'internal packaging failed')
    process.exitCode = 1
  }
}
