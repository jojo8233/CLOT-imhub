import type { NativeConversationContext } from '@im-hub/shared'
import {
  normalizeSignalDesktopConversationContext,
  type SignalDesktopModelLike,
  type SignalDesktopWindowLike,
} from './signal-desktop-message.js'

const MAX_DRAFT_LENGTH = 1_000_000
const DRAFT_APPLY_ATTEMPTS = 20
const DRAFT_APPLY_INTERVAL_MS = 25

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function modelAttribute(model: SignalDesktopModelLike, key: string): unknown {
  try {
    return model.get?.(key) ?? model.attributes?.[key]
  } catch {
    return model.attributes?.[key]
  }
}

export interface SignalDesktopReduxStoreLike {
  getState(): unknown
  subscribe(listener: () => void): () => void
}

interface SignalDesktopComposerActionsLike {
  onEditorStateChange?(input: {
    bodyRanges: unknown[]
    caretLocation: number
    conversationId: string
    messageText: string
    sendCounter: number
  }): unknown
  setComposerFocus?(conversationId: string): unknown
}

export interface SignalDesktopComposerWindowLike extends SignalDesktopWindowLike {
  reduxStore?: SignalDesktopReduxStoreLike
  reduxActions?: {
    composer?: SignalDesktopComposerActionsLike
  }
}

export interface SignalDesktopComposerSnapshot {
  /** 只在 Signal guest 内使用，绝不进入跨进程事件。 */
  localConversationId: string
  context: NativeConversationContext
  draft: string
  sendCounter: number | null
}

export type SignalDesktopComposerErrorCode =
  | 'signal_context_unavailable'
  | 'stale_signal_context'
  | 'signal_composer_unavailable'
  | 'signal_draft_too_large'
  | 'signal_draft_write_failed'

export class SignalDesktopComposerError extends Error {
  constructor(
    readonly code: SignalDesktopComposerErrorCode,
    readonly safeMessage: string,
  ) {
    super(safeMessage)
    this.name = 'SignalDesktopComposerError'
  }
}

function selectedLocalConversationId(state: unknown): string | null {
  if (!record(state) || !record(state.nav) || !record(state.nav.selectedLocation)) return null
  // 与 Signal 8.25.0 的 getSelectedConversation selector 一致：设置/通话/动态页不能沿用旧聊天。
  if (state.nav.selectedLocation.tab !== 'Chats') return null
  const details = state.nav.selectedLocation.details
  if (!record(details)) return null
  return typeof details.conversationId === 'string' && details.conversationId.trim() !== ''
    ? details.conversationId
    : null
}

function composerSendCounter(state: unknown, conversationId: string): number | null {
  if (!record(state) || !record(state.composer) || !record(state.composer.conversations)) return null
  const composer = state.composer.conversations[conversationId]
  if (!record(composer) || !Number.isSafeInteger(composer.sendCounter)) return null
  const sendCounter = composer.sendCounter as number
  return sendCounter >= 0 ? sendCounter : null
}

/** 只从 Signal 的 Redux 选中态与 ConversationModel 读取，不依赖 DOM。 */
export function readSignalDesktopComposerSnapshot(
  signalWindow: SignalDesktopComposerWindowLike,
): SignalDesktopComposerSnapshot | null {
  const store = signalWindow.reduxStore
  if (!store) return null
  let state: unknown
  try {
    state = store.getState()
  } catch {
    return null
  }
  const localConversationId = selectedLocalConversationId(state)
  if (!localConversationId) return null

  let conversation: SignalDesktopModelLike | undefined
  try {
    conversation = signalWindow.ConversationController?.get?.(localConversationId)
  } catch {
    conversation = undefined
  }
  if (!conversation) return null
  const context = normalizeSignalDesktopConversationContext(conversation)
  if (!context) return null

  const draftValue = modelAttribute(conversation, 'draft')
  const draft = typeof draftValue === 'string' ? draftValue : ''
  if (draft.length > MAX_DRAFT_LENGTH) {
    throw new SignalDesktopComposerError(
      'signal_draft_too_large',
      'Signal 原生草稿超过桥接上限，请先在原生输入框中缩短内容',
    )
  }
  return {
    localConversationId,
    context,
    draft,
    sendCounter: composerSendCounter(state, localConversationId),
  }
}

export function signalComposerSnapshotMatches(
  snapshot: SignalDesktopComposerSnapshot | null,
  platformConversationId: string,
): snapshot is SignalDesktopComposerSnapshot {
  return snapshot?.context.platformConversationId === platformConversationId
}

function waitForDraftPoll(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, DRAFT_APPLY_INTERVAL_MS))
}

/**
 * 使用 Signal 8.25.0 自己的 composer action 更新并持久化草稿。草稿写入期间若切换会话，
 * 立即拒绝旧命令；不直接操作 contenteditable DOM，也不伪造发送动作。
 */
export async function writeSignalDesktopDraft(
  signalWindow: SignalDesktopComposerWindowLike,
  expected: SignalDesktopComposerSnapshot,
  text: string,
): Promise<SignalDesktopComposerSnapshot> {
  const actions = signalWindow.reduxActions?.composer
  if (!actions?.onEditorStateChange || !actions.setComposerFocus) {
    throw new SignalDesktopComposerError(
      'signal_composer_unavailable',
      'Signal 原生输入框尚未准备好，请重新打开当前会话',
    )
  }
  if (text.length > MAX_DRAFT_LENGTH) {
    throw new SignalDesktopComposerError(
      'signal_draft_too_large',
      '待写入译文超过 Signal 草稿桥接上限',
    )
  }

  const before = readSignalDesktopComposerSnapshot(signalWindow)
  if (!before
    || before.localConversationId !== expected.localConversationId
    || before.context.platformConversationId !== expected.context.platformConversationId) {
    throw new SignalDesktopComposerError(
      'stale_signal_context',
      'Signal 当前会话已经变化，旧译文未写入',
    )
  }

  await Promise.resolve(actions.setComposerFocus(before.localConversationId))
  const focused = readSignalDesktopComposerSnapshot(signalWindow)
  if (!signalComposerSnapshotMatches(focused, before.context.platformConversationId)
    || focused.localConversationId !== before.localConversationId
    || focused.sendCounter === null) {
    throw new SignalDesktopComposerError(
      'signal_composer_unavailable',
      'Signal 原生输入框状态尚未准备好，请重试',
    )
  }
  await Promise.resolve(actions.onEditorStateChange({
    bodyRanges: [],
    caretLocation: text.length,
    conversationId: focused.localConversationId,
    messageText: text,
    sendCounter: focused.sendCounter,
  }))

  for (let attempt = 0; attempt < DRAFT_APPLY_ATTEMPTS; attempt += 1) {
    const current = readSignalDesktopComposerSnapshot(signalWindow)
    if (!current
      || current.localConversationId !== focused.localConversationId
      || current.context.platformConversationId !== focused.context.platformConversationId) {
      throw new SignalDesktopComposerError(
        'stale_signal_context',
        'Signal 当前会话已经变化，旧译文未写入',
      )
    }
    if (current.draft === text) return current
    await waitForDraftPoll()
  }
  throw new SignalDesktopComposerError(
    'signal_draft_write_failed',
    'Signal 原生输入框未确认草稿写入，请重试',
  )
}
