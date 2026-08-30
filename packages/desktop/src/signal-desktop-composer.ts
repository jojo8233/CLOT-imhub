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
  setComposerFocus?(conversationId: string): unknown
}

interface SignalDesktopComposerEditorBridge {
  conversationId: string
  readDraft?(): unknown
  setDraft?(text: string): unknown
  /** 调用 Signal 8.25.0 CompositionInput.inputApi.submit；timestamp 由 attempt 账本固定。 */
  submit?(timestamp: number): unknown
}

export interface SignalDesktopComposerWindowLike extends SignalDesktopWindowLike {
  reduxStore?: SignalDesktopReduxStoreLike
  reduxActions?: {
    composer?: SignalDesktopComposerActionsLike
  }
  /** 由 8.25.0 CompositionInput 内部注册，只引用当前可见编辑器，不查询 DOM。 */
  __imHubSignalComposerEditor?: SignalDesktopComposerEditorBridge
}

export interface SignalDesktopComposerSnapshot {
  /** 只在 Signal guest 内使用，绝不进入跨进程事件。 */
  localConversationId: string
  context: NativeConversationContext
  /** 当前可见 CompositionInput 的正文；编辑器尚未注册时退回 Signal 模型草稿。 */
  draft: string
  /** Signal ConversationModel 中已经持久化的草稿，用于拒绝可见层假成功。 */
  persistedDraft: string
  sendCounter: number | null
  /** 只允许纯文字新消息；附件、引用、编辑和 view-once 继续交给 Signal 原生 UI。 */
  canSendPlainText: boolean
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

function composerHasUnsupportedSendState(state: unknown, conversationId: string): boolean {
  if (!record(state) || !record(state.composer) || !record(state.composer.conversations)) return true
  const composer = state.composer.conversations[conversationId]
  if (!record(composer)) return true
  return !Array.isArray(composer.attachments)
    || composer.attachments.length > 0
    || composer.isViewOnce === true
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
  const persistedDraft = typeof draftValue === 'string' ? draftValue : ''
  const editor = signalWindow.__imHubSignalComposerEditor
  let draft = persistedDraft
  if (editor?.conversationId === localConversationId && editor.readDraft) {
    try {
      const visibleDraft = editor.readDraft()
      if (typeof visibleDraft === 'string') draft = visibleDraft
    } catch {
      // 编辑器正在重建时保留模型事实；写命令仍会要求可见接口可调用。
    }
  }
  if (draft.length > MAX_DRAFT_LENGTH || persistedDraft.length > MAX_DRAFT_LENGTH) {
    throw new SignalDesktopComposerError(
      'signal_draft_too_large',
      'Signal 原生草稿超过桥接上限，请先在原生输入框中缩短内容',
    )
  }
  const hasUnsupportedModelState = (Array.isArray(modelAttribute(conversation, 'draftAttachments'))
    ? (modelAttribute(conversation, 'draftAttachments') as unknown[]).length > 0
    : modelAttribute(conversation, 'draftAttachments') != null)
    || modelAttribute(conversation, 'draftEditMessage') != null
    || modelAttribute(conversation, 'quotedMessageId') != null
    || modelAttribute(conversation, 'draftIsViewOnce') === true
  return {
    localConversationId,
    context,
    draft,
    persistedDraft,
    sendCounter: composerSendCounter(state, localConversationId),
    canSendPlainText: draft.trim() !== ''
      && draft === persistedDraft
      && editor?.conversationId === localConversationId
      && typeof editor.submit === 'function'
      && !composerHasUnsupportedSendState(state, localConversationId)
      && !hasUnsupportedModelState,
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
 * 使用 Signal 8.25.0 CompositionInput 自己的 inputApi 更新可见编辑器，再沿它原有的
 * onEditorStateChange 路径持久化草稿。草稿写入期间若切换会话，立即拒绝旧命令；
 * 不查询或直接操作 contenteditable DOM，也不伪造发送动作。
 */
export async function writeSignalDesktopDraft(
  signalWindow: SignalDesktopComposerWindowLike,
  expected: SignalDesktopComposerSnapshot,
  text: string,
): Promise<SignalDesktopComposerSnapshot> {
  const actions = signalWindow.reduxActions?.composer
  if (!actions?.setComposerFocus) {
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
    || focused.localConversationId !== before.localConversationId) {
    throw new SignalDesktopComposerError(
      'signal_composer_unavailable',
      'Signal 原生输入框状态尚未准备好，请重试',
    )
  }
  const editor = signalWindow.__imHubSignalComposerEditor
  if (editor?.conversationId !== focused.localConversationId
    || !editor.setDraft || !editor.readDraft) {
    throw new SignalDesktopComposerError(
      'signal_composer_unavailable',
      'Signal 可见输入框尚未准备好，请重新打开当前会话',
    )
  }
  const accepted = await Promise.resolve(editor.setDraft(text))
  if (accepted !== true) {
    throw new SignalDesktopComposerError(
      'signal_draft_write_failed',
      'Signal 可见输入框拒绝草稿写入，请重试',
    )
  }

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
    if (current.draft === text && current.persistedDraft === text) return current
    await waitForDraftPoll()
  }
  throw new SignalDesktopComposerError(
    'signal_draft_write_failed',
    'Signal 原生输入框未确认草稿写入，请重试',
  )
}
