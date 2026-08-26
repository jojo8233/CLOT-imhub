import type { KeyboardEvent } from 'react'
import { api, getCurrentUser } from '../api/client.js'
import {
  nativeComposerBridge,
  NativeBridgeCommandError,
  type NativeCommandContext,
} from '../native-bridge.js'
import { useStore, type NativeDraftStatus } from '../store.js'
import { PLATFORM_LABEL, theme } from '../theme.js'
import { Chip } from './ui.js'
import { nativeAccountControllable } from './NativeClient.js'

const TARGET_LANGS = [
  ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'],
  ['it', 'Italiano'], ['pt', 'Português'], ['ja', '日本語'], ['ko', '한국어'],
  ['ru', 'Русский'], ['ar', 'العربية'], ['th', 'ไทย'], ['vi', 'Tiếng Việt'],
] as const

const STATUS_LABEL: Record<NativeDraftStatus, string> = {
  idle: '等待输入', configuring: '正在更新回复语言', translating: '翻译中', ready: '已写入原生输入框',
  sending: '发送中', failed: '操作失败',
}

export function nativeDraftKey(accountId: string, conversationId: string): string {
  return `${accountId}:${conversationId}`
}

/** 发送事实始终取自原生输入框；外壳缓存的 translatedText 只用于门禁。 */
export async function sendCurrentNativeDraft(
  context: NativeCommandContext,
  bridge: Pick<typeof nativeComposerBridge, 'getDraft' | 'send'> = nativeComposerBridge,
  canContinue: () => boolean = () => true,
  resolveAttemptId: (finalDraft: string) => string = () => crypto.randomUUID(),
  existingAttemptId?: string,
): Promise<string | null> {
  // 上一次已进入 guest 但 host 未在超时内拿到结论时，原生 Composer 通常已经
  // 清空输入框。此时直接用同一 attempt 查询结果，不能先用空草稿把重试挡掉。
  if (existingAttemptId) {
    if (!canContinue()) return null
    return bridge.send(context, existingAttemptId)
  }
  const finalDraft = await bridge.getDraft(context)
  if (!finalDraft.trim()) throw new Error('原生输入框为空，未发送')
  // getDraft 等待期间用户可能已经切到另一个账号/会话。必须在真正发送前
  // 再验证一次，不能因为旧请求终于返回就把当前原生框发出去。
  if (!canContinue()) return null
  return bridge.send(context, resolveAttemptId(finalDraft))
}

/** 固定在原生客户端下方、通过 NativeComposerBridge 控制平台原生输入框。 */
export function TranslationDock() {
  const accounts = useStore(s => s.accounts)
  const conversations = useStore(s => s.conversations)
  const activeAccountId = useStore(s => s.activeAccountId)
  const native = useStore(s => activeAccountId ? s.nativeBridgeByAccount[activeAccountId] : undefined)
  const active = accounts.find(account => account.id === activeAccountId) ?? null
  const context = native?.context ?? null
  const key = activeAccountId && context?.conversationId
    ? nativeDraftKey(activeAccountId, context.conversationId)
    : null
  const draft = useStore(s => key ? s.nativeDrafts[key] : undefined)
  const updateDraft = useStore(s => s.updateNativeDraft)
  const clearDraft = useStore(s => s.clearNativeDraft)
  const updateConversationTargetLang = useStore(s => s.updateConversationTargetLang)
  const conversation = conversations.find(item => item.id === context?.conversationId) ?? null
  const currentUser = getCurrentUser()
  const readOnly = currentUser?.role === 'auditor'
  const canControlAccount = nativeAccountControllable(active, currentUser)

  const unavailableReason = !active
    ? '先选择或添加当前平台账号'
    : readOnly
      ? '风控账号是只读的，不能操作原生输入框'
    : !canControlAccount
      ? '这个平台账号不属于当前用户，不能操作原生输入框'
    : native?.connection === 'failed'
      ? native.error ?? '原生客户端桥接失败'
      : native?.connection !== 'ready'
        ? `等待 ${PLATFORM_LABEL[active.platform] ?? active.platform} 原生输入桥接`
        : !context
          ? '请先在原生客户端中打开一个会话'
          : !context.conversationId
            ? '正在同步当前会话'
            : null

  const busy = draft?.status === 'configuring'
    || draft?.status === 'translating'
    || draft?.status === 'sending'
  const canUse = unavailableReason === null && key !== null && context !== null && activeAccountId !== null
  const canResolveUnknownAttempt = draft?.status === 'failed' && Boolean(draft.sendAttemptId)
  const canSend = canUse
    && !busy
    && Boolean(draft?.translatedText)
    && (Boolean(native?.composerCanSend) || canResolveUnknownAttempt)
  const targetLang = conversation?.target_lang ?? null

  function commandContext(): NativeCommandContext | null {
    if (!canUse || !activeAccountId || !context) return null
    return {
      accountId: activeAccountId,
      platformConversationId: context.platformConversationId,
      contextRevision: context.contextRevision,
    }
  }

  function contextStillCurrent(captured: NativeCommandContext): boolean {
    const state = useStore.getState()
    const current = state.nativeBridgeByAccount[captured.accountId]?.context
    return state.activeAccountId === captured.accountId
      && current?.platformConversationId === captured.platformConversationId
      && current.contextRevision === captured.contextRevision
  }

  function continueOrReset(captured: NativeCommandContext, draftKey: string): boolean {
    if (contextStillCurrent(captured)) return true
    // 切会话时保留各自草稿但解除 busy；登出已经 reset 后不能被迟到 promise
    // 重新创建上一个用户的 key。
    if (useStore.getState().nativeDrafts[draftKey]) {
      updateDraft(draftKey, { status: 'idle', error: null })
    }
    return false
  }

  async function translate(): Promise<void> {
    const command = commandContext()
    if (!command || !context?.conversationId || !key || !draft?.sourceText.trim()) return
    updateDraft(key, { status: 'translating', error: null })
    try {
      const result = await api.translatePreview(context.conversationId, draft.sourceText)
      if (!continueOrReset(command, key)) return
      await nativeComposerBridge.setDraft(command, result.translated)
      if (!continueOrReset(command, key)) return
      updateDraft(key, {
        translatedText: result.translated,
        backTranslated: result.backTranslated,
        targetLang: result.targetLang,
        status: 'ready',
        error: null,
        sendAttemptId: null,
        sendAttemptDraft: null,
      })
    } catch (error) {
      if (!continueOrReset(command, key)) return
      updateDraft(key, {
        status: 'failed',
        error: error instanceof Error ? error.message : '翻译或写入原生输入框失败',
      })
    }
  }

  async function send(): Promise<void> {
    const command = commandContext()
    if (!command || !key) return
    updateDraft(key, { status: 'sending', error: null })
    try {
      // 发送前重新读取原生输入框。员工可能已经在那里做过最后修改，外壳缓存的
      // translatedText 不能作为最终发送事实来源。
      const platformMessageId = await sendCurrentNativeDraft(
        command,
        nativeComposerBridge,
        () => continueOrReset(command, key),
        (finalDraft) => {
          const current = useStore.getState().nativeDrafts[key]
          const attemptId = current?.sendAttemptId && current.sendAttemptDraft === finalDraft
            ? current.sendAttemptId
            : crypto.randomUUID()
          updateDraft(key, { sendAttemptId: attemptId, sendAttemptDraft: finalDraft })
          return attemptId
        },
        draft?.sendAttemptId ?? undefined,
      )
      if (platformMessageId === null) return
      if (!continueOrReset(command, key)) return
      clearDraft(key)
    } catch (error) {
      if (!continueOrReset(command, key)) return
      const isResultUnknown = error instanceof NativeBridgeCommandError
        && [
          'result_unknown',
          'attempt_context_mismatch',
          'partial_send_failed',
          'stale_command_result',
          'attempt_mismatch',
          'missing_message_id',
          'bridge_disconnected',
        ].includes(error.code)
      updateDraft(key, {
        status: 'failed',
        error: error instanceof Error ? error.message : '原生发送失败',
        sendAttemptId: isResultUnknown
          ? useStore.getState().nativeDrafts[key]?.sendAttemptId ?? null
          : null,
        sendAttemptDraft: isResultUnknown
          ? useStore.getState().nativeDrafts[key]?.sendAttemptDraft ?? null
          : null,
      })
    }
  }

  async function changeTargetLang(value: string): Promise<void> {
    const command = commandContext()
    if (!command || !context?.conversationId || !key) return
    const next = value || null
    updateDraft(key, { status: 'configuring', error: null })
    try {
      await api.updateTargetLang(context.conversationId, next)
      if (!continueOrReset(command, key)) return
      updateConversationTargetLang(context.conversationId, next)
      updateDraft(key, {
        targetLang: next,
        status: 'idle',
        translatedText: '',
        error: null,
        sendAttemptId: null,
        sendAttemptDraft: null,
      })
    } catch (error) {
      if (!continueOrReset(command, key)) return
      updateDraft(key, {
        status: 'failed',
        error: error instanceof Error ? error.message : '更新回复语言失败',
      })
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (!shouldTranslateOnKeyDown({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.nativeEvent.keyCode,
    })) return
    event.preventDefault()
    void translate()
  }

  return (
    <section style={{
      flexShrink: 0, padding: `${theme.space.sm}px ${theme.space.md}px ${theme.space.md}px`,
      borderTop: `1px solid ${theme.color.border}`, background: theme.color.chat,
    }}>
      <div style={{
        maxWidth: 760, margin: '0 auto', padding: `${theme.space.md}px ${theme.space.lg}px`,
        border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.xl,
        background: theme.color.card, boxShadow: theme.shadow.md,
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: theme.space.md, marginBottom: 6,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: theme.font.size.xs, color: theme.color.textFaint, fontWeight: theme.font.weight.bold,
          }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: canUse ? theme.color.limeDeep : theme.color.textFaint }} />
            中文原文
          </div>
          <Chip
            tone="muted"
            style={{
              border: `1px dashed ${theme.color.borderStrong}`,
              ...(draft?.status === 'failed' ? { color: theme.color.danger } : {}),
            }}
          >
            {unavailableReason ?? STATUS_LABEL[draft?.status ?? 'idle']}
          </Chip>
        </div>

        <textarea
          disabled={!canUse || busy}
          value={draft?.sourceText ?? ''}
          onChange={(event) => {
            if (!key) return
            updateDraft(key, {
              sourceText: event.target.value,
              translatedText: '', backTranslated: null, status: 'idle', error: null,
              sendAttemptId: null, sendAttemptDraft: null,
            })
          }}
          onKeyDown={handleKeyDown}
          aria-label="中文原文"
          placeholder="输入中文，回车翻译（Shift+回车换行）"
          style={{
            width: '100%', height: 54, resize: 'none', padding: '10px 14px',
            border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.lg,
            background: theme.color.white, color: theme.color.text,
            fontFamily: theme.font.sans, fontSize: theme.font.size.md, lineHeight: 1.5,
          }}
        />

        {(draft?.backTranslated || draft?.error || native?.error) && (
          <div style={{
            marginTop: 7, fontSize: theme.font.size.xs,
            color: draft?.error ? theme.color.danger : theme.color.textMuted,
          }}>
            {draft?.error
              ? draft.error
              : draft?.backTranslated
                ? `回译检查：${draft.backTranslated}`
                : native?.error}
          </div>
        )}

        <div style={{
          display: 'flex', alignItems: 'center', gap: theme.space.sm,
          marginTop: theme.space.md, paddingTop: theme.space.md,
          borderTop: `1px solid ${theme.color.border}`,
        }}>
          <span style={{ fontSize: theme.font.size.xs, color: theme.color.textFaint }}>回复语言</span>
          <select
            disabled={!canUse || busy}
            value={targetLang ?? ''}
            onChange={(event) => { void changeTargetLang(event.target.value) }}
            aria-label="回复语言"
            style={{
              height: 30, minWidth: 110, padding: '0 28px 0 10px',
              border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.pill,
              background: theme.color.white, color: theme.color.textMuted,
              fontSize: theme.font.size.sm,
            }}
          >
            <option value="">自动</option>
            {TARGET_LANGS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select>
          <Chip tone="muted">{targetLang ? `🔒 ${targetLang}` : '🔓 自动'}</Chip>

          <div style={{ flex: 1 }} />
          <button
            disabled={!canUse || busy || !draft?.sourceText.trim()}
            onClick={() => { void translate() }}
            style={secondaryButton}
          >
            翻译
          </button>
          <button disabled={!canSend} onClick={() => { void send() }} style={primaryButton}>
            发送
          </button>
        </div>
      </div>
    </section>
  )
}

export function shouldTranslateOnKeyDown(event: {
  key: string
  shiftKey: boolean
  isComposing: boolean
  keyCode?: number
}): boolean {
  // 中文 IME 用 Enter 确认候选词时不能触发翻译。Safari/部分 Electron
  // 组合输入还会用 229 表示 composing，两层都挡。
  return event.key === 'Enter'
    && !event.shiftKey
    && !event.isComposing
    && event.keyCode !== 229
}

const secondaryButton = {
  height: 34, padding: '0 16px', border: 'none', background: 'transparent',
  color: theme.color.textMuted, fontSize: theme.font.size.base,
}

const primaryButton = {
  height: 36, padding: '0 20px', border: 'none', borderRadius: theme.radius.pill,
  background: theme.color.ink, color: theme.color.lime,
  fontSize: theme.font.size.base, fontWeight: theme.font.weight.bold,
}
