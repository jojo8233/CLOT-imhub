import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AddAccountDialog, connectionModeForPlatform } from './AddAccountDialog.js'
import { resolveDesktopPlatformCapabilities } from '../../desktop-capabilities.js'

describe('AddAccountDialog WhatsApp product route', () => {
  it('shows only WhatsApp Web onboarding', () => {
    const html = renderToStaticMarkup(<AddAccountDialog
      initialPlatform="whatsapp"
      role="agent"
      onClose={() => undefined}
      onAccountsChanged={async () => undefined}
    />)
    expect(html).toContain('WhatsApp Web 双语页面')
    expect(html).toContain('创建并扫码')
    expect(html).not.toContain('Cloud API')
    expect(html).not.toContain('Meta Embedded Signup')
  })

  it('maps each employee-visible platform to its supported connection mode', () => {
    expect(connectionModeForPlatform('whatsapp')).toBe('web_shell')
    expect(connectionModeForPlatform('signal')).toBe('native_desktop')
    expect(connectionModeForPlatform('telegram')).toBe('adapter')
  })

  it('standalone package marks only WhatsApp as ready', () => {
    const capabilities = resolveDesktopPlatformCapabilities({
      releaseChannel: 'internal-unsigned',
      signalIntegrated: false,
      telegramStatic: false,
    })
    const html = renderToStaticMarkup(<AddAccountDialog
      initialPlatform="telegram"
      role="agent"
      onClose={() => undefined}
      onAccountsChanged={async () => undefined}
      capabilities={capabilities}
    />)
    expect(html).toContain('WhatsApp Web 双语页面')
    expect(html).toContain('未接入')
  })
})
