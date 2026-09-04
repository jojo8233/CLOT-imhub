import type {
  AccountConnectionMode,
  AccountStatus,
  Platform,
} from './platform.js'
import type { Role } from './rbac.js'

export const ADMIN_EDITABLE_ROLES = ['auditor', 'manager', 'agent'] as const
export type AdminEditableRole = (typeof ADMIN_EDITABLE_ROLES)[number]

export const DESKTOP_INSTALLATION_CAPABILITIES = ['partition_cleanup_v1'] as const
export type DesktopInstallationCapability =
  (typeof DESKTOP_INSTALLATION_CAPABILITIES)[number]

export type AdminCleanupState =
  | 'not_required'
  | 'pending'
  | 'completed'
  | 'manual_required'

export type DesktopCleanupReason =
  | 'ownership_changed'
  | 'unsupported_client_override'
  | 'signal_official_unlink'

export interface AuthenticatedUser {
  id: string
  role: Role
  displayName: string
}

export type LoginResponse =
  | {
      kind: 'authenticated'
      token: string
      user: AuthenticatedUser
    }
  | {
      kind: 'password_change_required'
      setupToken: string
      user: AuthenticatedUser
    }

export interface AccountCreationContext {
  selectableTeams: Array<{ id: string; name: string }>
  requiresTeamSelection: boolean
  allowsUngrouped: boolean
}

export interface AdminUser {
  id: string
  email: string
  displayName: string
  role: Role
  disabledAt: string | null
  teamIds: string[]
  ownedAccountCount: number
  revision: number
}

export interface AdminTeam {
  id: string
  name: string
  managerUserId: string | null
  agentCount: number
  accountCount: number
  disabledAt: string | null
  revision: number
}

export interface AdminAccount {
  id: string
  platform: Platform
  connectionMode: AccountConnectionMode
  displayName: string
  status: AccountStatus
  ownerUserId: string
  teamId: string | null
  cleanupState: AdminCleanupState
  pendingCleanupCount: number
  revision: number
}

export interface AdminPage<T> {
  items: T[]
  nextCursor: string | null
}

export interface AdminMutationPreview {
  operationToken: string
  expiresAt: string
  summary: Record<string, number>
}

export interface DesktopCleanupTask {
  id: string
  installationId: string | null
  accountId: string
  mode: 'automatic' | 'manual_required'
  reason: DesktopCleanupReason
  state: 'pending' | 'completed'
  createdAt: string
  completedAt: string | null
}

export interface DesktopInstallationSyncResult {
  readyAccountIds: string[]
  blockedAccountIds: string[]
  manualRequiredAccountIds: string[]
}

export type AdminErrorCode =
  | 'ADMIN_WRITES_DISABLED'
  | 'REVISION_CONFLICT'
  | 'ORGANIZATION_INVARIANT'
  | 'CLIENT_UPDATE_REQUIRED'
  | 'DEVICE_CREDENTIAL_INVALID'
  | 'DEVICE_CLEANUP_PENDING'
  | 'OPERATION_PREVIEW_EXPIRED'

export interface AdminUserSearchRequest {
  q?: string
  roles?: Role[]
  status?: 'enabled' | 'disabled' | 'all'
  teamId?: string | null
  cursor?: string
  limit?: number
}

export interface AdminUserCreate {
  email: string
  displayName: string
  role: AdminEditableRole
  teamId: string | null
}

export interface AdminUserUpdate {
  displayName?: string
  role?: AdminEditableRole
  teamId?: string | null
  baseRevision: number
}

export interface AdminTeamSearchRequest {
  q?: string
  status?: 'enabled' | 'archived' | 'all'
  cursor?: string
  limit?: number
}

export interface AdminTeamCreate {
  name: string
  managerUserId: string
}

export interface AdminAgentTeamChange {
  teamId: string | null
  baseRevision: number
}

export interface AdminAccountSearchRequest {
  q?: string
  platform?: Platform
  ownerUserId?: string
  teamId?: string | null
  cleanupState?: AdminCleanupState
  cursor?: string
  limit?: number
}

export interface AdminAccountAssignmentPreviewRequest {
  ownerUserId: string
  teamId: string | null
  allowManualCleanup: boolean
  baseRevision: number
}

export interface AdminAccountAssignmentRequest {
  operationToken: string
}

export interface AdminTeamResolution {
  teamId: string
  action: 'replace_manager' | 'archive'
  replacementManagerUserId?: string
  baseRevision: number
}

export interface AdminAccountResolution {
  accountId: string
  ownerUserId: string
  teamId: string | null
  baseRevision: number
}

export interface AdminOwnerTransferPreviewRequest {
  targetUserId: string
  currentOwnerNextRole: AdminEditableRole
  currentOwnerTeamId: string | null
  teamResolutions: AdminTeamResolution[]
  accountResolutions: AdminAccountResolution[]
  currentOwnerBaseRevision: number
  targetUserBaseRevision: number
  allowManualCleanup: boolean
}

export interface AdminOwnerTransferRequest {
  operationToken: string
  currentPassword: string
}

