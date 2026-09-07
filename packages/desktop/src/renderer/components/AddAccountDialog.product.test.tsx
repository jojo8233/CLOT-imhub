import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AddAccountDialog, connectionModeForPlatform } from './AddAccountDialog.js'

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
})
