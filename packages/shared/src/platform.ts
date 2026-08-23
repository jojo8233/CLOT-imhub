export const PLATFORMS = ['telegram', 'signal', 'zoom', 'whatsapp'] as const
export type Platform = (typeof PLATFORMS)[number]

export type AccountStatus =
  | 'pending_auth'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'degraded'

export type Direction = 'in' | 'out'
