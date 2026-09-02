import { useEffect, useRef, useState } from 'react'
import { api, HttpError } from '../api/client.js'
import { useStore } from '../store.js'
import { CHAT_MAX_WIDTH } from '../layout.js'
import { theme } from '../theme.js'

const LANG_OPTIONS: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'th', label: 'ไทย' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' },
  { code: 'ar', label: 'العربية' },
  { code: 'zh', label: '中文' },
]

/** 翻译完成瞬间连击回车会被这个挡下——正常读一句译文要一两秒，感觉不到它存在。 */
const SEND_LOCK_MS = 300
/** 手动改英文预览后，等打字告一段落再重新拉回译对照，不然每敲一个字都发请求。 */
const BACK_TRANSLATE_DEBOUNCE_MS = 600

export function Composer() {
  const conversationId = useStore(s => s.activeConversationId)
  const conversations = useStore(s => s.conversations)
  const updateConversationTargetLang = useStore(s => s.updateConversationTargetLang)
  const conv = conversations.find(c => c.id === conversationId)

  const [zh, setZh] = useState('')
  const [preview, setPreview] = useState('')
  // 生成当前预览时用的中文原文快照——悬停对比用它，不用实时的 zh（员工可能已经在改下一句）。
  const [previewSourceZh, setPreviewSourceZh] = useState('')
  const [backTranslated, setBackTranslated] = useState<string | null>(null)
  const [manuallyEdited, setManuallyEdited] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [backTranslating, setBackTranslating] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendLocked, setSendLocked] = useState(false)
  // null = 自动跟随客户语言（会话锁定值）
  const [lockedLang, setLockedLang] = useState<string | null>(null)
  // 当前实际生效的目标语言：锁定时等于 lockedLang，自动跟随时来自最近一次 translate-preview 响应。
  const [resolvedLang, setResolvedLang] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [justSent, setJustSent] = useState<string | null>(null)
  const [hovering, setHovering] = useState(false)

  const previewRef = useRef<HTMLTextAreaElement>(null)
  // 单调递增的请求代号：任何新动作（重新翻译/回译刷新/发送/切会话）都会让更早的在途响应作废，
  // 防止「请求还在飞的时候切了会话」把结果写到错误的会话状态上。
  const reqIdRef = useRef(0)
  const backTranslateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sendLockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Cloud API 的网络失败可能是“Meta 已接受但响应丢失”。正文/会话不变时重试必须沿用同一 id。
  const sendAttemptIdRef = useRef<string | null>(null)

  // 切换会话：作废所有在途请求，清空上一个会话残留的中文草稿/预览/回译/语言状态，
  // 否则会串到新会话里去。
  useEffect(() => {
    reqIdRef.current++
    if (backTranslateTimerRef.current) clearTimeout(backTranslateTimerRef.current)
    if (sendLockTimerRef.current) clearTimeout(sendLockTimerRef.current)
    setZh('')
    setPreview('')
    setPreviewSourceZh('')
    setBackTranslated(null)
    setManuallyEdited(false)
    setTranslating(false)
    setBackTranslating(false)
    setSending(false)
    setSendLocked(false)
    setError(null)
    setJustSent(null)
    sendAttemptIdRef.current = null
    setLockedLang(conv?.target_lang ?? null)
    setResolvedLang(conv?.target_lang ?? null)
    // conv 是从 conversations 数组按 id 过滤出来的引用，每次渲染都会变；
    // 这里只想在 conversationId 真正变化时重置，用 conv 会导致列表刷新就误触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  // 卸载时清掉定时器，避免组件已经不在了还去 setState。
  useEffect(() => () => {
    if (backTranslateTimerRef.current) clearTimeout(backTranslateTimerRef.current)
    if (sendLockTimerRef.current) clearTimeout(sendLockTimerRef.current)
  }, [])

  function clearPreviewState(): void {
    setPreview('')
    setPreviewSourceZh('')
    setBackTranslated(null)
    setManuallyEdited(false)
    setSendLocked(false)
    if (sendLockTimerRef.current) clearTimeout(sendLockTimerRef.current)
    sendAttemptIdRef.current = null
  }

  async function handleTranslate(): Promise<void> {
    if (!conversationId || zh.trim() === '' || translating) return
    const myReqId = ++reqIdRef.current
    sendAttemptIdRef.current = null
    setTranslating(true)
    setError(null)
    setJustSent(null)
    try {
      const res = await api.translatePreview(conversationId, zh)
      if (reqIdRef.current !== myReqId) return // 会话已切换或被更新的动作取代，丢弃
      setPreview(res.translated)
      setPreviewSourceZh(zh)
      setBackTranslated(res.backTranslated)
      setResolvedLang(res.targetLang)
      setManuallyEdited(false) // 全新翻译结果，清掉「已手动修改」标记
      setTranslating(false)
      setSendLocked(true)
      if (sendLockTimerRef.current) clearTimeout(sendLockTimerRef.current)
      sendLockTimerRef.current = setTimeout(() => setSendLocked(false), SEND_LOCK_MS)
      // 翻译完成后焦点自动移到预览框——员工按第二下回车时，光标已经在该读的内容上。
      requestAnimationFrame(() => {
        previewRef.current?.focus()
        previewRef.current?.select()
      })
    } catch (e) {
      if (reqIdRef.current !== myReqId) return
      setTranslating(false)
      setError(e instanceof Error ? `翻译失败：${e.message}` : '翻译失败，请重试')
    }
  }

  function scheduleBackTranslateRefresh(text: string): void {
    if (backTranslateTimerRef.current) clearTimeout(backTranslateTimerRef.current)
    backTranslateTimerRef.current = setTimeout(() => { void refreshBackTranslation(text) }, BACK_TRANSLATE_DEBOUNCE_MS)
  }

  // 只用来刷新回译对照，不覆盖员工手改的预览文本——即使服务端顺手把 text 又“正向翻译”了一遍，
  // 这里也只取 backTranslated。
  async function refreshBackTranslation(text: string): Promise<void> {
    if (!conversationId || text.trim() === '') return
    const myReqId = ++reqIdRef.current
    setBackTranslating(true)
    try {
      const res = await api.translatePreview(conversationId, text)
      if (reqIdRef.current !== myReqId) return
      setBackTranslated(res.backTranslated)
      setResolvedLang(res.targetLang)
    } catch {
      if (reqIdRef.current !== myReqId) return
      setBackTranslated(null) // 刷新失败，退化成「回译不可用」，不影响发送
    } finally {
      if (reqIdRef.current === myReqId) setBackTranslating(false)
    }
  }

  function handlePreviewChange(value: string): void {
    setPreview(value)
    setManuallyEdited(true)
    // 用户改稿后 fingerprint 已变化，旧 attempt 绝不能跟着新正文走。
    sendAttemptIdRef.current = null
    scheduleBackTranslateRefresh(value)
  }

  async function handleSend(): Promise<void> {
    if (!conversationId || preview.trim() === '' || sending || sendLocked) return
    const myReqId = ++reqIdRef.current
    setSending(true)
    setError(null)
    const attemptId = sendAttemptIdRef.current ?? crypto.randomUUID()
    sendAttemptIdRef.current = attemptId
    try {
      // preTranslated: true + 预览框里的最终文本——绝不让服务端重新翻译，
      // 否则员工确认过的内容和实际发出的内容可能不一样。
      const res = await api.send(conversationId, preview, {
        preTranslated: true,
        targetLang: resolvedLang ?? undefined,
        attemptId,
      })
      if (reqIdRef.current !== myReqId) return
      setJustSent(res.sentText)
      setZh('')
      clearPreviewState()
    } catch (e) {
      if (reqIdRef.current !== myReqId) return
      // Meta 明确拒绝时可以用新 attempt 重试；网络/结果未知则必须保留原 attempt 对账。
      if (e instanceof HttpError && [
        'whatsapp_graph_rejected',
        'attempt_failed',
        'attempt_payload_mismatch',
      ].includes(e.code ?? '')) sendAttemptIdRef.current = null
      setError(e instanceof Error ? `发送失败：${e.message}` : '发送失败，请重试')
    } finally {
      if (reqIdRef.current === myReqId) setSending(false)
    }
  }

  async function handleSelectLang(lang: string): Promise<void> {
    if (!conversationId || lang === '') return
    const prevLocked = lockedLang
    const prevResolved = resolvedLang
    setLockedLang(lang)
    setResolvedLang(lang)
    try {
      await api.updateTargetLang(conversationId, lang)
      updateConversationTargetLang(conversationId, lang)
      // 现有预览是按旧语言翻的，语言一变就不再可信，逼着员工重新翻译。
      if (preview.trim() !== '') clearPreviewState()
    } catch (e) {
      setLockedLang(prevLocked)
      setResolvedLang(prevResolved)
      setError(e instanceof Error ? `设置语言失败：${e.message}` : '设置语言失败')
    }
  }

  async function handleToggleLock(): Promise<void> {
    if (!conversationId) return
    if (lockedLang != null) {
      const prev = lockedLang
      setLockedLang(null)
      try {
        await api.updateTargetLang(conversationId, null)
        updateConversationTargetLang(conversationId, null)
      } catch (e) {
        setLockedLang(prev)
        setError(e instanceof Error ? `解锁失败：${e.message}` : '解锁失败')
      }
    } else {
      const lang = resolvedLang ?? 'en'
      setLockedLang(lang)
      try {
        await api.updateTargetLang(conversationId, lang)
        updateConversationTargetLang(conversationId, lang)
      } catch (e) {
        setLockedLang(null)
        setError(e instanceof Error ? `锁定失败：${e.message}` : '锁定失败')
      }
    }
  }

  const displayLang = lockedLang ?? resolvedLang
  const hasPreview = preview.trim() !== ''

  const sendDisabled = !conversationId || !hasPreview || sending || sendLocked

  const inputStyle = {
    width: '100%', height: 58, resize: 'none' as const, padding: '10px 14px',
    fontSize: theme.font.size.md, lineHeight: 1.6, fontFamily: theme.font.sans,
    border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.lg,
    background: theme.color.white, color: theme.color.text,
  }

  return (
    <div style={{
      flexShrink: 0, padding: theme.space.md, background: theme.color.chat,
    }}>
      <div style={{
        background: theme.color.card, borderRadius: theme.radius.xl,
        border: `1px solid ${theme.color.border}`, boxShadow: theme.shadow.md,
        padding: theme.space.lg,
        maxWidth: CHAT_MAX_WIDTH, margin: '0 auto',
      }}>
        {justSent && (
          <div style={{
            fontSize: theme.font.size.xs, color: theme.color.onLime,
            background: theme.color.limeSoft, borderRadius: theme.radius.pill,
            padding: '5px 9px', marginBottom: theme.space.sm,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            已发送：{justSent}
          </div>
        )}
        {error && (
          <div style={{
            fontSize: theme.font.size.xs, color: theme.color.danger,
            background: theme.color.dangerSoft, borderRadius: theme.radius.sm,
            padding: '5px 9px', marginBottom: theme.space.sm,
          }}>
            {error}
          </div>
        )}

        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5,
          fontSize: theme.font.size.xs, color: theme.color.textFaint, fontWeight: 600,
        }}>
          <span style={{
            width: 5, height: 5, borderRadius: '50%', background: theme.color.textFaint,
          }} />
          中文原文
        </div>
        <textarea
          value={zh}
          onChange={e => setZh(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void handleTranslate()
            }
          }}
          placeholder="输入中文，回车翻译（Shift+回车换行）"
          disabled={!conversationId}
          style={inputStyle}
        />

        {hasPreview && (
          <div className="ih-fade" style={{ marginTop: theme.space.md }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5,
              fontSize: theme.font.size.xs, color: theme.color.text,
              fontWeight: theme.font.weight.heavy,
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: theme.color.limeDeep }} />
              译文预览
              <span style={{ color: theme.color.textFaint, fontWeight: 400 }}>
                可直接改，悬停看原文与回译对照
              </span>
              {manuallyEdited && (
                <span style={{ color: theme.color.status.reconnecting, fontWeight: 600 }}>已手动修改</span>
              )}
            </div>

            <div
              style={{ position: 'relative' }}
              onMouseEnter={() => setHovering(true)}
              onMouseLeave={() => setHovering(false)}
            >
              {hovering && (
                <div className="ih-fade" style={{
                  position: 'absolute', bottom: '100%', left: 0, right: 0, marginBottom: 8,
                  background: theme.color.inkDeep, color: theme.color.onInk,
                  padding: `${theme.space.md}px ${theme.space.lg}px`, borderRadius: theme.radius.xl,
                  fontSize: theme.font.size.sm, lineHeight: 1.75, zIndex: 20,
                  boxShadow: theme.shadow.lg,
                }}>
                  <div style={{ display: 'flex', gap: theme.space.sm }}>
                    <span style={{ color: theme.color.onInkFaint, flexShrink: 0, width: 56 }}>你输入的</span>
                    <span style={{ minWidth: 0 }}>{previewSourceZh}</span>
                  </div>
                  <div style={{
                    display: 'flex', gap: theme.space.sm, marginTop: 6, paddingTop: 6,
                    borderTop: `1px solid ${theme.color.onInkLine}`,
                  }}>
                    <span style={{ color: theme.color.onInkFaint, flexShrink: 0, width: 56 }}>回译成中文</span>
                    <span style={{ minWidth: 0 }}>
                      {backTranslating ? '更新中…' : (backTranslated ?? '回译不可用')}
                    </span>
                  </div>
                  <div style={{
                    marginTop: 8, paddingTop: 6, borderTop: `1px solid ${theme.color.onInkLine}`,
                    color: theme.color.onInkFaint, fontSize: theme.font.size.xs, lineHeight: 1.6,
                  }}>
                    回译顺不代表翻对了。要比的是关键信息有没有丢：价格、数量、否定词、时间、人名。
                  </div>
                </div>
              )}
              <textarea
                ref={previewRef}
                value={preview}
                onChange={e => handlePreviewChange(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void handleSend()
                  }
                }}
                disabled={sending}
                style={{ ...inputStyle, borderColor: theme.color.limeDeep, background: theme.color.limeSoft }}
              />
            </div>

            {backTranslating && (
              <div style={{ fontSize: theme.font.size.xs, color: theme.color.textFaint, marginTop: 4 }}>
                回译更新中…
              </div>
            )}
            {!backTranslating && backTranslated === null && (
              <div style={{ fontSize: theme.font.size.xs, color: theme.color.danger, marginTop: 4 }}>
                回译不可用（不影响发送）
              </div>
            )}
          </div>
        )}

        {/* 底栏：左边语言设置，右边动作。主按钮永远在右下角，位置不随状态跳 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: theme.space.sm, flexWrap: 'wrap',
          marginTop: theme.space.md, paddingTop: theme.space.md,
          borderTop: `1px solid ${theme.color.border}`,
        }}>
          <span style={{
            fontSize: theme.font.size.xs, color: theme.color.textFaint, whiteSpace: 'nowrap',
          }}>
            回复语言
          </span>
          <select
            value={displayLang ?? ''}
            onChange={e => void handleSelectLang(e.target.value)}
            disabled={!conversationId}
            style={{
              fontSize: theme.font.size.xs, padding: '5px 8px', fontFamily: theme.font.sans,
              border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.pill,
              background: theme.color.white, color: theme.color.text,
            }}
          >
            {!displayLang && <option value="" disabled>自动</option>}
            {LANG_OPTIONS.map(o => <option key={o.code} value={o.code}>{o.label}</option>)}
          </select>
          <button
            onClick={() => void handleToggleLock()}
            disabled={!conversationId}
            className="ih-btn"
            title={lockedLang != null ? '点击解锁，恢复自动跟随客户语言' : '点击锁定当前语言，不再随客户切换'}
            style={{
              fontSize: theme.font.size.xs, padding: '5px 12px', borderRadius: theme.radius.pill,
              border: `1px solid ${lockedLang != null ? 'transparent' : theme.color.border}`,
              background: lockedLang != null ? theme.color.lime : theme.color.white,
              color: lockedLang != null ? theme.color.onLime : theme.color.textMuted,
              fontWeight: theme.font.weight.heavy, whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            {lockedLang != null ? '🔒 已锁定' : '🔓 自动'}
          </button>

          <div style={{
            display: 'flex', gap: theme.space.sm, marginLeft: 'auto', flexShrink: 0,
          }}>
          <button
            onClick={() => void handleTranslate()}
            disabled={!conversationId || zh.trim() === '' || translating}
            className="ih-btn"
            style={{
              padding: '9px 16px', borderRadius: theme.radius.pill,
              border: '1px solid transparent', background: 'transparent',
              color: theme.color.textMuted, fontSize: theme.font.size.base,
              fontWeight: theme.font.weight.bold, whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            {translating ? '翻译中…' : '翻译'}
          </button>
          <button
            onClick={() => void handleSend()}
            disabled={sendDisabled}
            className="ih-btn"
            title={sendLocked ? '刚翻译完，先看一眼译文' : undefined}
            style={{
              padding: '9px 24px', borderRadius: theme.radius.pill, border: 'none',
              // 不可用时不要只是把黑键调半透明——浅底上会糊成一坨脏墨色。
              // 直接换成浅灰底弱文字：没译文时输入区里压根不该有一块黑。
              background: sendDisabled ? theme.color.surface : theme.color.ink,
              color: sendDisabled ? theme.color.textFaint : theme.color.lime,
              opacity: 1,
              fontSize: theme.font.size.base, fontWeight: theme.font.weight.heavy,
              whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            {sending ? '发送中…' : sendLocked ? '确认译文中…' : '发送'}
          </button>
          </div>
        </div>
      </div>
    </div>
  )
}
