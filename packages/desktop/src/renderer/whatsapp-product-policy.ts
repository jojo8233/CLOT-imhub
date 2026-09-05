import type { AccountConnectionMode } from '@im-hub/shared'

export const WHATSAPP_CREATION_MODE = 'web_shell' as const satisfies AccountConnectionMode
export const WHATSAPP_PRODUCT_BLURB = 'WhatsApp Web 双语页面'

export type WhatsAppProductSurface = 'web' | 'legacy_cloud' | 'other'

interface ProductAccount {
  platform: string
  connection_mode: string
}

export function whatsAppProductSurface(
  account: ProductAccount | undefined,
): WhatsAppProductSurface {
  if (account?.platform !== 'whatsapp') return 'other'
  if (account.connection_mode === 'web_shell' || account.connection_mode === 'adapter') return 'web'
  if (account.connection_mode === 'cloud_api') return 'legacy_cloud'
  return 'other'
}

export function whatsAppWebAccount(account: ProductAccount | undefined): boolean {
  return whatsAppProductSurface(account) === 'web'
}

export function whatsAppLegacyCloudNotice(account: ProductAccount | undefined): string | null {
  return whatsAppProductSurface(account) === 'legacy_cloud'
    ? '旧 Cloud 账号（当前产品不支持连接）'
    : null
}
