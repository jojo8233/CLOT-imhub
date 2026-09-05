import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AdminAccount,
  AdminCleanupState,
  AdminManualCleanupTask,
  Platform,
} from '@im-hub/shared'
import { api } from '../api/client.js'
import { AccountController, type AccountControllerSnapshot } from '../organization-admin/account-controller.js'
import { previewWithManualCleanupFallback } from '../organization-admin/manual-cleanup.js'
import { PLATFORM_LABEL, theme } from '../theme.js'
import { AdminConfirmationDialog } from './AdminConfirmationDialog.js'

type PlatformFilter = Platform | 'all'
type CleanupFilter = AdminCleanupState | 'all'

export function OrganizationAdminAccounts({ ownerUserId }: { ownerUserId: string }) {
  const controllerRef = useRef<AccountController | null>(null)
  controllerRef.current ??= new AccountController(ownerUserId)
  const controller = controllerRef.current
  const [snapshot, setSnapshot] = useState<AccountControllerSnapshot>(() => controller.snapshot())
  const [q, setQ] = useState('')
  const [platform, setPlatform] = useState<PlatformFilter>('all')
  const [cleanupState, setCleanupState] = useState<CleanupFilter>('all')
  const [target, setTarget] = useState<AdminAccount | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => controller.subscribe(() => setSnapshot(controller.snapshot())), [controller])

  const refresh = useCallback(async () => {
    try {
      await controller.load({
        ...(q ? { q } : {}),
        ...(platform === 'all' ? {} : { platform }),
        ...(cleanupState === 'all' ? {} : { cleanupState }),
        limit: 50,
      })
      setSnapshot(controller.snapshot())
    } catch (cause) {
      setSnapshot(controller.snapshot())
      setError(message(cause, '账号列表加载失败'))
    }
  }, [cleanupState, controller, platform, q])

  useEffect(() => {
    void refresh()
    return () => controller.cancel()
  }, [controller, refresh])

  async function previewAssignment(account: AdminAccount): Promise<void> {
    const ownerUserId = window.prompt('新负责人用户 ID', account.ownerUserId)?.trim()
    if (!ownerUserId) return
    const rawTeamId = window.prompt('新团队 ID（留空表示未分组）', account.teamId ?? '')
    if (rawTeamId === null) return
    try {
      await previewWithManualCleanupFallback(allowManualCleanup => (
        controller.previewAssignment(account, {
          ownerUserId,
          teamId: rawTeamId.trim() || null,
          allowManualCleanup,
        })
      ))
      setSnapshot(controller.snapshot())
      setTarget(account)
    } catch (cause) {
      setSnapshot(controller.snapshot())
      setError(message(cause, '账号转移预览失败'))
    }
  }

  async function executeAssignment(): Promise<void> {
    try {
      await controller.executeAssignment()
      setSnapshot(controller.snapshot())
      setTarget(null)
    } catch (cause) {
      setSnapshot(controller.snapshot())
      setError(message(cause, '账号转移失败'))
    }
  }

  async function confirmManualCleanup(
    account: AdminAccount,
    task: AdminManualCleanupTask,
  ): Promise<void> {
    try {
      await confirmOneManualCleanupTask(
        task.id,
        () => window.confirm(account.platform === 'signal'
          ? `请先在 Signal 官方“已关联设备”中解除${installationLabel(task.installationId)}。是否确认这一项已经完成？`
          : `是否确认已经完成${installationLabel(task.installationId)}的本机人工清理？`),
        async taskId => { await api.confirmManualDesktopCleanup(taskId) },
      )
      await refresh()
    } catch (cause) {
      setError(message(cause, '确认人工清理失败，请刷新后重试'))
      await refresh()
    }
  }

  return (
    <>
      <OrganizationAdminAccountsContent
        items={snapshot.items}
        loading={snapshot.loading}
        q={q}
        platform={platform}
        cleanupState={cleanupState}
        onQueryChange={setQ}
        onPlatformChange={setPlatform}
        onCleanupStateChange={setCleanupState}
        onRefresh={() => void refresh()}
        onAssign={account => void previewAssignment(account)}
        onConfirmManualCleanup={(account, task) => void confirmManualCleanup(account, task)}
      />
      {error && <div role="alert" style={floatingErrorStyle}>{error}</div>}
      {target && snapshot.preview && (
        <AdminConfirmationDialog
          title={`确认转移 ${target.displayName}`}
          preview={snapshot.preview}
          outcome={snapshot.outcome}
          onConfirm={() => void executeAssignment()}
          onCancel={() => { controller.cancel(); setSnapshot(controller.snapshot()); setTarget(null) }}
        />
      )}
    </>
  )
}

export function OrganizationAdminAccountsContent({
  items, loading, q, platform, cleanupState, onQueryChange,
  onPlatformChange, onCleanupStateChange, onRefresh, onAssign, onConfirmManualCleanup,
}: {
  items: AdminAccount[]
  loading: boolean
  q: string
  platform: PlatformFilter
  cleanupState: CleanupFilter
  onQueryChange(value: string): void
  onPlatformChange(value: PlatformFilter): void
  onCleanupStateChange(value: CleanupFilter): void
  onRefresh(): void
  onAssign(account: AdminAccount): void
  onConfirmManualCleanup(account: AdminAccount, task: AdminManualCleanupTask): void
}) {
  return (
    <section style={sectionStyle}>
      <div style={toolbarStyle}>
        <input aria-label="搜索平台账号" placeholder="搜索平台账号" value={q}
          onChange={event => onQueryChange(event.target.value)} style={inputStyle} />
        <select aria-label="账号平台" value={platform}
          onChange={event => onPlatformChange(event.target.value as PlatformFilter)} style={inputStyle}>
          <option value="all">全部平台</option><option value="telegram">Telegram</option>
          <option value="signal">Signal</option><option value="whatsapp">WhatsApp</option><option value="zoom">Zoom</option>
        </select>
        <select aria-label="清理状态" value={cleanupState}
          onChange={event => onCleanupStateChange(event.target.value as CleanupFilter)} style={inputStyle}>
          <option value="all">全部清理状态</option><option value="not_required">无需清理</option>
          <option value="pending">待清理</option><option value="completed">已完成</option><option value="manual_required">需人工处理</option>
        </select>
        <button className="ih-btn" onClick={onRefresh}>{loading ? '加载中…' : '刷新'}</button>
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        {items.map(account => (
          <article key={account.id} style={rowStyle}>
            <div style={{ minWidth: 180 }}>
              <strong>{account.displayName}</strong>
              <div style={mutedStyle}>{PLATFORM_LABEL[account.platform] ?? platformName(account.platform)} · {account.connectionMode}</div>
            </div>
            <span>{account.status}</span>
            <span>负责人：{account.ownerUserId}</span>
            <span>团队：{account.teamId ?? '未分组'}</span>
            <span style={cleanupBadgeStyle(account.cleanupState)}>{cleanupLabel(account.cleanupState)}</span>
            <span>{account.pendingCleanupCount} 项待处理</span>
            <button className="ih-btn" onClick={() => onAssign(account)} style={{ marginLeft: 'auto' }}>转移负责人 / 团队</button>
            {account.cleanupState === 'manual_required' && (
              <div style={signalNoticeStyle}>
                <span>{account.platform === 'signal'
                  ? '需在 Signal 官方已关联设备中人工解除'
                  : '旧客户端需人工清理本机登录分区'}</span>
                <div style={{ display: 'grid', gap: 6 }}>
                  {account.manualCleanupTasks.map(task => (
                    <div key={task.id} style={manualTaskStyle}>
                      <span>{installationLabel(task.installationId)} · {cleanupReasonLabel(task.reason)}</span>
                      <time dateTime={task.createdAt}>{task.createdAt}</time>
                      <button className="ih-btn" onClick={() => onConfirmManualCleanup(account, task)}>
                        {account.platform === 'signal' ? '确认已在官方解除' : '确认已人工清理'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}

export async function confirmOneManualCleanupTask(
  taskId: string,
  confirm: () => boolean,
  complete: (taskId: string) => Promise<void>,
): Promise<void> {
  if (!confirm()) return
  await complete(taskId)
}

function installationLabel(installationId: string | null): string {
  return installationId ? `设备 …${installationId.slice(-8)}` : '未知旧设备'
}

function cleanupReasonLabel(reason: AdminManualCleanupTask['reason']): string {
  if (reason === 'signal_official_unlink') return '官方解除关联'
  if (reason === 'unsupported_client_override') return '旧客户端人工清理'
  return '负责人变更人工清理'
}

function cleanupLabel(value: AdminCleanupState): string {
  if (value === 'not_required') return '无需清理'
  if (value === 'pending') return '待清理'
  if (value === 'completed') return '已完成'
  return '需人工处理'
}

function platformName(platform: Platform): string {
  return platform[0]?.toUpperCase() + platform.slice(1)
}

function cleanupBadgeStyle(state: AdminCleanupState): React.CSSProperties {
  return {
    padding: '3px 8px', borderRadius: theme.radius.pill,
    background: state === 'manual_required' || state === 'pending' ? '#fbf4d8' : theme.color.surface,
    color: state === 'manual_required' || state === 'pending' ? theme.color.gold : theme.color.textMuted,
  }
}

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

const sectionStyle: React.CSSProperties = { padding: 20, overflow: 'auto', flex: 1 }
const toolbarStyle: React.CSSProperties = { display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }
const inputStyle: React.CSSProperties = { padding: '8px 10px', border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.md }
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 14, padding: 14, borderRadius: theme.radius.lg, background: theme.color.card, border: `1px solid ${theme.color.border}` }
const mutedStyle: React.CSSProperties = { color: theme.color.textMuted, fontSize: theme.font.size.xs, marginTop: 2 }
const signalNoticeStyle: React.CSSProperties = {
  width: '100%', color: theme.color.gold, fontSize: theme.font.size.sm,
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
}
const manualTaskStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) minmax(180px, auto) auto',
  alignItems: 'center', gap: 8, color: theme.color.textMuted,
}
const floatingErrorStyle: React.CSSProperties = { position: 'absolute', right: 24, bottom: 20, maxWidth: 460, padding: 10, background: theme.color.dangerSoft, color: theme.color.danger, borderRadius: theme.radius.md }
