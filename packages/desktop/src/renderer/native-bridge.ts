import {
  NATIVE_BRIDGE_PROTOCOL_VERSION,
  type NativeCommandName,
  type NativeComposerCommand,
  type NativeCommandResultEvent,
  type NativeOutboxOperationCommand,
  type NativeSendAttemptAckCommand,
} from '@im-hub/shared'
export { parseNativeGuestEvent } from '../native-bridge-runtime.js'

export const NATIVE_COMMAND_CHANNEL = 'imhub:native-command'

const COMMAND_TIMEOUT_MS = 8_000

interface CommandTarget {
  send(channel: string, ...args: unknown[]): void | Promise<void>
}

interface PendingCommand {
  accountId: string
  command: NativeCommandName
  contextRevision: number
  attemptId: string | null
  timer: ReturnType<typeof setTimeout> | null
  resolve(event: NativeCommandResultEvent): void
  reject(error: Error): void
}

export interface NativeCommandContext {
  accountId: string
  platformConversationId: string
  contextRevision: number
}

export class NativeBridgeCommandError extends Error {
  constructor(message: string, readonly code = 'bridge_command_failed') {
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
      if (command.timer) clearTimeout(command.timer)
      command.reject(new NativeBridgeCommandError('原生客户端桥接已断开', 'bridge_disconnected'))
      pending.delete(requestId)
    }
  }
}

async function sendOutboxOperation(
  accountId: string,
  type: NativeOutboxOperationCommand['type'],
): Promise<void> {
  const target = targets.get(accountId)
  if (!target) throw new NativeBridgeCommandError('原生客户端桥接尚未连接', 'bridge_disconnected')
  await target.send(NATIVE_COMMAND_CHANNEL, {
    protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
    type,
  } satisfies NativeOutboxOperationCommand)
}

export const nativeOutboxBridge = {
  retryDeadLetters: (accountId: string): Promise<void> =>
    sendOutboxOperation(accountId, 'outbox.retry-dead-letters'),
  discardDeadLetters: (accountId: string): Promise<void> =>
    sendOutboxOperation(accountId, 'outbox.discard-dead-letters'),
}

export function handleNativeCommandResult(accountId: string, event: NativeCommandResultEvent): boolean {
  const command = pending.get(event.requestId)
  if (!command || command.accountId !== accountId) return false
  pending.delete(event.requestId)
  if (command.timer) clearTimeout(command.timer)

  if (event.command !== command.command || event.contextRevision !== command.contextRevision) {
    command.reject(new NativeBridgeCommandError(
      '原生客户端返回了过期或不匹配的命令结果',
      'stale_command_result',
    ))
    return true
  }
  if (command.command === 'composer.send' && event.attemptId !== command.attemptId) {
    command.reject(new NativeBridgeCommandError(
      '原生客户端返回了不匹配的发送 attemptId',
      'attempt_mismatch',
    ))
    return true
  }
  if (!event.ok) {
    command.reject(new NativeBridgeCommandError(
      event.error?.message ?? '原生客户端命令执行失败',
      event.error?.code ?? 'guest_command_failed',
    ))
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
  if (!target) throw new NativeBridgeCommandError('原生客户端桥接尚未连接', 'bridge_disconnected')

  return new Promise((resolve, reject) => {
    const pendingCommand: PendingCommand = {
      accountId: context.accountId,
      command: command.type,
      contextRevision: context.contextRevision,
      attemptId: command.type === 'composer.send' ? command.attemptId : null,
      timer: null,
      resolve,
      reject,
    }
    pending.set(command.requestId, pendingCommand)
    try {
      void Promise.resolve(target.send(NATIVE_COMMAND_CHANNEL, command))
        .then(() => {
          if (!pending.has(command.requestId)) return
          // 主进程会先实时验证 grant；8 秒只计算命令已经进入 guest 后等待结果的时间，
          // 避免授权服务短暂变慢时外壳先报超时、主进程随后才把发送命令交给页面。
          pendingCommand.timer = setTimeout(() => {
            pending.delete(command.requestId)
            reject(new NativeBridgeCommandError('原生客户端响应超时，发送结果未知', 'result_unknown'))
          }, COMMAND_TIMEOUT_MS)
        })
        .catch((error: unknown) => {
          if (pendingCommand.timer) clearTimeout(pendingCommand.timer)
          pending.delete(command.requestId)
          reject(error instanceof Error
            ? error
            : new NativeBridgeCommandError('发送原生客户端命令失败', 'command_delivery_failed'))
        })
    } catch (error) {
      if (pendingCommand.timer) clearTimeout(pendingCommand.timer)
      pending.delete(command.requestId)
      reject(error instanceof Error
        ? error
        : new NativeBridgeCommandError('发送原生客户端命令失败', 'command_delivery_failed'))
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
    if (typeof result.draft !== 'string') {
      throw new NativeBridgeCommandError('原生客户端没有返回草稿内容', 'missing_draft')
    }
    return result.draft
  },

  async send(
    context: NativeCommandContext,
    attemptId: string = crypto.randomUUID(),
    draftFingerprint?: string,
    attemptContextRevision?: number,
  ): Promise<string> {
    if (attemptId.trim() === '' || attemptId.length > 128) {
      throw new NativeBridgeCommandError('发送 attemptId 无效', 'invalid_attempt')
    }
    const result = await sendCommand(context, {
      ...baseCommand(context),
      type: 'composer.send',
      attemptId,
      ...(draftFingerprint !== undefined ? { draftFingerprint } : {}),
      ...(attemptContextRevision !== undefined ? { attemptContextRevision } : {}),
    })
    if (!result.platformMessageId) {
      throw new NativeBridgeCommandError('原生客户端没有返回最终消息 ID', 'missing_message_id')
    }
    return result.platformMessageId
  },

  async acknowledgeSend(
    accountId: string,
    attemptId: string,
    platformMessageId: string,
  ): Promise<void> {
    const target = targets.get(accountId)
    if (!target) throw new NativeBridgeCommandError('原生客户端桥接尚未连接', 'bridge_disconnected')
    await target.send(NATIVE_COMMAND_CHANNEL, {
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'composer.ack-send',
      attemptId,
      platformMessageId,
    } satisfies NativeSendAttemptAckCommand)
  },
}
