import { HttpError } from '../api/client.js'

export async function previewWithManualCleanupFallback<T>(
  request: (allowManualCleanup: boolean) => Promise<T>,
  confirmOverride: () => boolean = confirmManualCleanupOverride,
): Promise<T> {
  try {
    return await request(false)
  } catch (cause) {
    if (!(cause instanceof HttpError)
      || cause.code !== 'CLIENT_UPDATE_REQUIRED'
      || !confirmOverride()) throw cause
    return request(true)
  }
}

export function confirmManualCleanupOverride(): boolean {
  return window.confirm(
    '检测到仍在线但版本过旧的 Telegram/WhatsApp 客户端，无法自动清理本机登录分区。'
    + '建议先升级客户端。是否仍继续，并把这些设备保留为逐项人工清理待办？',
  )
}
