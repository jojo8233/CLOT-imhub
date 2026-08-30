import type {
  NativeControlGrantVerification,
  NativeControlState,
  NativeControlStateUpdate,
  NativeGuestEvent,
  Platform,
} from '@im-hub/shared'

interface ControlSession {
  accountId: string
  platform: Platform
  grant: string
  expectedExternalId: string
  actualExternalId: string | null
  expiresAt: number
  state: NativeControlState
  revoked: boolean
  message: string | null
}

export interface NativeControlDecision {
  forward: boolean
  state: NativeControlStateUpdate | null
  grantToRevoke: string | null
}

export class NativeControlRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NativeControlRegistryError'
  }
}

export class NativeControlRegistry {
  private readonly sessions = new Map<number, ControlSession>()
  private readonly observedIdentity = new Map<number, string | null>()

  configure(
    webContentsId: number,
    accountId: string,
    grant: string,
    verification: NativeControlGrantVerification,
    now = Date.now(),
  ): NativeControlDecision {
    const expiresAt = Date.parse(verification.expiresAt)
    if (verification.accountId !== accountId
      || !['telegram', 'signal'].includes(verification.platform)
      || !Number.isFinite(expiresAt)
      || expiresAt <= now) {
      throw new NativeControlRegistryError('账号控制授权无效或已经过期')
    }
    const hasObservedIdentity = this.observedIdentity.has(webContentsId)
    const actualExternalId = hasObservedIdentity
      ? this.observedIdentity.get(webContentsId) ?? null
      : null
    const state = hasObservedIdentity
      ? actualExternalId === verification.expectedPlatformAccountExternalId ? 'ready' : 'blocked'
      : 'waiting'
    const session: ControlSession = {
      accountId,
      platform: verification.platform,
      grant,
      expectedExternalId: verification.expectedPlatformAccountExternalId,
      actualExternalId,
      expiresAt,
      state,
      revoked: state === 'blocked',
      message: state === 'blocked' ? `${platformLabel(verification.platform)} 登录身份与 im-hub 账号不一致` : null,
    }
    this.sessions.set(webContentsId, session)
    return {
      forward: false,
      state: this.stateUpdate(session, session.message),
      grantToRevoke: state === 'blocked' ? grant : null,
    }
  }

  observeGuestEvent(
    webContentsId: number,
    accountId: string,
    event: NativeGuestEvent,
    now = Date.now(),
  ): NativeControlDecision {
    const session = this.sessions.get(webContentsId)
    if (session && session.accountId !== accountId) {
      return { forward: false, state: null, grantToRevoke: session.grant }
    }

    if (event.type === 'account.identity') {
      this.observedIdentity.set(webContentsId, event.platformAccountExternalId)
      if (!session) return { forward: true, state: waitingState(accountId), grantToRevoke: null }
      session.actualExternalId = event.platformAccountExternalId
      if (session.revoked) {
        session.state = event.platformAccountExternalId === session.expectedExternalId ? 'waiting' : 'blocked'
        session.message = session.state === 'waiting'
          ? `${platformLabel(session.platform)} 身份已更新，正在重新获取授权`
          : `${platformLabel(session.platform)} 登录身份与 im-hub 账号不一致`
        return {
          forward: true,
          state: this.stateUpdate(session, session.message),
          grantToRevoke: null,
        }
      }
      session.state = event.platformAccountExternalId === session.expectedExternalId ? 'ready' : 'blocked'
      session.revoked = session.state === 'blocked'
      session.message = session.state === 'blocked'
        ? `${platformLabel(session.platform)} 登录身份与 im-hub 账号不一致`
        : null
      return {
        forward: true,
        state: this.stateUpdate(session, session.message),
        grantToRevoke: session.state === 'blocked' ? session.grant : null,
      }
    }

    if (event.type === 'account.signed-out') {
      this.observedIdentity.set(webContentsId, null)
      if (!session) return { forward: true, state: waitingState(accountId), grantToRevoke: null }
      session.actualExternalId = null
      session.state = 'blocked'
      session.revoked = true
      session.message = `${platformLabel(session.platform)} 账号已退出，控制能力已撤销`
      return {
        forward: true,
        state: this.stateUpdate(session, session.message),
        grantToRevoke: session.grant,
      }
    }

    if (event.type === 'bridge.ready') {
      return {
        forward: true,
        state: session ? this.currentState(session, now) : waitingState(accountId),
        grantToRevoke: null,
      }
    }

    if (event.type === 'bridge.error') {
      return { forward: true, state: null, grantToRevoke: null }
    }

    if (!session) return { forward: false, state: waitingState(accountId), grantToRevoke: null }
    const state = this.currentState(session, now)
    return {
      forward: state.state === 'ready',
      state: state.state === 'ready' ? null : state,
      grantToRevoke: null,
    }
  }

  requireGrant(webContentsId: number, accountId: string, now = Date.now()): string {
    const session = this.sessions.get(webContentsId)
    if (!session || session.accountId !== accountId) {
      throw new NativeControlRegistryError('账号控制授权尚未建立')
    }
    const state = this.currentState(session, now)
    if (session.revoked || state.state !== 'ready') {
      throw new NativeControlRegistryError(state.message ?? '账号控制被阻断')
    }
    return session.grant
  }

  stateFor(webContentsId: number, accountId: string, now = Date.now()): NativeControlStateUpdate {
    const session = this.sessions.get(webContentsId)
    if (!session || session.accountId !== accountId) return waitingState(accountId)
    return this.currentState(session, now)
  }

  block(webContentsId: number, message: string): NativeControlStateUpdate | null {
    const session = this.sessions.get(webContentsId)
    if (!session) return null
    session.state = 'blocked'
    session.revoked = true
    session.message = message
    return this.stateUpdate(session, session.message)
  }

  releaseWebContents(webContentsId: number): string | null {
    const session = this.sessions.get(webContentsId)
    this.sessions.delete(webContentsId)
    this.observedIdentity.delete(webContentsId)
    return session?.grant ?? null
  }

  releaseAccount(accountId: string): string[] {
    const grants: string[] = []
    for (const [webContentsId, session] of this.sessions) {
      if (session.accountId !== accountId) continue
      grants.push(session.grant)
      this.sessions.delete(webContentsId)
      this.observedIdentity.delete(webContentsId)
    }
    return grants
  }

  releaseAll(): string[] {
    const grants = [...this.sessions.values()].map(session => session.grant)
    this.sessions.clear()
    this.observedIdentity.clear()
    return grants
  }

  private currentState(session: ControlSession, now: number): NativeControlStateUpdate {
    if (session.expiresAt <= now) {
      session.state = 'blocked'
      session.revoked = true
      session.message = '账号控制授权已过期，请重新获取授权'
      return this.stateUpdate(session, session.message)
    }
    return this.stateUpdate(
      session,
      session.message
        ?? (session.state === 'waiting' ? `正在核对 ${platformLabel(session.platform)} 登录身份` : null),
    )
  }

  private stateUpdate(session: ControlSession, message: string | null): NativeControlStateUpdate {
    return {
      accountId: session.accountId,
      state: session.state,
      message,
      expiresAt: new Date(session.expiresAt).toISOString(),
    }
  }
}

function platformLabel(platform: Platform): string {
  if (platform === 'telegram') return 'Telegram'
  if (platform === 'signal') return 'Signal'
  return platform
}

function waitingState(accountId: string): NativeControlStateUpdate {
  return {
    accountId,
    state: 'waiting',
    message: '正在建立账号控制授权',
    expiresAt: null,
  }
}
