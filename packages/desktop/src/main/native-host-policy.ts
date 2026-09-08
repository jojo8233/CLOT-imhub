const NATIVE_PARTITION = /^persist:native-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function nativeWebClients(): Map<string, { bridgeEnabled: boolean }> {
  const clients = new Map([
    ['https://web.whatsapp.com', { bridgeEnabled: true }],
  ])
  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  if (developmentUrl) {
    try {
      const origin = new URL(developmentUrl).origin
      clients.set(origin, { bridgeEnabled: true })
    } catch {
      // 无效的开发 URL 不得扩大 guest 白名单。
    }
  }
  return clients
}

export function nativeClientUrlAllowed(raw: string): boolean {
  try {
    return nativeWebClients().has(new URL(raw).origin)
  } catch {
    return false
  }
}

export function nativeClientBridgeAllowed(raw: string): boolean {
  try {
    return nativeWebClients().get(new URL(raw).origin)?.bridgeEnabled === true
  } catch {
    return false
  }
}

export function nativeClientComposerFocusRequired(raw: string): boolean {
  try {
    return new URL(raw).origin === 'https://web.whatsapp.com'
  } catch {
    return false
  }
}

/**
 * 官方 WhatsApp Web 会在登录后申请 durable storage，Electron 将该权限名映射为
 * `persistent-storage`。只给精确 WhatsApp 主框架开这一项，避免通用 guest 权限白名单
 * 顺带放开相机、麦克风、通知、剪贴板或第三方 iframe 的存储访问。
 */
export function nativeClientPermissionAllowed(
  raw: string,
  permission: string,
  isMainFrame: boolean,
): boolean {
  if (permission !== 'persistent-storage' || !isMainFrame) return false
  try {
    return new URL(raw).origin === 'https://web.whatsapp.com'
  } catch {
    return false
  }
}

export function nativePartitionAllowed(partition: string): boolean {
  return NATIVE_PARTITION.test(partition)
}

export function nativeAccountIdFromPartition(partition: string): string | null {
  if (!nativePartitionAllowed(partition)) return null
  return partition.slice('persist:native-'.length).toLowerCase()
}
