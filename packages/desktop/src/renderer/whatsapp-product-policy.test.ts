import { describe, expect, it } from 'vitest'
import {
  WHATSAPP_CREATION_MODE,
  WHATSAPP_PRODUCT_BLURB,
  whatsAppLegacyCloudNotice,
  whatsAppProductSurface,
  whatsAppWebAccount,
} from './whatsapp-product-policy.js'

describe('WhatsApp Web-only product policy', () => {
  it('fixes all new employee-visible accounts to web_shell', () => {
    expect(WHATSAPP_CREATION_MODE).toBe('web_shell')
    expect(WHATSAPP_PRODUCT_BLURB).toBe('WhatsApp Web 双语页面')
  })

  it('keeps web_shell and historical adapter accounts on the Web surface', () => {
    for (const connection_mode of ['web_shell', 'adapter'] as const) {
      const account = { platform: 'whatsapp', connection_mode }
      expect(whatsAppProductSurface(account)).toBe('web')
      expect(whatsAppWebAccount(account)).toBe(true)
      expect(whatsAppLegacyCloudNotice(account)).toBeNull()
    }
  })

  it('preserves Cloud accounts but marks them unavailable', () => {
    const account = { platform: 'whatsapp', connection_mode: 'cloud_api' }
    expect(whatsAppProductSurface(account)).toBe('legacy_cloud')
    expect(whatsAppWebAccount(account)).toBe(false)
    expect(whatsAppLegacyCloudNotice(account)).toBe('旧 Cloud 账号（当前产品不支持连接）')
  })

  it('does not classify other platforms as WhatsApp', () => {
    expect(whatsAppProductSurface({
      platform: 'signal', connection_mode: 'native_desktop',
    })).toBe('other')
    expect(whatsAppProductSurface(undefined)).toBe('other')
  })
})
