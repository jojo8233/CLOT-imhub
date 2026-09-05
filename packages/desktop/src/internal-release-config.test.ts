import { describe, expect, it } from 'vitest'
import {
  desktopServerUrl,
  desktopWebSocketUrl,
  resolveInternalReleaseBuild,
} from './internal-release-config.js'

describe('internal desktop release config', () => {
  it('requires one exact HTTPS origin and derives its WSS peer', () => {
    expect(resolveInternalReleaseBuild({
      IM_HUB_INTERNAL_RELEASE: '1',
      IM_HUB_SERVER_URL: 'https://imhub.example.test',
    })).toEqual({
      channel: 'internal-unsigned',
      serverUrl: 'https://imhub.example.test',
      wsUrl: 'wss://imhub.example.test',
    })
    expect(resolveInternalReleaseBuild({
      IM_HUB_INTERNAL_RELEASE: '1',
      IM_HUB_SERVER_URL: 'https://imhub.example.test/',
    }).serverUrl).toBe('https://imhub.example.test')
  })

  it.each([
    undefined,
    'http://imhub.example.test',
    'https://user:password@imhub.example.test',
    'https://imhub.example.test/api',
    'https://imhub.example.test?tenant=1',
    'https://imhub.example.test/#fragment',
  ])('rejects an unsafe packaged origin: %s', (serverUrl) => {
    expect(() => resolveInternalReleaseBuild({
      IM_HUB_INTERNAL_RELEASE: '1',
      IM_HUB_SERVER_URL: serverUrl,
    })).toThrow('IM_HUB_SERVER_URL')
  })

  it('keeps localhost only as an explicit non-internal fallback', () => {
    expect(resolveInternalReleaseBuild({})).toEqual({
      channel: 'development', serverUrl: null, wsUrl: null,
    })
    expect(desktopServerUrl(null, undefined)).toBe('http://localhost:4000')
    expect(desktopServerUrl(null, 'http://127.0.0.1:4000')).toBe('http://127.0.0.1:4000')
    expect(desktopWebSocketUrl(null, 'http://127.0.0.1:4000')).toBe('ws://127.0.0.1:4000')
  })

  it('never lets runtime environment override compiled internal origins', () => {
    expect(desktopServerUrl(
      'https://imhub.example.test', 'https://override.invalid',
    )).toBe('https://imhub.example.test')
    expect(desktopWebSocketUrl(
      'wss://imhub.example.test', 'http://override.invalid',
    )).toBe('wss://imhub.example.test')
  })
})
