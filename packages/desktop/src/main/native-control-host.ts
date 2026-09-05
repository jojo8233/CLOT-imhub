import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { ipcMain, session, webContents } from 'electron'
import {
  NATIVE_BRIDGE_PROTOCOL_VERSION,
  NATIVE_CONTROL_AUTH_SCHEME,
  type NativeControlGrantVerification,
  type NativeControlStateUpdate,
  type NativeGuestEvent,
  type NativeHostCommand,
  type NativeTranslationBatchInput,
} from '@im-hub/shared'
import { parseNativeGuestEvent, parseNativeHostCommand } from '../native-bridge-runtime.js'
import {
  NATIVE_CONTROL_CONFIGURE_CHANNEL,
  NATIVE_CONTROL_EVENT_CHANNEL,
  NATIVE_CONTROL_RELEASE_ALL_CHANNEL,
  NATIVE_CONTROL_RELEASE_CHANNEL,
  NATIVE_CONTROL_REMOVE_ACCOUNT_CHANNEL,
  NATIVE_CONTROL_REPORT_EVENT_CHANNEL,
  NATIVE_CONTROL_SEND_COMMAND_CHANNEL,
  NATIVE_CONTROL_STATE_CHANNEL,
  NATIVE_CONTROL_SYNC_CONTEXT_CHANNEL,
  NATIVE_GUEST_EVENT_CHANNEL,
  NATIVE_TRANSLATE_BATCH_CHANNEL,
  NATIVE_TRANSLATE_DETECT_CHANNEL,
} from '../native-control-ipc.js'
import { NativeControlRegistry, NativeControlRegistryError } from './native-control-registry.js'
import { deliverNativeHostCommand } from './native-command-delivery.js'

const COMMAND_CHANNEL = 'imhub:native-command'
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_GRANT_LENGTH = 8_192
const MAX_PROXY_BYTES = 900_000
const VERIFY_TIMEOUT_MS = 10_000
const PROXY_TIMEOUT_MS = 30_000

interface GuestRegistration {
  accountId: string
  contents: WebContents
  hostWebContentsId: number
  focusComposerCommands: boolean
}

interface ConfigurePayload {
  accountId: string
  guestWebContentsId: number
  grant: string
}

interface AccountPayload {
  accountId: string
  guestWebContentsId: number
}

interface ProxyPayload extends AccountPayload {
  value: unknown
}

export class NativeControlHost {
  private readonly registry = new NativeControlRegistry()
  private readonly trustedHosts = new Set<number>()
  private readonly guests = new Map<number, GuestRegistration>()

  constructor(private readonly serverUrl: string) {}

  install(): void {
    ipcMain.handle(NATIVE_CONTROL_CONFIGURE_CHANNEL, (event, payload: unknown) =>
      this.configure(event, payload))
    ipcMain.handle(NATIVE_CONTROL_RELEASE_CHANNEL, (event, payload: unknown) =>
      this.release(event, payload))
    ipcMain.handle(NATIVE_CONTROL_RELEASE_ALL_CHANNEL, event => this.releaseAll(event))
    ipcMain.handle(NATIVE_CONTROL_REMOVE_ACCOUNT_CHANNEL, (event, payload: unknown) =>
      this.removeAccount(event, payload))
    ipcMain.handle(NATIVE_CONTROL_SEND_COMMAND_CHANNEL, (event, payload: unknown) =>
      this.sendCommand(event, payload))
    ipcMain.handle(NATIVE_CONTROL_SYNC_CONTEXT_CHANNEL, (event, payload: unknown) =>
      this.proxyFromHost(event, payload, '/api/native/context', 'context'))
    ipcMain.handle(NATIVE_CONTROL_REPORT_EVENT_CHANNEL, (event, payload: unknown) =>
      this.proxyFromHost(event, payload, '/api/native/events', 'event'))
    ipcMain.handle(NATIVE_TRANSLATE_BATCH_CHANNEL, (event, payload: unknown) =>
      this.translateBatch(event, payload))
    ipcMain.handle(NATIVE_TRANSLATE_DETECT_CHANNEL, (event, payload: unknown) =>
      this.detectLanguage(event, payload))
    ipcMain.on(NATIVE_GUEST_EVENT_CHANNEL, (event, payload: unknown) => {
      this.handleGuestEvent(event, payload)
    })
  }

  attachHost(contents: WebContents): void {
    this.trustedHosts.add(contents.id)
    contents.once('destroyed', () => { this.trustedHosts.delete(contents.id) })
  }

  registerGuest(
    contents: WebContents,
    accountId: string,
    hostWebContentsId: number,
    focusComposerCommands = false,
  ): void {
    this.guests.set(contents.id, {
      accountId,
      contents,
      hostWebContentsId,
      focusComposerCommands,
    })
    contents.once('destroyed', () => {
      this.guests.delete(contents.id)
      const grant = this.registry.releaseWebContents(contents.id)
      if (grant) void this.revokeGrant(grant)
    })
  }

  private async configure(event: IpcMainInvokeEvent, value: unknown): Promise<NativeControlStateUpdate> {
    this.requireTrustedHost(event)
    const payload = parseConfigurePayload(value)
    const guest = this.requireGuest(payload.accountId, payload.guestWebContentsId, event.sender.id)
    const verification = await this.verifyGrant(payload.grant)
    const decision = this.registry.configure(
      guest.contents.id,
      guest.accountId,
      payload.grant,
      verification,
    )
    if (!decision.state) throw new NativeControlRegistryError('账号控制状态不可用')
    this.sendState(guest, decision.state)
    if (decision.grantToRevoke) void this.revokeGrant(decision.grantToRevoke)
    if (decision.state.state !== 'blocked') {
      // guest 可能早于 grant 建立就上报过身份。由已验证的主进程在配置完成后
      // 主动要求重放身份、上下文和 composer，避免 waiting 状态无从推进；
      // renderer 不再在每个 ready 上重复请求，因而不会形成 ready/identity 闭环。
      guest.contents.send(COMMAND_CHANNEL, {
        protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
        type: 'bridge.request-state',
      } satisfies NativeHostCommand)
    }
    return decision.state
  }

  private async release(event: IpcMainInvokeEvent, value: unknown): Promise<void> {
    this.requireTrustedHost(event)
    const payload = parseAccountPayload(value)
    const guest = this.requireGuest(payload.accountId, payload.guestWebContentsId, event.sender.id)
    const grant = this.registry.releaseWebContents(guest.contents.id)
    if (grant) await this.revokeGrant(grant)
  }

  private async releaseAll(event: IpcMainInvokeEvent): Promise<void> {
    this.requireTrustedHost(event)
    await Promise.allSettled(this.registry.releaseAll().map(grant => this.revokeGrant(grant)))
  }

  private async removeAccount(event: IpcMainInvokeEvent, value: unknown): Promise<void> {
    this.requireTrustedHost(event)
    const accountId = parseAccountId(value)
    await this.purgeAccount(accountId)
  }

  async purgeAccount(accountId: string): Promise<void> {
    const grants = this.registry.releaseAccount(accountId)
    await Promise.allSettled(grants.map(grant => this.revokeGrant(grant)))
    for (const [guestId, guest] of this.guests) {
      if (guest.accountId !== accountId) continue
      this.guests.delete(guestId)
      if (!guest.contents.isDestroyed()) guest.contents.close()
    }
    await this.clearAccountPartition(accountId)
  }

  private async sendCommand(event: IpcMainInvokeEvent, value: unknown): Promise<void> {
    this.requireTrustedHost(event)
    if (!record(value)) throw new NativeControlRegistryError('原生命令参数无效')
    const payload = parseAccountPayload(value)
    const command = parseNativeHostCommand(value.command)
    if (!command) throw new NativeControlRegistryError('原生命令格式无效')
    const guest = this.requireGuest(payload.accountId, payload.guestWebContentsId, event.sender.id)
    await this.requireLiveGrant(guest)
    await deliverNativeHostCommand(
      guest.contents,
      COMMAND_CHANNEL,
      command,
      guest.focusComposerCommands,
    )
  }

  private async proxyFromHost(
    event: IpcMainInvokeEvent,
    value: unknown,
    path: string,
    bodyKey: 'context' | 'event',
  ): Promise<unknown> {
    this.requireTrustedHost(event)
    const payload = parseProxyPayload(value)
    const guest = this.requireGuest(payload.accountId, payload.guestWebContentsId, event.sender.id)
    if (!jsonSizeAllowed(payload.value)) throw new NativeControlRegistryError('原生代理请求过大')
    return this.proxyRequest(guest, path, {
      accountId: payload.accountId,
      [bodyKey]: payload.value,
    })
  }

  private handleGuestEvent(event: IpcMainEvent, value: unknown): void {
    const guest = this.guests.get(event.sender.id)
    if (!guest || guest.contents !== event.sender) return
    const nativeEvent = parseNativeGuestEvent(value)
    if (!nativeEvent) {
      const eventType = record(value) && typeof value.type === 'string' ? value.type : 'unknown'
      console.error(`[native-control:${guest.accountId.slice(0, 8)}] 已拒绝无效 guest 事件（${eventType}）`)
      this.sendState(guest, blockedState(guest.accountId, '原生客户端发送了无效桥接事件'))
      return
    }
    const decision = this.registry.observeGuestEvent(event.sender.id, guest.accountId, nativeEvent)
    if (nativeEvent.type === 'command.result' && !nativeEvent.ok) {
      console.error(
        `[native-control:${guest.accountId.slice(0, 8)}] ${nativeEvent.command} 失败（${nativeEvent.error?.code ?? 'unknown'}）`,
      )
    }
    if (decision.state) this.sendState(guest, decision.state)
    if (decision.forward) this.sendGuestEvent(guest, nativeEvent)
    if (nativeEvent.type === 'account.signed-out') {
      const grant = this.registry.releaseWebContents(event.sender.id)
      if (grant) void this.revokeGrant(grant)
      void this.clearAccountPartition(guest.accountId).catch(() => {
        console.error(`[native-control:${guest.accountId.slice(0, 8)}] 账号退出后的本机分区清理失败`)
      })
      return
    }
    if (decision.grantToRevoke) void this.revokeGrant(decision.grantToRevoke)
  }

  private async translateBatch(event: IpcMainInvokeEvent, value: unknown): Promise<unknown> {
    const guest = this.requireGuestSender(event)
    const input = parseTranslationBatch(value)
    return this.proxyRequest(guest, '/api/translate/batch', input)
  }

  private async detectLanguage(event: IpcMainInvokeEvent, value: unknown): Promise<unknown> {
    const guest = this.requireGuestSender(event)
    if (!record(value)
      || typeof value.text !== 'string'
      || value.text.trim() === ''
      || value.text.length > 4_000) {
      throw new NativeControlRegistryError('语言识别参数无效')
    }
    return this.proxyRequest(guest, '/api/translate/detect', { text: value.text })
  }

  private async proxyRequest(guest: GuestRegistration, path: string, body: unknown): Promise<unknown> {
    const grant = this.requireLocalGrant(guest)
    let response: Response
    try {
      response = await fetch(`${this.serverUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `${NATIVE_CONTROL_AUTH_SCHEME} ${grant}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      })
    } catch {
      throw new NativeControlRegistryError('连接原生代理服务失败')
    }
    if (response.status === 401 || response.status === 403) {
      const state = this.registry.block(guest.contents.id, '账号控制授权已失效')
      if (state) this.sendState(guest, state)
      throw new NativeControlRegistryError('账号控制授权已失效')
    }
    if (!response.ok) {
      throw new NativeControlRegistryError(`原生代理请求失败（${response.status}）`)
    }
    try {
      return await response.json()
    } catch {
      throw new NativeControlRegistryError('原生代理响应格式无效')
    }
  }

  private async verifyGrant(grant: string): Promise<NativeControlGrantVerification> {
    let response: Response
    try {
      response = await fetch(`${this.serverUrl}/api/native/control-grant/verify`, {
        method: 'POST',
        headers: { Authorization: `${NATIVE_CONTROL_AUTH_SCHEME} ${grant}` },
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      })
    } catch {
      throw new NativeControlRegistryError('无法验证账号控制授权')
    }
    if (!response.ok) throw new NativeControlRegistryError('账号控制授权无效')
    const value = await response.json() as unknown
    if (!record(value)
      || !ACCOUNT_ID.test(String(value.accountId))
      || !['telegram', 'signal', 'whatsapp'].includes(String(value.platform))
      || typeof value.expectedPlatformAccountExternalId !== 'string'
      || value.expectedPlatformAccountExternalId === ''
      || typeof value.expiresAt !== 'string') {
      throw new NativeControlRegistryError('账号控制授权响应无效')
    }
    return value as unknown as NativeControlGrantVerification
  }

  private async revokeGrant(grant: string): Promise<void> {
    try {
      await fetch(`${this.serverUrl}/api/native/control-grant`, {
        method: 'DELETE',
        headers: { Authorization: `${NATIVE_CONTROL_AUTH_SCHEME} ${grant}` },
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      })
    } catch {
      // grant 最多五分钟即过期；本地主进程已经先移除能力，不回显或记录 token。
    }
  }

  private requireLocalGrant(guest: GuestRegistration): string {
    try {
      return this.registry.requireGrant(guest.contents.id, guest.accountId)
    } catch (error) {
      this.sendState(guest, this.registry.stateFor(guest.contents.id, guest.accountId))
      throw error
    }
  }

  private async requireLiveGrant(guest: GuestRegistration): Promise<void> {
    const grant = this.requireLocalGrant(guest)
    try {
      const verification = await this.verifyGrant(grant)
      if (verification.accountId !== guest.accountId) throw new NativeControlRegistryError('账号控制授权无效')
    } catch {
      const state = this.registry.block(guest.contents.id, '账号控制授权已失效')
      if (state) this.sendState(guest, state)
      throw new NativeControlRegistryError('账号控制授权已失效')
    }
  }

  private async clearAccountPartition(accountId: string): Promise<void> {
    const accountSession = session.fromPartition(`persist:native-${accountId}`)
    await accountSession.clearStorageData()
    await accountSession.clearCache()
  }

  private requireTrustedHost(event: IpcMainInvokeEvent): void {
    if (!this.trustedHosts.has(event.sender.id)) {
      throw new NativeControlRegistryError('未授权的宿主调用')
    }
  }

  private requireGuest(accountId: string, guestId: number, hostId: number): GuestRegistration {
    const guest = this.guests.get(guestId)
    if (!guest || guest.accountId !== accountId || guest.hostWebContentsId !== hostId) {
      throw new NativeControlRegistryError('原生客户端与账号不匹配')
    }
    return guest
  }

  private requireGuestSender(event: IpcMainInvokeEvent): GuestRegistration {
    const guest = this.guests.get(event.sender.id)
    if (!guest || guest.contents !== event.sender) {
      throw new NativeControlRegistryError('未登记的原生客户端')
    }
    return guest
  }

  private sendState(guest: GuestRegistration, state: NativeControlStateUpdate): void {
    if (state.state === 'blocked') {
      console.error(
        `[native-control:${guest.accountId.slice(0, 8)}] ${state.message ?? '账号控制能力已阻断'}`,
      )
    }
    webContents.fromId(guest.hostWebContentsId)?.send(NATIVE_CONTROL_STATE_CHANNEL, state)
  }

  private sendGuestEvent(guest: GuestRegistration, event: NativeGuestEvent): void {
    webContents.fromId(guest.hostWebContentsId)?.send(NATIVE_CONTROL_EVENT_CHANNEL, {
      accountId: guest.accountId,
      event,
    })
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseConfigurePayload(value: unknown): ConfigurePayload {
  if (!record(value)
    || !ACCOUNT_ID.test(String(value.accountId))
    || !Number.isSafeInteger(value.guestWebContentsId)
    || (value.guestWebContentsId as number) <= 0
    || typeof value.grant !== 'string'
    || value.grant === ''
    || value.grant.length > MAX_GRANT_LENGTH) {
    throw new NativeControlRegistryError('账号控制配置无效')
  }
  return value as unknown as ConfigurePayload
}

function parseAccountPayload(value: unknown): AccountPayload {
  if (!record(value)
    || !ACCOUNT_ID.test(String(value.accountId))
    || !Number.isSafeInteger(value.guestWebContentsId)
    || (value.guestWebContentsId as number) <= 0) {
    throw new NativeControlRegistryError('账号控制目标无效')
  }
  return value as unknown as AccountPayload
}

function parseProxyPayload(value: unknown): ProxyPayload {
  const account = parseAccountPayload(value)
  if (!record(value) || !('value' in value)) throw new NativeControlRegistryError('原生代理参数无效')
  return { ...account, value: value.value }
}

function parseAccountId(value: unknown): string {
  if (!record(value) || !ACCOUNT_ID.test(String(value.accountId))) {
    throw new NativeControlRegistryError('账号 id 无效')
  }
  return value.accountId as string
}

function parseTranslationBatch(value: unknown): NativeTranslationBatchInput {
  if (!record(value)
    || !Array.isArray(value.texts)
    || value.texts.length < 1
    || value.texts.length > 50
    || !value.texts.every(text => typeof text === 'string' && text.length <= 4_000)
    || typeof value.targetLang !== 'string'
    || value.targetLang.length < 2
    || value.targetLang.length > 12
    || (value.sourceLang !== undefined
      && (typeof value.sourceLang !== 'string'
        || value.sourceLang.length < 2
        || value.sourceLang.length > 12))) {
    throw new NativeControlRegistryError('批量翻译参数无效')
  }
  return value as unknown as NativeTranslationBatchInput
}

function jsonSizeAllowed(value: unknown): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_PROXY_BYTES
  } catch {
    return false
  }
}

function blockedState(accountId: string, message: string): NativeControlStateUpdate {
  return { accountId, state: 'blocked', message, expiresAt: null }
}
