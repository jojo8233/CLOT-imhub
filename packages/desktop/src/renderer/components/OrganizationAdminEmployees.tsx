import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AdminEditableRole,
  AdminAccount,
  AdminAccountResolution,
  AdminMutationPreview,
  AdminTeam,
  AdminTeamResolution,
  AdminUser,
  Role,
} from '@im-hub/shared'
import { api, NetworkError, type AdminCredentialResult } from '../api/client.js'
import { EmployeeController, type EmployeeControllerSnapshot, type MutationOutcome } from '../organization-admin/employee-controller.js'
import { theme } from '../theme.js'
import { AdminConfirmationDialog } from './AdminConfirmationDialog.js'
import { TemporaryPasswordDialog } from './TemporaryPasswordDialog.js'

type RoleFilter = Role | 'all'

export function OrganizationAdminEmployees({ ownerUserId }: { ownerUserId: string }) {
  const controllerRef = useRef<EmployeeController | null>(null)
  controllerRef.current ??= new EmployeeController(ownerUserId)
  const controller = controllerRef.current
  const [snapshot, setSnapshot] = useState<EmployeeControllerSnapshot>(() => controller.snapshot())
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<'enabled' | 'disabled' | 'all'>('all')
  const [role, setRole] = useState<RoleFilter>('all')
  const [teamId, setTeamId] = useState('')
  const [credential, setCredential] = useState<AdminCredentialResult | null>(null)
  const [disableTarget, setDisableTarget] = useState<AdminUser | null>(null)
  const [transfer, setTransfer] = useState<{
    target: AdminUser
    preview: AdminMutationPreview
    outcome: MutationOutcome
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      await controller.load({
        ...(q ? { q } : {}),
        status,
        ...(role === 'all' ? {} : { roles: [role] }),
        ...(teamId ? { teamId } : {}),
        limit: 50,
      })
      setSnapshot(controller.snapshot())
      return true
    } catch (cause) {
      setSnapshot(controller.snapshot())
      setError(cause instanceof Error ? cause.message : '员工列表加载失败')
      return false
    }
  }, [controller, q, role, status, teamId])

  useEffect(() => {
    void refresh()
    return () => controller.cancel()
  }, [controller, refresh])

  async function createEmployee(): Promise<void> {
    const email = window.prompt('员工邮箱')?.trim()
    if (!email) return
    const displayName = window.prompt('员工显示名')?.trim()
    if (!displayName) return
    const selectedRole = window.prompt('角色：agent / manager / auditor', 'agent')
    if (!editableRole(selectedRole)) {
      setError('角色必须是 agent、manager 或 auditor')
      return
    }
    try {
      const selectedTeamId = selectedRole === 'agent'
        ? window.prompt('团队 ID（可留空）', '')?.trim() || null
        : null
      const result = await controller.create({ email, displayName, role: selectedRole, teamId: selectedTeamId })
      setCredential(result)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建员工失败')
    }
  }

  async function editEmployee(user: AdminUser): Promise<void> {
    const displayName = window.prompt('员工显示名', user.displayName)?.trim()
    if (!displayName) return
    const selectedRole = window.prompt('角色：agent / manager / auditor', user.role)
    if (!editableRole(selectedRole)) {
      setError('角色必须是 agent、manager 或 auditor')
      return
    }
    try {
      await api.updateAdminUser(user.id, {
        displayName, role: selectedRole, baseRevision: user.revision,
      })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '编辑员工失败')
    }
  }

  async function changeAgentTeam(user: AdminUser): Promise<void> {
    const selectedTeamId = window.prompt('新团队 ID（留空表示未分组）', user.teamIds[0] ?? '')
    if (selectedTeamId === null) return
    try {
      await api.changeAdminAgentTeam(user.id, {
        teamId: selectedTeamId.trim() || null,
        baseRevision: user.revision,
      })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '调整团队失败')
    }
  }

  async function resetPassword(user: AdminUser): Promise<void> {
    try {
      setCredential(await api.resetAdminUserPassword(user.id, user.revision))
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重置密码失败')
    }
  }

  async function toggleEnabled(user: AdminUser): Promise<void> {
    if (user.disabledAt) {
      try {
        setCredential(await api.enableAdminUser(user.id, user.revision))
        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '启用员工失败')
      }
      return
    }
    try {
      const teamResolutions = await collectTeamResolutions(user.id)
      if (teamResolutions === null) return
      await controller.previewDisable(user, { teamResolutions, allowManualCleanup: true })
      setSnapshot(controller.snapshot())
      setDisableTarget(user)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '停用预览失败')
    }
  }

  async function executeDisable(): Promise<void> {
    try {
      await controller.executeDisable()
      setSnapshot(controller.snapshot())
      setDisableTarget(null)
    } catch (cause) {
      setSnapshot(controller.snapshot())
      setError(cause instanceof Error ? cause.message : '停用员工失败')
    }
  }

  async function previewOwnerTransfer(target: AdminUser): Promise<void> {
    try {
      const currentOwner = (await loadAllAdminUsers({ roles: ['owner'], status: 'enabled' }))
        .find(item => item.id === ownerUserId)
      if (!currentOwner) {
        setError('当前 owner 快照不可用，请刷新员工列表')
        return
      }
      const nextRoleInput = window.prompt('转让后当前 owner 的角色：agent / manager / auditor', 'agent')
      if (!editableRole(nextRoleInput)) {
        setError('转让后的角色必须是 agent、manager 或 auditor')
        return
      }
      const currentOwnerTeamId = nextRoleInput === 'auditor'
        ? null
        : window.prompt('转让后当前 owner 的团队 ID（manager 必填）', '')?.trim() || null
      if (nextRoleInput === 'manager' && !currentOwnerTeamId) {
        setError('当前 owner 转为 manager 时必须选择团队')
        return
      }
      const teams = await loadAllAdminTeams()
      const targetLedTeams = teams.filter(team => team.managerUserId === target.id && !team.disabledAt)
      const managedTeams = uniqueTeams([
        ...targetLedTeams,
        ...(nextRoleInput === 'manager'
          ? teams.filter(team => team.id === currentOwnerTeamId && !team.disabledAt)
          : []),
      ])
      const teamResolutions = await collectTransferTeamResolutions(
        managedTeams,
        currentOwnerTeamId,
        ownerUserId,
      )
      if (teamResolutions === null) return
      const accounts = await loadAllAdminAccounts()
      const accountResolutions = ownerTransferAccountResolutions(
        accounts,
        teams,
        teamResolutions,
        ownerUserId,
        target.id,
      )
      const result = await api.previewOwnerTransfer({
        targetUserId: target.id,
        currentOwnerNextRole: nextRoleInput,
        currentOwnerTeamId,
        teamResolutions,
        accountResolutions,
        currentOwnerBaseRevision: currentOwner.revision,
        targetUserBaseRevision: target.revision,
        allowManualCleanup: true,
      })
      setTransfer({ target, preview: result.preview, outcome: 'ready' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'owner 转让预览失败')
    }
  }

  async function executeOwnerTransfer(currentPassword?: string): Promise<void> {
    if (!transfer || !currentPassword) return
    setTransfer({ ...transfer, outcome: 'executing' })
    try {
      await api.transferOwner({ operationToken: transfer.preview.operationToken, currentPassword })
      setTransfer(null)
    } catch (cause) {
      if (cause instanceof NetworkError) {
        setTransfer(current => current ? { ...current, outcome: 'unknown' } : null)
        setError('网络中断，owner 转让结果待核对；正在刷新员工列表')
        if (await refresh()) setTransfer(null)
      } else {
        setTransfer(current => current ? { ...current, outcome: 'idle' } : null)
        setError(cause instanceof Error ? cause.message : 'owner 转让失败')
      }
    }
  }

  return (
    <>
      <OrganizationAdminEmployeesContent
        items={snapshot.items}
        loading={snapshot.loading}
        q={q}
        status={status}
        role={role}
        teamId={teamId}
        onQueryChange={setQ}
        onStatusChange={setStatus}
        onRoleChange={setRole}
        onTeamChange={setTeamId}
        onRefresh={() => void refresh()}
        onCreate={() => void createEmployee()}
        onEdit={user => void editEmployee(user)}
        onChangeTeam={user => void changeAgentTeam(user)}
        onResetPassword={user => void resetPassword(user)}
        onToggleEnabled={user => void toggleEnabled(user)}
        onTransferOwner={user => void previewOwnerTransfer(user)}
      />
      {error && <div role="alert" style={floatingErrorStyle}>{error}</div>}
      {disableTarget && snapshot.preview && (
        <AdminConfirmationDialog
          title={`确认停用 ${disableTarget.displayName}`}
          preview={snapshot.preview}
          outcome={snapshot.outcome}
          onConfirm={() => void executeDisable()}
          onCancel={() => { controller.cancel(); setSnapshot(controller.snapshot()); setDisableTarget(null) }}
        />
      )}
      {transfer && (
        <AdminConfirmationDialog
          title={`确认将 owner 转让给 ${transfer.target.displayName}`}
          preview={transfer.preview}
          outcome={transfer.outcome}
          requiresCurrentPassword
          onConfirm={password => void executeOwnerTransfer(password)}
          onCancel={() => setTransfer(null)}
        />
      )}
      {credential && (
        <TemporaryPasswordDialog
          temporaryPassword={credential.temporaryPassword}
          expiresAt={credential.temporaryPasswordExpiresAt}
          onClear={() => setCredential(null)}
          onClose={() => setCredential(null)}
        />
      )}
    </>
  )
}

export function OrganizationAdminEmployeesContent({
  items, loading, q, status, role, teamId,
  onQueryChange, onStatusChange, onRoleChange, onTeamChange, onRefresh, onCreate, onEdit, onChangeTeam,
  onResetPassword, onToggleEnabled, onTransferOwner,
}: {
  items: AdminUser[]
  loading: boolean
  q: string
  status: 'enabled' | 'disabled' | 'all'
  role: RoleFilter
  teamId: string
  onQueryChange(value: string): void
  onStatusChange(value: 'enabled' | 'disabled' | 'all'): void
  onRoleChange(value: RoleFilter): void
  onTeamChange(value: string): void
  onRefresh(): void
  onCreate(): void
  onEdit(user: AdminUser): void
  onChangeTeam(user: AdminUser): void
  onResetPassword(user: AdminUser): void
  onToggleEnabled(user: AdminUser): void
  onTransferOwner(user: AdminUser): void
}) {
  return (
    <section style={sectionStyle}>
      <div style={toolbarStyle}>
        <input aria-label="搜索员工" placeholder="搜索员工 / 邮箱" value={q}
          onChange={event => onQueryChange(event.target.value)} style={inputStyle} />
        <select aria-label="员工状态" value={status}
          onChange={event => onStatusChange(event.target.value as typeof status)} style={inputStyle}>
          <option value="all">全部状态</option><option value="enabled">启用</option><option value="disabled">停用</option>
        </select>
        <select aria-label="员工角色" value={role}
          onChange={event => onRoleChange(event.target.value as RoleFilter)} style={inputStyle}>
          <option value="all">全部角色</option><option value="owner">owner</option><option value="manager">manager</option>
          <option value="agent">agent</option><option value="auditor">auditor</option>
        </select>
        <input aria-label="按团队 ID 筛选" placeholder="按团队 ID 筛选" value={teamId}
          onChange={event => onTeamChange(event.target.value)} style={inputStyle} />
        <button className="ih-btn" onClick={onRefresh}>{loading ? '加载中…' : '刷新'}</button>
        <button className="ih-btn" onClick={onCreate} style={primaryButtonStyle}>+ 新建员工</button>
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        {items.map(user => (
          <article key={user.id} style={rowStyle}>
            <div style={{ minWidth: 210 }}>
              <strong>{user.displayName}</strong>
              <div style={mutedStyle}>{user.email}</div>
              <div style={{ ...mutedStyle, fontSize: theme.font.size.xs }}>{user.id}</div>
            </div>
            <code>{user.role}</code>
            <span>{user.disabledAt ? '已停用' : '已启用'}</span>
            <span>{user.teamIds[0] ?? '未分组'}</span>
            <span>{user.ownedAccountCount} 个账号</span>
            <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
              {user.role !== 'owner' && <button className="ih-btn" onClick={() => onEdit(user)}>编辑</button>}
              {user.role === 'agent' && <button className="ih-btn" onClick={() => onChangeTeam(user)}>调整团队</button>}
              {user.role !== 'owner' && <button className="ih-btn" onClick={() => onResetPassword(user)}>重置密码</button>}
              {user.role !== 'owner' && <button className="ih-btn" onClick={() => onToggleEnabled(user)}>
                {user.disabledAt ? '启用' : '停用'}
              </button>}
              {user.role !== 'owner' && <button className="ih-btn" onClick={() => onTransferOwner(user)}>转让 owner</button>}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function editableRole(value: string | null): value is AdminEditableRole {
  return value === 'agent' || value === 'manager' || value === 'auditor'
}

async function collectTeamResolutions(userId: string): Promise<AdminTeamResolution[] | null> {
  const teams = (await loadAllAdminTeams()).filter(team => team.managerUserId === userId && !team.disabledAt)
  const resolutions: AdminTeamResolution[] = []
  for (const team of teams) {
    const answer = window.prompt(
      `团队「${team.name}」的新主管用户 ID；输入 ARCHIVE 归档团队，取消则终止`,
    )?.trim()
    if (!answer) return null
    resolutions.push(answer.toUpperCase() === 'ARCHIVE'
      ? { teamId: team.id, action: 'archive', baseRevision: team.revision }
      : {
          teamId: team.id,
          action: 'replace_manager',
          replacementManagerUserId: answer,
          baseRevision: team.revision,
        })
  }
  return resolutions
}

async function collectTransferTeamResolutions(
  teams: AdminTeam[],
  currentOwnerTeamId: string | null,
  currentOwnerId: string,
): Promise<AdminTeamResolution[] | null> {
  const resolutions: AdminTeamResolution[] = []
  for (const team of teams) {
    if (team.id === currentOwnerTeamId) {
      resolutions.push({
        teamId: team.id,
        action: 'replace_manager',
        replacementManagerUserId: currentOwnerId,
        baseRevision: team.revision,
      })
      continue
    }
    const answer = window.prompt(
      `目标 owner 当前主管团队「${team.name}」：输入新主管用户 ID，或输入 ARCHIVE 归档`,
    )?.trim()
    if (!answer) return null
    resolutions.push(answer.toUpperCase() === 'ARCHIVE'
      ? { teamId: team.id, action: 'archive', baseRevision: team.revision }
      : {
          teamId: team.id,
          action: 'replace_manager',
          replacementManagerUserId: answer,
          baseRevision: team.revision,
        })
  }
  return resolutions.sort((left, right) => left.teamId.localeCompare(right.teamId))
}

export function ownerTransferAccountResolutions(
  accounts: AdminAccount[],
  teams: AdminTeam[],
  resolutions: AdminTeamResolution[],
  currentOwnerId: string,
  targetUserId: string,
): AdminAccountResolution[] {
  const archived = new Set(resolutions.filter(item => item.action === 'archive').map(item => item.teamId))
  const displaced = new Map(resolutions.filter(item => item.action === 'replace_manager').flatMap(item => {
    const previousManager = teams.find(team => team.id === item.teamId)?.managerUserId
    return previousManager && previousManager !== targetUserId
      ? [[item.teamId, previousManager] as const]
      : []
  }))
  return accounts.filter(account => account.ownerUserId === currentOwnerId
      || (account.teamId !== null && archived.has(account.teamId))
      || (account.teamId !== null && displaced.get(account.teamId) === account.ownerUserId))
    .map(account => {
      const isArchived = account.teamId !== null && archived.has(account.teamId)
      const isDisplaced = account.teamId !== null
        && displaced.get(account.teamId) === account.ownerUserId
      return {
        accountId: account.id,
        ownerUserId: account.ownerUserId === currentOwnerId || isDisplaced
          ? targetUserId
          : account.ownerUserId,
        teamId: isArchived ? null : account.teamId,
        baseRevision: account.revision,
      }
    })
    .sort((left, right) => left.accountId.localeCompare(right.accountId))
}

async function loadAllAdminTeams(): Promise<AdminTeam[]> {
  const items: AdminTeam[] = []
  let cursor: string | undefined
  do {
    const page = await api.searchAdminTeams({ status: 'all', limit: 100, ...(cursor ? { cursor } : {}) })
    items.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return items
}

async function loadAllAdminAccounts(): Promise<AdminAccount[]> {
  const items: AdminAccount[] = []
  let cursor: string | undefined
  do {
    const page = await api.searchAdminAccounts({ limit: 100, ...(cursor ? { cursor } : {}) })
    items.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return items
}

async function loadAllAdminUsers(
  filters: Pick<Parameters<typeof api.searchAdminUsers>[0], 'roles' | 'status'> = {},
): Promise<AdminUser[]> {
  const items: AdminUser[] = []
  let cursor: string | undefined
  do {
    const page = await api.searchAdminUsers({ ...filters, limit: 100, ...(cursor ? { cursor } : {}) })
    items.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return items
}

function uniqueTeams(teams: AdminTeam[]): AdminTeam[] {
  return [...new Map(teams.map(team => [team.id, team])).values()]
    .sort((left, right) => left.id.localeCompare(right.id))
}

const sectionStyle: React.CSSProperties = { padding: 20, overflow: 'auto', flex: 1 }
const toolbarStyle: React.CSSProperties = { display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }
const inputStyle: React.CSSProperties = { padding: '8px 10px', border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.md }
const primaryButtonStyle: React.CSSProperties = { background: theme.color.ink, color: theme.color.lime }
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 18, padding: 14, borderRadius: theme.radius.lg, background: theme.color.card, border: `1px solid ${theme.color.border}` }
const mutedStyle: React.CSSProperties = { color: theme.color.textMuted, fontSize: theme.font.size.sm }
const floatingErrorStyle: React.CSSProperties = { position: 'absolute', right: 24, bottom: 20, maxWidth: 460, padding: 10, background: theme.color.dangerSoft, color: theme.color.danger, borderRadius: theme.radius.md }
