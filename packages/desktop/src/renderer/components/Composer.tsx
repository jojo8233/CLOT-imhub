import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client.js'
import { useStore } from '../store.js'
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
  }

  async function handleTranslate(): Promise<void> {
    if (!conversationId || zh.trim() === '' || translating) return
    const myReqId = ++reqIdRef.current
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
    scheduleBackTranslateRefresh(value)
  }

  async function handleSend(): Promise<void> {
    if (!conversationId || preview.trim() === '' || sending || sendLocked) return
    const myReqId = ++reqIdRef.current
    setSending(true)
    setError(null)
    try {
      // preTranslated: true + 预览框里的最终文本——绝不让服务端重新翻译，
      // 否则员工确认过的内容和实际发出的内容可能不一样。
      const res = await api.send(conversationId, preview, {
        preTranslated: true,
        targetLang: resolvedLang ?? undefined,
      })
      if (reqIdRef.current !== myReqId) return
      setJustSent(res.sentText)
      setZh('')
      clearPreviewState()
    } catch (e) {
      if (reqIdRef.current !== myReqId) return
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

  return (
    <div style={{ borderTop: `1px solid ${theme.color.border}`, padding: 12, background: theme.color.bg }}>
      {justSent && <div style={{ fontSize: 12, color: theme.color.status.connected, marginBottom: 6 }}>已发送：{justSent}</div>}
      {error && <div style={{ fontSize: 12, color: theme.color.danger, marginBottom: 6 }}>{error}</div>}

      <div style={{ fontSize: 12, color: theme.color.textMuted, marginBottom: 4 }}>中文</div>
      <textarea
        value={zh}
        onChange={e => setZh(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void handleTranslate()
          }
        }}
        placeholder="输入中文，回车或点击「翻译」生成预览"
        disabled={!conversationId}
        style={{ width: '100%', height: 64, resize: 'none', padding: 8, fontSize: 14, boxSizing: 'border-box' }}
      />
      <button
        onClick={() => void handleTranslate()}
        disabled={!conversationId || zh.trim() === '' || translating}
        style={{ marginTop: 6 }}
      >
        {translating ? '翻译中…' : '翻译'}
      </button>

      {hasPreview && (
        <div style={{ marginTop: 14, borderTop: `1px dashed ${theme.color.borderStrong}`, paddingTop: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: theme.color.textMuted, marginBottom: 4 }}>
            <span>译文预览（可编辑，悬停查看原文与回译对照）</span>
            {manuallyEdited && <span style={{ color: theme.color.status.reconnecting, fontWeight: 600 }}>已手动修改</span>}
          </div>

          <div
            style={{ position: 'relative' }}
            onMouseEnter={() => setHovering(true)}
            onMouseLeave={() => setHovering(false)}
          >
            {hovering && (
              <div style={{
                position: 'absolute', bottom: '100%', left: 0, right: 0, marginBottom: 6,
                background: '#1e293b', color: '#f8fafc', padding: 10, borderRadius: 8,
                fontSize: 12, lineHeight: 1.6, zIndex: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
              }}>
                <div><strong>你输入的：</strong>{previewSourceZh}</div>
                <div style={{ marginTop: 4 }}>
                  <strong>回译结果：</strong>
                  {backTranslating ? '更新中…' : (backTranslated ?? '回译不可用')}
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
              style={{ width: '100%', height: 64, resize: 'none', padding: 8, fontSize: 14, boxSizing: 'border-box' }}
            />
          </div>

          {backTranslating && <div style={{ fontSize: 12, color: theme.color.textFaint, marginTop: 4 }}>回译更新中…</div>}
          {!backTranslating && backTranslated === null && (
            <div style={{ fontSize: 12, color: theme.color.danger, marginTop: 4 }}>回译不可用（不影响发送）</div>
          )}

          <button
            onClick={() => void handleSend()}
            disabled={!conversationId || !hasPreview || sending || sendLocked}
            style={{ marginTop: 8 }}
          >
            {sending ? '发送中…' : sendLocked ? '发送（确认译文中…）' : '发送'}
          </button>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12, color: theme.color.textMuted }}>
        <span>语言：</span>
        <select
          value={displayLang ?? ''}
          onChange={e => void handleSelectLang(e.target.value)}
          disabled={!conversationId}
          style={{ fontSize: 12, padding: '2px 4px' }}
        >
          {!displayLang && <option value="" disabled>自动</option>}
          {LANG_OPTIONS.map(o => <option key={o.code} value={o.code}>{o.label}</option>)}
        </select>
        <button
          onClick={() => void handleToggleLock()}
          disabled={!conversationId}
          title={lockedLang != null ? '点击解锁，恢复自动跟随客户语言' : '点击锁定当前语言，不再随客户切换'}
          style={{ fontSize: 12, padding: '2px 8px' }}
        >
          {lockedLang != null ? '🔒 已锁定' : '🔓 自动'}
        </button>
      </div>
    </div>
  )
}
