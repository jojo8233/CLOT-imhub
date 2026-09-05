import { useCallback, useEffect, useRef, useState } from 'react'
import type { AdminMutationPreview, AdminTeam } from '@im-hub/shared'
import { api, NetworkError } from '../api/client.js'
import { TeamController, type TeamControllerSnapshot } from '../organization-admin/team-controller.js'
import { theme } from '../theme.js'
import { AdminConfirmationDialog } from './AdminConfirmationDialog.js'

type TeamStatus = 'enabled' | 'archived' | 'all'

export function OrganizationAdminTeams({ ownerUserId }: { ownerUserId: string }) {
  const controllerRef = useRef<TeamController | null>(null)
  controllerRef.current ??= new TeamController(ownerUserId)
  const controller = controllerRef.current
  const [snapshot, setSnapshot] = useState<TeamControllerSnapshot>(() => controller.snapshot())
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<TeamStatus>('all')
  const [managerTarget, setManagerTarget] = useState<AdminTeam | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<{
    team: AdminTeam
    preview: AdminMutationPreview
    outcome: TeamControllerSnapshot['outcome']
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      await controller.load({ ...(q ? { q } : {}), status, limit: 50 })
      setSnapshot(controller.snapshot())
      return true
    } catch (cause) {
      setSnapshot(controller.snapshot())
      setError(message(cause, '团队列表加载失败'))
      return false
    }
  }, [controller, q, status])

  useEffect(() => {
    void refresh()
    return () => controller.cancel()
  }, [controller, refresh])

  async function createTeam(): Promise<void> {
    const name = window.prompt('团队名称')?.trim()
    if (!name) return
    const managerUserId = window.prompt('主管用户 ID')?.trim()
    if (!managerUserId) return
    try {
      await api.createAdminTeam({ name, managerUserId })
      await refresh()
    } catch (cause) {
      setError(message(cause, '创建团队失败'))
    }
  }

  async function previewManagerChange(team: AdminTeam): Promise<void> {
    const managerUserId = window.prompt('新主管用户 ID', team.managerUserId ?? '')?.trim()
    if (!managerUserId || managerUserId === team.managerUserId) return
    try {
      await controller.previewChange(team, { managerUserId })
      setSnapshot(controller.snapshot())
      setManagerTarget(team)
    } catch (cause) {
      setSnapshot(controller.snapshot())
      setError(message(cause, '更换主管预览失败'))
    }
  }

  async function renameTeam(team: AdminTeam): Promise<void> {
    const name = window.prompt('团队名称', team.name)?.trim()
    if (!name || name === team.name) return
    try {
      await api.updateAdminTeam(team.id, { name, baseRevision: team.revision })
      await refresh()
    } catch (cause) {
      setError(message(cause, '重命名团队失败'))
    }
  }

  async function executeManagerChange(): Promise<void> {
    try {
      await controller.executeChange()
      setSnapshot(controller.snapshot())
      setManagerTarget(null)
    } catch (cause) {
      setSnapshot(controller.snapshot())
      setError(message(cause, '更换主管失败'))
    }
  }

  async function toggleArchive(team: AdminTeam): Promise<void> {
    if (team.disabledAt) {
      const managerUserId = window.prompt('恢复后主管用户 ID')?.trim()
      if (!managerUserId) return
      try {
        await api.restoreAdminTeam(team.id, managerUserId, team.revision)
        await refresh()
      } catch (cause) {
        setError(message(cause, '恢复团队失败'))
      }
      return
    }
    try {
      const result = await api.previewArchiveAdminTeam(team.id, team.revision)
      setArchiveTarget({ team, preview: result.preview, outcome: 'ready' })
    } catch (cause) {
      setError(message(cause, '归档团队预览失败'))
    }
  }

  async function executeArchive(): Promise<void> {
    if (!archiveTarget || archiveTarget.outcome !== 'ready') return
    setArchiveTarget({ ...archiveTarget, outcome: 'executing' })
    try {
      await api.archiveAdminTeam(archiveTarget.team.id, archiveTarget.preview.operationToken)
      setArchiveTarget(null)
      await refresh()
    } catch (cause) {
      if (cause instanceof NetworkError) {
        setArchiveTarget(current => current ? { ...current, outcome: 'unknown' } : null)
        setError('网络中断，归档结果待核对；正在刷新团队列表')
        if (await refresh()) setArchiveTarget(null)
      } else {
        setArchiveTarget(current => current ? { ...current, outcome: 'ready' } : null)
        setError(message(cause, '归档团队失败'))
      }
    }
  }

  return (
    <>
      <OrganizationAdminTeamsContent
        items={snapshot.items}
        loading={snapshot.loading}
        q={q}
        status={status}
        onQueryChange={setQ}
        onStatusChange={setStatus}
        onRefresh={() => void refresh()}
        onCreate={() => void createTeam()}
        onRename={team => void renameTeam(team)}
        onChangeManager={team => void previewManagerChange(team)}
        onToggleArchive={team => void toggleArchive(team)}
      />
      {error && <div role="alert" style={floatingErrorStyle}>{error}</div>}
      {managerTarget && snapshot.preview && (
        <AdminConfirmationDialog
          title={`确认更换 ${managerTarget.name} 的主管`}
          preview={snapshot.preview}
          outcome={snapshot.outcome}
          onConfirm={() => void executeManagerChange()}
          onCancel={() => { controller.cancel(); setSnapshot(controller.snapshot()); setManagerTarget(null) }}
        />
      )}
      {archiveTarget && (
        <AdminConfirmationDialog
          title={`确认归档 ${archiveTarget.team.name}`}
          preview={archiveTarget.preview}
          outcome={archiveTarget.outcome}
          onConfirm={() => void executeArchive()}
          onCancel={() => setArchiveTarget(null)}
        />
      )}
    </>
  )
}

export function OrganizationAdminTeamsContent({
  items, loading, q, status, onQueryChange, onStatusChange,
  onRefresh, onCreate, onRename, onChangeManager, onToggleArchive,
}: {
  items: AdminTeam[]
  loading: boolean
  q: string
  status: TeamStatus
  onQueryChange(value: string): void
  onStatusChange(value: TeamStatus): void
  onRefresh(): void
  onCreate(): void
  onRename(team: AdminTeam): void
  onChangeManager(team: AdminTeam): void
  onToggleArchive(team: AdminTeam): void
}) {
  return (
    <section style={sectionStyle}>
      <div style={toolbarStyle}>
        <input aria-label="搜索团队" placeholder="搜索团队" value={q}
          onChange={event => onQueryChange(event.target.value)} style={inputStyle} />
        <select aria-label="团队状态" value={status}
          onChange={event => onStatusChange(event.target.value as TeamStatus)} style={inputStyle}>
          <option value="all">全部状态</option><option value="enabled">启用</option><option value="archived">已归档</option>
        </select>
        <button className="ih-btn" onClick={onRefresh}>{loading ? '加载中…' : '刷新'}</button>
        <button className="ih-btn" onClick={onCreate} style={primaryButtonStyle}>+ 新建团队</button>
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        {items.map(team => (
          <article key={team.id} style={rowStyle}>
            <div style={{ minWidth: 190 }}><strong>{team.name}</strong><div style={mutedStyle}>{team.id}</div></div>
            <span>主管：{team.managerUserId ?? '未指定'}</span>
            <span>{team.agentCount} 名成员</span>
            <span>{team.accountCount} 个账号</span>
            <span>{team.disabledAt ? '已归档' : '已启用'}</span>
            <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
              <button className="ih-btn" onClick={() => onRename(team)}>重命名</button>
              {!team.disabledAt && <button className="ih-btn" onClick={() => onChangeManager(team)}>更换主管</button>}
              <button className="ih-btn" onClick={() => onToggleArchive(team)}>{team.disabledAt ? '恢复' : '归档'}</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

const sectionStyle: React.CSSProperties = { padding: 20, overflow: 'auto', flex: 1 }
const toolbarStyle: React.CSSProperties = { display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }
const inputStyle: React.CSSProperties = { padding: '8px 10px', border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.md }
const primaryButtonStyle: React.CSSProperties = { background: theme.color.ink, color: theme.color.lime }
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 18, padding: 14, borderRadius: theme.radius.lg, background: theme.color.card, border: `1px solid ${theme.color.border}` }
const mutedStyle: React.CSSProperties = { color: theme.color.textMuted, fontSize: theme.font.size.xs }
const floatingErrorStyle: React.CSSProperties = { position: 'absolute', right: 24, bottom: 20, maxWidth: 460, padding: 10, background: theme.color.dangerSoft, color: theme.color.danger, borderRadius: theme.radius.md }
