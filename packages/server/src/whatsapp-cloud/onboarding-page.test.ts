import { describe, expect, it } from 'vitest'
import { renderWhatsAppOnboardingPage } from './onboarding-page.js'

describe('WhatsApp onboarding HTTPS page', () => {
  it('只嵌入公开配置，ticket 从 fragment 读取后立即清掉', () => {
    const html = renderWhatsAppOnboardingPage({
      appId: 'public-app', configId: 'public-config', graphApiVersion: 'v25.0',
    }, 'nonce-test')
    expect(html).toContain("location.hash.slice(1)")
    expect(html).toContain("history.replaceState(null, '', location.pathname)")
    expect(html).toContain("response_type: 'code'")
    expect(html).toContain("sessionInfoVersion: '3'")
    expect(html).not.toContain('app-secret')
    expect(html).not.toContain('access-token')
  })
})
