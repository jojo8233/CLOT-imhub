import { describe, expect, it } from 'vitest'
import {
  resolveDesktopPlatformCapabilities,
  type DesktopPlatformCapabilities,
} from './desktop-capabilities.js'

describe('desktop platform capabilities', () => {
  it('standalone internal package exposes only WhatsApp Web', () => {
    expect(resolveDesktopPlatformCapabilities({
      releaseChannel: 'internal-unsigned',
      signalIntegrated: false,
      telegramStatic: false,
    })).toEqual<DesktopPlatformCapabilities>({
      telegram: false,
      signal: false,
      whatsapp: true,
    })
  })

  it('development and integrated host capabilities stay explicit', () => {
    expect(resolveDesktopPlatformCapabilities({
      releaseChannel: 'development',
      signalIntegrated: true,
      telegramStatic: false,
    })).toEqual<DesktopPlatformCapabilities>({
      telegram: true,
      signal: true,
      whatsapp: true,
    })
  })
})
