import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  builderArguments,
  createInternalReleaseAttestation,
  createInternalBuildManifest,
  expectedArtifactBasename,
  licenseArguments,
  matchingInternalArtifactBasenames,
  normalizeProductionLicenseInventory,
  unpackedOutputBasename,
  verifyInternalReleaseAttestation,
  unsignedBuildEnvironment,
} from './package-internal.mjs'
import { beforePackProjectDirectory } from './verify-internal-pack.mjs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe('internal desktop packaging', () => {
  it('uses stable unsigned DMG/NSIS metadata', () => {
    expect(pkg.version).toBe('0.1.0-internal.1')
    expect(pkg.build.appId).toBe('org.imhub.desktop')
    expect(pkg.build.productName).toBe('im-hub')
    expect(pkg.build.artifactName).toContain('internal-unsigned')
    expect(pkg.build.beforePack).toBe('./scripts/verify-internal-pack.mjs')
    expect(pkg.build.nsis).toMatchObject({ oneClick: false, perMachine: false })
    expect(pkg.scripts['licenses:prod'])
      .toBe('pnpm --filter @im-hub/desktop... licenses list --prod --json')
  })

  it('selects only the requested platform target', () => {
    expect(builderArguments('mac')).toEqual(['--mac', 'dmg', '--publish', 'never'])
    expect(builderArguments('win')).toEqual(['--win', 'nsis', '--x64', '--publish', 'never'])
  })

  it('reads the desktop project directory from the electron-builder hook context', () => {
    expect(beforePackProjectDirectory({
      packager: { projectDir: '/workspace/packages/desktop' },
    })).toBe('/workspace/packages/desktop')
  })

  it('suppresses pnpm lifecycle banners so the license inventory stays valid JSON', () => {
    expect(licenseArguments()).toEqual([
      '--silent', '--filter', '@im-hub/desktop', 'licenses:prod',
    ])
  })

  it('forces this channel to remain unsigned without exposing inherited signing config', () => {
    const env = unsignedBuildEnvironment({
      PATH: '/test/bin',
      IM_HUB_SERVER_URL: 'https://imhub.example.test',
      CSC_LINK: 'dummy-signing-material',
      WIN_CSC_LINK: 'dummy-windows-signing-material',
      APPLE_ID: 'dummy-apple-id',
    })
    expect(env).toMatchObject({
      PATH: '/test/bin',
      IM_HUB_SERVER_URL: 'https://imhub.example.test',
      IM_HUB_INTERNAL_RELEASE: '1',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    })
    expect(env).not.toHaveProperty('CSC_LINK')
    expect(env).not.toHaveProperty('WIN_CSC_LINK')
    expect(env).not.toHaveProperty('APPLE_ID')
  })

  it('writes a non-sensitive manifest', () => {
    expect(createInternalBuildManifest({
      commit: 'abc123', version: '0.1.0-internal.1', target: 'win', arch: 'x64',
      serverOrigin: 'https://imhub.example.test', artifacts: ['im-hub.exe'],
    })).toEqual({
      commit: 'abc123', version: '0.1.0-internal.1', platform: 'win', arch: 'x64',
      serverOrigin: 'https://imhub.example.test', channel: 'internal-unsigned',
      artifacts: ['im-hub.exe'],
    })
  })

  it('publishes only the exact artifact for the current version, target, and arch', () => {
    expect(expectedArtifactBasename({
      version: '0.1.0-internal.1', target: 'mac', arch: 'arm64',
    })).toBe('im-hub-0.1.0-internal.1-mac-arm64-internal-unsigned.dmg')
    expect(matchingInternalArtifactBasenames([
      'im-hub-0.1.0-internal.0-mac-arm64-internal-unsigned.dmg',
      'im-hub-0.1.0-internal.1-mac-x64-internal-unsigned.dmg',
      'im-hub-0.1.0-internal.1-mac-arm64-internal-unsigned.dmg',
    ], {
      version: '0.1.0-internal.1', target: 'mac', arch: 'arm64',
    })).toEqual(['im-hub-0.1.0-internal.1-mac-arm64-internal-unsigned.dmg'])
    expect(unpackedOutputBasename({ target: 'mac', arch: 'arm64' })).toBe('mac-arm64')
    expect(unpackedOutputBasename({ target: 'win', arch: 'x64' })).toBe('win-unpacked')
  })

  it('attests the compiled origin and exact desktop output before electron-builder runs', () => {
    const fileHashes = {
      'out/main/index.js': 'a'.repeat(64),
      'out/preload/index.mjs': 'b'.repeat(64),
      'out/renderer/index.html': 'c'.repeat(64),
    }
    const attestation = createInternalReleaseAttestation({
      version: '0.1.0-internal.1',
      serverOrigin: 'https://imhub.example.test',
      fileHashes,
    })

    expect(() => verifyInternalReleaseAttestation(attestation, {
      environment: {
        IM_HUB_INTERNAL_RELEASE: '1',
        IM_HUB_SERVER_URL: 'https://imhub.example.test',
      },
      version: '0.1.0-internal.1',
      fileHashes,
    })).not.toThrow()
    expect(() => verifyInternalReleaseAttestation(attestation, {
      environment: {},
      version: '0.1.0-internal.1',
      fileHashes,
    })).toThrow('internal release attestation')
    expect(() => verifyInternalReleaseAttestation(attestation, {
      environment: {
        IM_HUB_INTERNAL_RELEASE: '1',
        IM_HUB_SERVER_URL: 'https://other.example.test',
      },
      version: '0.1.0-internal.1',
      fileHashes,
    })).toThrow('internal release attestation')
  })

  it('normalizes a desktop-only license inventory without absolute build paths', () => {
    const normalized = normalizeProductionLicenseInventory({
      MIT: [
        { name: 'qrcode', version: '1.5.4', paths: ['/private/tmp/build/qrcode'] },
        { name: 'zustand', version: '5.0.8', paths: ['/private/tmp/build/zustand'] },
        { name: 'react', version: '19.1.1', paths: ['/private/tmp/build/react'] },
      ],
    }, [
      { license: 'MIT', name: 'react-dom', version: '19.1.1' },
      { license: 'MIT', name: 'electron', version: '33.4.11' },
      { license: 'MIT', name: 'scheduler', version: '0.26.0' },
    ])

    expect(JSON.stringify(normalized)).not.toContain('/private/tmp')
    expect(JSON.stringify(normalized)).toContain('react-dom')
    expect(JSON.stringify(normalized)).toContain('electron')
    expect(JSON.stringify(normalized)).toContain('scheduler')
  })

  it('rejects a bundled ReactDOM inventory without scheduler', () => {
    expect(() => normalizeProductionLicenseInventory({
      MIT: [
        { name: 'qrcode', version: '1.5.4' },
        { name: 'zustand', version: '5.0.8' },
        { name: 'react', version: '19.1.1' },
      ],
    }, [
      { license: 'MIT', name: 'react-dom', version: '19.1.1' },
      { license: 'MIT', name: 'electron', version: '33.4.11' },
    ])).toThrow('missing')
  })

  it('rejects server-only packages in the desktop license inventory', () => {
    expect(() => normalizeProductionLicenseInventory({
      MIT: [
        { name: 'qrcode', version: '1.5.4' },
        { name: 'zustand', version: '5.0.8' },
        { name: 'react', version: '19.1.1' },
        { name: '@fastify/cors', version: '10.0.0' },
      ],
    }, [
      { license: 'MIT', name: 'react-dom', version: '19.1.1' },
      { license: 'MIT', name: 'electron', version: '33.4.11' },
      { license: 'MIT', name: 'scheduler', version: '0.26.0' },
    ])).toThrow('server-only')
  })
})
