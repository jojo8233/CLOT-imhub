import {
  NATIVE_BRIDGE_PROTOCOL_VERSION,
  type NativeCommandName,
  type NativeComposerCommand,
  type NativeCommandResultEvent,
  type NativeGuestEvent,
  type NativeHostCommand,
} from '@im-hub/shared'

export const NATIVE_EVENT_CHANNEL = 'imhub:native-event'
export const NATIVE_COMMAND_CHANNEL = 'imhub:native-command'

const COMMAND_TIMEOUT_MS = 8_000
const MAX_EVENT_BYTES = 900_000

interface CommandTarget {
  send(channel: string, ...args: unknown[]): void
}

interface PendingCommand {
  accountId: string
  command: NativeCommandName
  contextRevision: number
  timer: ReturnType<typeof setTimeout>
  resolve(event: NativeCommandResultEvent): void
  reject(error: Error): void
}

export interface NativeCommandContext {
  accountId: string
  platformConversationId: string
  contextRevision: number
}

export class NativeBridgeCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NativeBridgeCommandError'
  }
}

const targets = new Map<string, CommandTarget>()
const pending = new Map<string, PendingCommand>()

export function registerNativeCommandTarget(accountId: string, target: CommandTarget): () => void {
  targets.set(accountId, target)
  return () => {
    if (targets.get(accountId) !== target) return
    targets.delete(accountId)
    for (const [requestId, command] of pending) {
      if (command.accountId !== accountId) continue
      clearTimeout(command.timer)
      command.reject(new NativeBridgeCommandError('原生客户端桥接已断开'))
      pending.delete(requestId)
    }
  }
}

export function handleNativeCommandResult(accountId: string, event: NativeCommandResultEvent): boolean {
  const command = pending.get(event.requestId)
  if (!command || command.accountId !== accountId) return false
  pending.delete(event.requestId)
  clearTimeout(command.timer)

  if (event.command !== command.command || event.contextRevision !== command.contextRevision) {
    command.reject(new NativeBridgeCommandError('原生客户端返回了过期或不匹配的命令结果'))
    return true
  }
  if (!event.ok) {
    command.reject(new NativeBridgeCommandError(event.error?.message ?? '原生客户端命令执行失败'))
    return true
  }
  command.resolve(event)
  return true
}

async function sendCommand(
  context: NativeCommandContext,
  command: NativeComposerCommand,
): Promise<NativeCommandResultEvent> {
  const target = targets.get(context.accountId)
  if (!target) throw new NativeBridgeCommandError('原生客户端桥接尚未连接')

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(command.requestId)
      reject(new NativeBridgeCommandError('原生客户端响应超时'))
    }, COMMAND_TIMEOUT_MS)
    pending.set(command.requestId, {
      accountId: context.accountId,
      command: command.type,
      contextRevision: context.contextRevision,
      timer,
      resolve,
      reject,
    })
    try {
      target.send(NATIVE_COMMAND_CHANNEL, command)
    } catch (error) {
      clearTimeout(timer)
      pending.delete(command.requestId)
      reject(error instanceof Error ? error : new NativeBridgeCommandError('发送原生客户端命令失败'))
    }
  })
}

function baseCommand(context: NativeCommandContext) {
  return {
    protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    contextRevision: context.contextRevision,
    platformConversationId: context.platformConversationId,
  }
}

export const nativeComposerBridge = {
  async setDraft(context: NativeCommandContext, text: string): Promise<void> {
    await sendCommand(context, { ...baseCommand(context), type: 'composer.set-draft', text })
  },

  async getDraft(context: NativeCommandContext): Promise<string> {
    const result = await sendCommand(context, { ...baseCommand(context), type: 'composer.get-draft' })
    if (typeof result.draft !== 'string') throw new NativeBridgeCommandError('原生客户端没有返回草稿内容')
    return result.draft
  },

  async send(context: NativeCommandContext): Promise<string> {
    const result = await sendCommand(context, { ...baseCommand(context), type: 'composer.send' })
    if (!result.platformMessageId) throw new NativeBridgeCommandError('原生客户端没有返回最终消息 ID')
    return result.platformMessageId
  },
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function string(value: unknown, max = 1_000_000): value is string {
  return typeof value === 'string' && value.length <= max
}

function nonEmptyString(value: unknown, max: number): value is string {
  return string(value, max) && value.trim().length > 0
}

function nullableString(value: unknown, max = 4_096): boolean {
  return value === null || string(value, max)
}

function jsonRecord(value: unknown): boolean {
  if (!record(value)) return false
  try {
    // raw 来自不可信 guest。提前拒绝 BigInt/循环引用等无法进入 HTTP JSON 的值，
    // 同时限制单条 raw 元数据，避免序列化时无界占用外壳内存。
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 256_000
  } catch {
    return false
  }
}

function mediaRef(value: unknown): boolean {
  if (!record(value)
    || !['image', 'video', 'audio', 'file', 'sticker'].includes(String(value.kind))
    || !nonEmptyString(value.remoteId, 512)
    || (value.fileName !== undefined && !string(value.fileName, 1_024))
    || (value.mimeType !== undefined && !string(value.mimeType, 256))) return false
  return value.sizeBytes === undefined
    || (Number.isSafeInteger(value.sizeBytes) && (value.sizeBytes as number) >= 0)
}

/** webview 页面不可信；只有通过这层最小运行时校验的事件才会进入外壳或服务端。 */
export function parseNativeGuestEvent(value: unknown): NativeGuestEvent | null {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_EVENT_BYTES) return null
  } catch {
    return null
  }
  if (!record(value) || value.protocolVersion !== NATIVE_BRIDGE_PROTOCOL_VERSION || !string(value.type, 64)) {
    return null
  }

  switch (value.type) {
    case 'bridge.ready':
      return value as unknown as NativeGuestEvent
    case 'context.changed': {
      if (!Number.isSafeInteger(value.contextRevision) || (value.contextRevision as number) < 0) return null
      if (value.context === null) return value as unknown as NativeGuestEvent
      if (!record(value.context)
        || !nonEmptyString(value.context.platformConversationId, 512)
        || !nonEmptyString(value.context.contactExternalId, 512)
        || !nullableString(value.context.contactDisplayName, 512)) return null
      return value as unknown as NativeGuestEvent
    }
    case 'composer.state':
      if (!Number.isSafeInteger(value.contextRevision)
        || !string(value.platformConversationId, 512)
        || !string(value.draft)
        || typeof value.canSend !== 'boolean') return null
      return value as unknown as NativeGuestEvent
    case 'command.result':
      if (!string(value.requestId, 128)
        || !['composer.set-draft', 'composer.get-draft', 'composer.send'].includes(String(value.command))
        || !Number.isSafeInteger(value.contextRevision)
        || typeof value.ok !== 'boolean'
        || (value.draft !== undefined && !string(value.draft))
        || (value.platformMessageId !== undefined && !nonEmptyString(value.platformMessageId, 512))
        || (value.error !== undefined && (!record(value.error)
          || !nonEmptyString(value.error.code, 128)
          || !string(value.error.message, 2_048)))) return null
      return value as unknown as NativeGuestEvent
    case 'bridge.error':
      if (!nonEmptyString(value.code, 128) || !string(value.message, 2_048)) return null
      return value as unknown as NativeGuestEvent
    case 'message.upsert': {
      if (!nonEmptyString(value.eventId, 128) || !record(value.message)) return null
      const message = value.message
      if (!nonEmptyString(message.platformConversationId, 512)
        || !nonEmptyString(message.platformMessageId, 512)
        || (message.direction !== 'in' && message.direction !== 'out')
        || !nonEmptyString(message.senderExternalId, 512)
        || !nullableString(message.senderDisplayName, 512)
        || !nullableString(message.conversationDisplayName, 512)
        || !string(message.body)
        || !Array.isArray(message.mediaRefs) || message.mediaRefs.length > 64
        || !message.mediaRefs.every(mediaRef)
        || !nullableString(message.replyToPlatformMessageId, 512)
        || !string(message.sentAt, 64)
        || !nullableString(message.editedAt, 64)
        || !jsonRecord(message.raw)) return null
      return value as unknown as NativeGuestEvent
    }
    case 'message.deleted':
      if (!nonEmptyString(value.eventId, 128)
        || !nonEmptyString(value.platformMessageId, 512)
        || !string(value.deletedAt, 64)) return null
      return value as unknown as NativeGuestEvent
    case 'message.id-remapped':
      if (!nonEmptyString(value.eventId, 128)
        || !nonEmptyString(value.oldPlatformMessageId, 512)
        || !nonEmptyString(value.newPlatformMessageId, 512)) return null
      return value as unknown as NativeGuestEvent
  }
  return null
}
