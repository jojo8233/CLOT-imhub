import { useState } from 'react'
import { api, getCurrentUser, NetworkError, type AccountRow } from '../api/client.js'
import { isChatPlatform, type ChatPlatform } from '../navigation.js'
import { useStore } from '../store.js'
import { PLATFORM_LABEL, STATUS_LABEL, theme } from '../theme.js'
import { Chip, EmptyHint, PlatformIcon, StatusDot, relativeTime } from './ui.js'

/**
 * 账号状态总览。管理员要一眼看出哪个号掉线了，所以状态放在卡片最显眼的位置，
 * 断线和降级用色块而不只是小圆点——一排绿点里混一个红点很容易被跳过。
 */
/** 在线是唯一"一切正常"的状态，只有它配得上柠檬绿；其余一律用各自的告警色 */
const online2 = (status: string): boolean => status === 'connected'

export function AccountsView({ onOpenChat, onAddAccount, onRelink, onAccountsChanged, canAddAccount }: {
  onOpenChat(): void
  onAddAccount(): void
  canAddAccount: boolean
  onRelink(account: { id: string; platform: ChatPlatform; displayName: string }): void
  onAccountsChanged(accounts: AccountRow[]): Promise<void>
}) {
  const accounts = useStore(s => s.accounts)
  const conversations = useStore(s => s.conversations)
  const setActivePlatform = useStore(s => s.setActivePlatform)
  const setActiveAccount = useStore(s => s.setActiveAccount)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<{ id: string; name: string; platform: string } | null>(null)
  const currentUser = getCurrentUser()

  async function refresh(): Promise<void> {
    try { await onAccountsChanged((await api.listAccounts()).accounts) } catch { /* 下次进页面会重拉 */ }
  }

  const online = accounts.filter(a => a.status === 'connected').length

  return (
    <div className="ih-scroll" style={{ flex: 1, minWidth: 0, background: theme.color.chat }}>
      <div style={{
        padding: `${theme.space.xl}px ${theme.space.xl}px ${theme.space.lg}px`,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
      }}>
        <div>
          <div style={{ fontSize: theme.font.size.xl, fontWeight: theme.font.weight.heavy, letterSpacing: -.6 }}>账号状态</div>
          <div style={{ fontSize: theme.font.size.sm, color: theme.color.textMuted, marginTop: 3 }}>
            {accounts.length} 个账号，{online} 个在线
          </div>
        </div>
        {canAddAccount && <button
          onClick={onAddAccount}
          className="ih-btn"
          style={{
            padding: '10px 20px', borderRadius: theme.radius.pill, border: 'none',
            background: theme.color.ink, color: theme.color.lime,
            fontSize: theme.font.size.base, fontWeight: theme.font.weight.heavy,
          }}
        >
          + 添加账号
        </button>}
      </div>

      {accounts.length === 0 ? (
        <EmptyHint>还没有账号</EmptyHint>
      ) : (
        <div style={{
          padding: `0 ${theme.space.xl}px ${theme.space.xl}px`,
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: theme.space.lg,
        }}>
          {accounts.map(a => {
            const convs = conversations.filter(c => c.account_id === a.id)
            const chatPlatform = isChatPlatform(a.platform) ? a.platform : null
            const last = convs.reduce<string | null>(
              (acc, c) => (c.last_message_at ?? '') > (acc ?? '') ? c.last_message_at : acc,
              null,
            )
            const statusColor = theme.color.status[a.status as keyof typeof theme.color.status]
              ?? theme.color.status.pending_auth
            return (
              <div key={a.id} style={{
                background: theme.color.card, borderRadius: theme.radius.xl,
                border: `1px solid ${theme.color.border}`, boxShadow: theme.shadow.sm, overflow: 'hidden',
              }}>
                <div style={{ height: 5, background: online2(a.status) ? theme.color.lime : statusColor }} />
                <div style={{ padding: theme.space.lg }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: theme.space.sm }}>
                    <PlatformIcon platform={a.platform} size={30} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{
                        fontSize: theme.font.size.md, fontWeight: theme.font.weight.heavy,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {a.display_name}
                      </div>
                      <div style={{ fontSize: theme.font.size.xs, color: theme.color.textFaint }}>
                        {PLATFORM_LABEL[a.platform] ?? a.platform}
                      </div>
                    </div>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5,
                      padding: '4px 11px', borderRadius: theme.radius.pill,
                      background: online2(a.status) ? theme.color.lime : `${statusColor}1a`,
                      color: online2(a.status) ? theme.color.onLime : statusColor,
                      fontSize: theme.font.size.xs, fontWeight: theme.font.weight.heavy,
                    }}>
                      <StatusDot status={a.status} size={6} />
                      {STATUS_LABEL[a.status] ?? a.status}
                    </span>
                  </div>

                  <div style={{
                    marginTop: theme.space.md, display: 'flex', flexWrap: 'wrap', gap: 6,
                  }}>
                    <Chip>{convs.length} 个会话</Chip>
                    {last && <Chip>最近 {relativeTime(last)}</Chip>}
                    {a.history_available_from && (
                      <Chip>历史自 {a.history_available_from.slice(0, 10)}</Chip>
                    )}
                  </div>

                  <div className="ih-selectable" style={{
                    marginTop: theme.space.sm, fontSize: theme.font.size.xs,
                    color: theme.color.textFaint, wordBreak: 'break-all',
                  }}>
                    {a.id}
                  </div>

                  <div style={{ marginTop: theme.space.md, display: 'flex', gap: 6 }}>
                    {chatPlatform ? (
                      <CardButton
                        onClick={() => {
                          setActivePlatform(chatPlatform)
                          setActiveAccount(a.id)
                          onOpenChat()
                        }}
                        grow
                      >
                        查看会话
                      </CardButton>
                    ) : (
                      <CardButton onClick={() => {}} disabled grow>未来接入</CardButton>
                    )}
                    <CardButton onClick={() => setRenaming(a.id)}>改名</CardButton>
                    {chatPlatform
                      && a.status !== 'connected'
                      && a.platform !== 'whatsapp'
                      && a.owner_user_id === currentUser?.id && (
                      <CardButton onClick={() => onRelink({
                        id: a.id,
                        platform: chatPlatform,
                        displayName: a.display_name,
                      })}>
                        重新关联
                      </CardButton>
                    )}
                    <CardButton
                      onClick={() => setDeleting({ id: a.id, name: a.display_name, platform: a.platform })}
                      danger
                    >
                      删除
                    </CardButton>
                  </div>

                  {renaming === a.id && (
                    <RenameRow
                      current={a.display_name}
                      onCancel={() => setRenaming(null)}
                      onDone={async (name) => {
                        await api.renameAccount(a.id, name)
                        setRenaming(null)
                        await refresh()
                      }}
                    />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {deleting && (
        <DeleteDialog
          account={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={async () => { setDeleting(null); await refresh() }}
        />
      )}
    </div>
  )
}

function CardButton({ children, onClick, grow, danger, disabled = false }: {
  children: React.ReactNode
  onClick(): void
  grow?: boolean
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="ih-btn"
      style={{
        flex: grow ? 1 : undefined, padding: '9px 14px', whiteSpace: 'nowrap',
        borderRadius: theme.radius.pill, border: `1px solid ${theme.color.borderStrong}`,
        background: theme.color.surface,
        color: disabled ? theme.color.textFaint : danger ? theme.color.danger : theme.color.text,
        fontSize: theme.font.size.base, fontWeight: theme.font.weight.bold,
      }}
    >
      {children}
    </button>
  )
}

function RenameRow({ current, onCancel, onDone }: {
  current: string
  onCancel(): void
  onDone(name: string): Promise<void>
}) {
  const [value, setValue] = useState(current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(): Promise<void> {
    const name = value.trim()
    if (busy || name === '') return
    if (name === current) { onCancel(); return }
    setBusy(true)
    setError(null)
    try {
      await onDone(name)
    } catch (e) {
      setError(e instanceof NetworkError ? '连不上服务端' : (e instanceof Error ? e.message : '改名失败'))
      setBusy(false)
    }
  }

  return (
    <div className="ih-fade" style={{ marginTop: theme.space.sm }}>
      <input
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') void save()
          if (e.key === 'Escape') onCancel()
        }}
        autoFocus
        maxLength={60}
        style={{
          width: '100%', padding: '9px 12px', fontSize: theme.font.size.base,
          border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.lg,
          background: theme.color.white, color: theme.color.text,
        }}
      />
      {error && (
        <div style={{ fontSize: theme.font.size.xs, color: theme.color.danger, marginTop: 4 }}>{error}</div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <CardButton onClick={() => void save()} grow>{busy ? '保存中…' : '保存'}</CardButton>
        <CardButton onClick={onCancel}>取消</CardButton>
      </div>
    </div>
  )
}

/**
 * 删除确认。
 *
 * 要求把账号名原样打一遍，不是为了仪式感：删账号会连带删掉它名下所有会话和
 * 消息，可能是几千条真实的客户聊天记录，而且没有回收站。一个"确定吗"挡不住
 * 手滑，打一遍名字能。
 */
function DeleteDialog({ account, onClose, onDeleted }: {
  account: { id: string; name: string; platform: string }
  onClose(): void
  onDeleted(): Promise<void>
}) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cleanup, setCleanup] = useState<string | null>(null)

  async function confirm(): Promise<void> {
    if (busy || typed !== account.name) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.deleteAccount(account.id, typed)
      let nativeCleanup: string | null = null
      try {
        const nativeControl = window.imHub?.nativeControl
        if (!nativeControl) throw new Error('native control unavailable')
        await nativeControl.removeAccount(account.id)
      } catch {
        nativeCleanup = '本机原生客户端分区清理失败，请完全退出应用后联系管理员检查本机数据'
      }
      const cleanupSteps = [res.manualCleanup, nativeCleanup].filter((step): step is string => step !== null)
      if (cleanupSteps.length > 0) {
        // 平台侧还留着一个已关联设备，必须让用户看到，不能默默关窗
        setCleanup(cleanupSteps.join('；'))
        setBusy(false)
        return
      }
      await onDeleted()
    } catch (e) {
      setError(e instanceof NetworkError ? '连不上服务端' : (e instanceof Error ? e.message : '删除失败'))
      setBusy(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(41,43,41,.38)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        className="ih-fade"
        onClick={e => e.stopPropagation()}
        style={{
          width: 460, maxWidth: '90vw', background: theme.color.card,
          borderRadius: theme.radius.xxl, boxShadow: theme.shadow.lg,
          padding: theme.space.xl,
        }}
      >
        {cleanup ? (
          <>
            <div style={{ fontSize: theme.font.size.lg, fontWeight: theme.font.weight.heavy }}>
              账号已删除
            </div>
            <div style={{
              marginTop: theme.space.md, padding: theme.space.md,
              background: theme.color.surface, borderRadius: theme.radius.lg,
              fontSize: theme.font.size.sm, color: theme.color.text, lineHeight: 1.8,
            }}>
              还有一步要你自己做：{cleanup}。
              <div style={{ color: theme.color.textMuted, marginTop: 6 }}>
                我们只清了本机数据，没有去动你在平台上的账号设置。
              </div>
            </div>
            <div style={{ marginTop: theme.space.lg, display: 'flex', justifyContent: 'flex-end' }}>
              <CardButton onClick={() => void onDeleted()}>知道了</CardButton>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: theme.font.size.lg, fontWeight: theme.font.weight.heavy }}>
              删除「{account.name}」
            </div>
            <div style={{
              marginTop: theme.space.sm, fontSize: theme.font.size.sm,
              color: theme.color.textMuted, lineHeight: 1.8,
            }}>
              这会一并删掉该账号下的<strong style={{ color: theme.color.danger }}>全部会话和消息</strong>，
              并解除本机与平台的关联。<strong style={{ color: theme.color.danger }}>不可撤销，没有回收站。</strong>
            </div>
            <div style={{
              marginTop: theme.space.lg, fontSize: theme.font.size.sm, color: theme.color.textMuted,
            }}>
              确认请输入账号名称：<code style={{
                background: theme.color.white, padding: '1px 6px', borderRadius: 4, color: theme.color.text,
              }}>{account.name}</code>
            </div>
            <input
              value={typed}
              onChange={e => setTyped(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void confirm() }}
              autoFocus
              style={{
                width: '100%', marginTop: theme.space.sm, padding: '10px 12px',
                fontSize: theme.font.size.md, border: `1px solid ${theme.color.border}`,
                borderRadius: theme.radius.lg, background: theme.color.white, color: theme.color.text,
              }}
            />
            {error && (
              <div style={{
                marginTop: theme.space.md, padding: '8px 12px',
                background: theme.color.dangerSoft, borderRadius: theme.radius.md,
                fontSize: theme.font.size.sm, color: theme.color.danger,
              }}>
                {error}
              </div>
            )}
            <div style={{ marginTop: theme.space.lg, display: 'flex', gap: theme.space.sm, justifyContent: 'flex-end' }}>
              <CardButton onClick={onClose}>取消</CardButton>
              <button
                onClick={() => void confirm()}
                disabled={busy || typed !== account.name}
                className="ih-btn"
                style={{
                  padding: '10px 22px', borderRadius: theme.radius.pill, border: 'none',
                  background: typed === account.name ? theme.color.danger : theme.color.surfaceHover,
                  color: typed === account.name ? '#ffffff' : theme.color.textFaint,
                  opacity: 1,
                  fontSize: theme.font.size.base, fontWeight: theme.font.weight.heavy,
                }}
              >
                {busy ? '删除中…' : '永久删除'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
