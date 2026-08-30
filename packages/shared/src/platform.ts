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
 * adapter 是既有服务端适配器；native_desktop 是由 im-hub 桌面主进程托管的原生客户端；
 * web_shell 只承载隔离的官方网页，不提供消息桥；cloud_api 预留给 WhatsApp Business
 * Platform 官方 API，尚未配置前不能创建。
 *
 * 这不能从 credentials_ref 推断：原生客户端 profile 与网页 partition 都不属于服务端凭据，
 * Cloud API 也只能保存服务端 secret reference，不能把 token 放进这个字段。
 */
export const ACCOUNT_CONNECTION_MODES = [
  'adapter',
  'native_desktop',
  'web_shell',
  'cloud_api',
] as const
export type AccountConnectionMode = (typeof ACCOUNT_CONNECTION_MODES)[number]

export type Direction = 'in' | 'out'
