export const PLATFORMS = ['telegram', 'signal', 'zoom', 'whatsapp'] as const
export type Platform = (typeof PLATFORMS)[number]

export type AccountStatus =
  | 'pending_auth'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'degraded'

/**
 * 平台账号由哪条运行链路接管。
 *
 * adapter 是服务端适配器；native_desktop 是由 im-hub 桌面主进程托管的原生客户端。
 * 这不能从 credentials_ref 推断：原生客户端的 profile 不属于服务端凭据。
 */
export const ACCOUNT_CONNECTION_MODES = ['adapter', 'native_desktop'] as const
export type AccountConnectionMode = (typeof ACCOUNT_CONNECTION_MODES)[number]

export type Direction = 'in' | 'out'
