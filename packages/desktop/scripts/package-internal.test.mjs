import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  builderArguments,
  createInternalBuildManifest,
  licenseArguments,
  unsignedBuildEnvironment,
} from './package-internal.mjs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe('internal desktop packaging', () => {
  it('uses stable unsigned DMG/NSIS metadata', () => {
    expect(pkg.version).toBe('0.1.0-internal.1')
    expect(pkg.build.appId).toBe('org.imhub.desktop')
    expect(pkg.build.productName).toBe('im-hub')
    expect(pkg.build.artifactName).toContain('internal-unsigned')
    expect(pkg.build.nsis).toMatchObject({ oneClick: false, perMachine: false })
    expect(pkg.scripts['licenses:prod']).toBe('pnpm licenses list --prod --json')
  })

  it('selects only the requested platform target', () => {
    expect(builderArguments('mac')).toEqual(['--mac', 'dmg', '--publish', 'never'])
    expect(builderArguments('win')).toEqual(['--win', 'nsis', '--x64', '--publish', 'never'])
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
})
