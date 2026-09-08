import { describe, expect, it } from 'vitest'
import {
  REQUIRED_DESKTOP_ARTIFACT_FILES,
  validateDesktopArtifact,
} from './artifact-smoke.mjs'

const cleanFiles = {
  'out/main/index.js': 'const origin = "https://imhub.example.test"',
  'out/preload/index.mjs': 'contextBridge.exposeInMainWorld("imHub", { capabilities: runtimeProbe })',
  'out/renderer/index.html': '<script type="module" src="/assets/index.js"></script>',
  'out/renderer/assets/index.js': 'const channel = "internal-unsigned"',
}

describe('desktop artifact smoke validation', () => {
  it('accepts the required production output and server origin', () => {
    expect(() => validateDesktopArtifact(cleanFiles, 'https://imhub.example.test'))
      .not.toThrow()
    expect(REQUIRED_DESKTOP_ARTIFACT_FILES).toEqual([
      'out/main/index.js',
      'out/preload/index.mjs',
      'out/renderer/index.html',
    ])
  })

  it('rejects localhost from production output', () => {
    expect(() => validateDesktopArtifact({
      ...cleanFiles,
      'out/renderer/assets/index.js': 'const dev = "http://localhost:4000"',
    }, 'https://imhub.example.test')).toThrow('localhost')
  })

  it('rejects test-only environment feature flags from production output', () => {
    expect(() => validateDesktopArtifact({
      ...cleanFiles,
      'out/main/index.js': 'process.env.IM_HUB_TEST_SIGNAL = "1"',
    }, 'https://imhub.example.test')).toThrow('test-only')
  })

  it('rejects output that is not attested to the requested HTTPS origin', () => {
    expect(() => validateDesktopArtifact({
      ...cleanFiles,
      'out/main/index.js': 'const origin = "https://other.example.test"',
    }, 'https://imhub.example.test')).toThrow('server origin')
  })
})
