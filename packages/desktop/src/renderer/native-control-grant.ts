export interface NativeControlGrantState {
  state: 'waiting' | 'ready' | 'blocked'
  expiresAt: string | null
}

export function nativeControlGrantIsUsable(
  control: NativeControlGrantState,
  now = Date.now(),
): boolean {
  if (control.state === 'blocked' || control.expiresAt === null) return false
  const expiresAt = Date.parse(control.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt > now
}
