import type {
  AccountConnectionMode,
  AccountCreationContext,
  AdminAccount,
  AdminAccountAssignmentPreviewRequest,
  AdminAccountAssignmentRequest,
  AdminAccountSearchRequest,
  AdminAgentTeamChange,
  AdminMutationPreview,
  AdminOwnerTransferPreviewRequest,
  AdminOwnerTransferRequest,
  AdminPage,
  AdminTeam,
  AdminTeamCreate,
  AdminTeamSearchRequest,
  AdminTeamResolution,
  AdminUser,
  AdminUserCreate,
  AdminUserSearchRequest,
  AdminUserUpdate,
  CustomerProfile,
  CustomerProfileListPage,
  CustomerProfileSearchRequest,
  CustomerProfileUpdate,
  KeywordAlertListPage,
  KeywordAlertSearchRequest,
  KeywordAlertUnacknowledgedCount,
  KeywordRule,
  KeywordRuleCreate,
  KeywordRuleListResponse,
  KeywordRuleUpdate,
  LoginResponse,
  NativeControlGrantResponse,
  Platform,
  Role,
  WsServerEvent,
} from '@im-hub/shared'

interface SessionBridge {
  save(payload: { token: string; user: SessionUser }): Promise<boolean>
  load(): Promise<{ token: string; user: SessionUser } | null>
  clear(): Promise<void>
}

/**
 * preload 注入的配置。取不到时降级到默认值而不是抛异常——
 * 这一行跑在模块顶层，抛出去会让 React 连挂载都来不及，
 * 结果是一片白屏加零提示，排查起来极其痛苦。
 */
const injected = (globalThis as { imHub?: { serverUrl?: string; session?: SessionBridge } }).imHub
if (!injected?.serverUrl) {
  console.error('[client] preload 未注入 window.imHub，降级使用 http://localhost:4000。检查 sandbox 与 preload 路径。')
}
const BASE = injected?.serverUrl ?? 'http://localhost:4000'
// 可能为 undefined（比如以后有非 Electron 的渲染宿主）。所有用法都做了空值兜底：
// 拿不到就是"这次不持久化"，不是崩溃。
const initialSessionBridge = injected?.session

function currentSessionBridge(): SessionBridge | undefined {
  return (globalThis as { imHub?: { session?: SessionBridge } }).imHub?.session
    ?? initialSessionBridge
}

export interface SessionUser {
  id: string
  role: Role
  displayName: string
}

/**
 * 服务端 401 时触发（登录之外的任何请求）：token 失效或过期。
 * App.tsx 订阅它，负责把界面切回登录页——client.ts 本身不碰 UI。
 */
type UnauthorizedListener = () => void
let unauthorizedListener: UnauthorizedListener | null = null
export function onUnauthorized(listener: UnauthorizedListener | null): void {
  unauthorizedListener = listener
}

export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized')
    this.name = 'UnauthorizedError'
  }
}

/** fetch 本身失败（服务端没起、断网），跟"服务端返回了错误状态码"要分开处理。 */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('network error')
    this.name = 'NetworkError'
    this.cause = cause
  }
}

/** 服务端明确返回的非 2xx；status 供消息 outbox 区分永久拒绝与可重试故障。 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string | null = null,
    public readonly details: unknown = null,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

// 外壳 token 只活在这个模块级变量里，绝不落 localStorage/sessionStorage，也不打印到
// console。持久化只走 preload 的 session.save/load/clear（主进程 safeStorage）。
let token: string | null = null
let currentUser: SessionUser | null = null
let initialPasswordSetupToken: string | null = null

export function hasToken(): boolean {
  return token !== null
}

export function getCurrentUser(): SessionUser | null {
  return currentUser
}

/** 应用启动时调用：有加密存档就恢复登录态，没有（或解不出来）就返回 null，交给调用方显示登录页。 */
export async function restoreSession(): Promise<SessionUser | null> {
  const sessionBridge = currentSessionBridge()
  if (!sessionBridge) return null
  const saved = await sessionBridge.load()
  if (!saved) return null
  token = saved.token
  currentUser = saved.user
  return saved.user
}

/**
 * 登录成功后调用，把当前 token+user 落盘。safeStorage 不可用时 save() 返回 false——
 * 这不是错误，是"这台机器/这个平台没法安全持久化"，调用方不需要处理，
 * 后果只是下次启动要求重新登录。
 */
async function persistSession(): Promise<void> {
  const sessionBridge = currentSessionBridge()
  if (!sessionBridge || !token || !currentUser) return
  await sessionBridge.save({ token, user: currentUser })
}

async function clearPersistedSession(): Promise<void> {
  await currentSessionBridge()?.clear()
}

/** 登出：清内存 token/user，清磁盘存档。调用方（App.tsx）另外负责关 WS、清 store。 */
export async function logout(): Promise<void> {
  token = null
  currentUser = null
  initialPasswordSetupToken = null
  await clearPersistedSession()
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // 请求发出时的会话归属不能在响应回来时重新猜。A 用户的迟到
  // 401 不得清掉期间已登录的 B 用户 token。
  const requestToken = token
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        // Fastify 会把“声明 application/json 但没有 body”的 POST 当成空 JSON，
        // 在进入路由前直接返回 400。只有真的发送 body 时才声明 JSON。
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(requestToken ? { Authorization: `Bearer ${requestToken}` } : {}),
        ...init.headers,
      },
    })
  } catch (e) {
    throw new NetworkError(e)
  }

  if (res.status === 401) {
    // 无论是"密码错误"（登录请求）还是"token 过期/失效"（其它请求），服务端都回 401——
    // 两种情况都该清掉内存里可能存在的旧 token，登录请求本来就没有 token 可清，无副作用。
    if (token === requestToken) {
      token = null
      currentUser = null
      void clearPersistedSession()
      unauthorizedListener?.()
    }
    throw new UnauthorizedError()
  }

  if (!res.ok) {
    let detail = ''
    let code: string | null = null
    let details: unknown = null
    try {
      details = await res.json() as unknown
      if (record(details) && typeof details.error === 'string') detail = `: ${details.error}`
      if (record(details) && typeof details.code === 'string') code = details.code
    } catch {
      // 响应体不是 JSON 或读取失败，忽略，用纯状态码报错
    }
    throw new HttpError(
      res.status,
      `${init.method ?? 'GET'} ${path} failed: ${res.status}${detail}`,
      code,
      details,
    )
  }
  return res.json() as Promise<T>
}

export interface AccountRow {
  id: string
  platform: Platform
  owner_user_id: string
  display_name: string
  status: string
  history_available_from: string | null
  connection_mode: AccountConnectionMode
  /** 仅存在于 renderer 内存；服务端账号响应不会持久化本机挂载状态。 */
  desktop_mount_state?: 'pending' | 'ready' | 'blocked'
  desktop_mount_notice?: string
}

export interface CreateAccountInput {
  platform: string
  displayName: string
  connectionMode?: AccountConnectionMode
  teamId?: string | null
}

export interface AdminCredentialResult {
  user: AdminUser
  temporaryPassword: string
  temporaryPasswordExpiresAt: string
}

export interface AdminDisablePreviewInput {
  teamResolutions: AdminTeamResolution[]
  allowManualCleanup: boolean
}

export interface AdminTeamManagerChangeInput {
  managerUserId: string
  baseRevision: number
}

export interface ConversationRow {
  id: string
  account_id: string
  contact_display_name: string | null
  contact_external_id: string
  last_message_at: string | null
  /**
   * null = 自动跟随客户语言，有值 = 员工锁定。
   * 注：设计文档写的是 GET /api/conversations 不返回这个字段，但实测服务端已经在返回——
   * 直接用它做语言选择器的初始值，比只靠 translate-preview 响应回填更可靠。
   */
  target_lang: string | null
}

export interface MessageRow {
  id: string
  platform_message_id: string
  direction: 'in' | 'out'
  body: string
  sent_at: string
  edited_at: string | null
  translated_text: string | null
}

export interface WhatsAppOnboardingStatus {
  state: 'pending' | 'processing' | 'completed' | 'failed'
  accountId: string | null
  expiresAt: string
}

export const api = {
  /**
   * 登录成功后立即尝试加密持久化（safeStorage 不可用时 persistSession 静默跳过，
   * 不算失败）。返回服务端给的 user，登录页/App.tsx 用它展示姓名、驱动后续流程。
   */
  async login(email: string, password: string): Promise<LoginResponse> {
    const res = await request<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    if (res.kind === 'password_change_required') {
      token = null
      currentUser = null
      initialPasswordSetupToken = res.setupToken
      await clearPersistedSession()
      return res
    }
    initialPasswordSetupToken = null
    token = res.token
    currentUser = res.user
    await persistSession()
    return res
  },
  async completeInitialPassword(newPassword: string): Promise<SessionUser> {
    const setupToken = initialPasswordSetupToken
    if (!setupToken) throw new Error('首次改密流程已失效，请重新登录')
    try {
      const res = await request<LoginResponse>('/api/auth/initial-password/complete', {
        method: 'POST',
        headers: { Authorization: `InitialPassword ${setupToken}` },
        body: JSON.stringify({ newPassword }),
      })
      if (res.kind !== 'authenticated') throw new Error('首次改密响应无效')
      token = res.token
      currentUser = res.user
      await persistSession()
      return res.user
    } finally {
      initialPasswordSetupToken = null
    }
  },
  async changePassword(currentPassword: string, newPassword: string): Promise<SessionUser> {
    const res = await request<LoginResponse>('/api/session/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    })
    if (res.kind !== 'authenticated') throw new Error('改密响应无效')
    token = res.token
    currentUser = res.user
    await persistSession()
    return res.user
  },
  async refreshSessionUser(): Promise<SessionUser> {
    const res = await request<{ user: { id: string; role: Role } }>('/api/session/me')
    if (!currentUser || currentUser.id !== res.user.id) {
      throw new Error('服务端会话身份与本地快照不一致')
    }
    currentUser = { ...currentUser, role: res.user.role }
    await persistSession()
    return currentUser
  },
  searchAdminUsers: (search: AdminUserSearchRequest, signal?: AbortSignal) =>
    request<AdminPage<AdminUser>>('/api/admin/users/search', {
      method: 'POST', body: JSON.stringify(search), signal,
    }),
  createAdminUser: (input: AdminUserCreate) =>
    request<AdminCredentialResult>('/api/admin/users', {
      method: 'POST', body: JSON.stringify(input),
    }),
  updateAdminUser: (userId: string, input: AdminUserUpdate) =>
    request<{ user: AdminUser }>(`/api/admin/users/${userId}`, {
      method: 'PATCH', body: JSON.stringify(input),
    }),
  resetAdminUserPassword: (userId: string, baseRevision: number) =>
    request<AdminCredentialResult>(`/api/admin/users/${userId}/reset-password`, {
      method: 'POST', body: JSON.stringify({ baseRevision }),
    }),
  enableAdminUser: (userId: string, baseRevision: number) =>
    request<AdminCredentialResult>(`/api/admin/users/${userId}/enable`, {
      method: 'POST', body: JSON.stringify({ baseRevision }),
    }),
  previewDisableAdminUser: (
    userId: string,
    baseRevision: number,
    input: AdminDisablePreviewInput,
  ) => request<{ preview: AdminMutationPreview }>(`/api/admin/users/${userId}/disable`, {
    method: 'POST', body: JSON.stringify({ phase: 'preview', baseRevision, input }),
  }),
  disableAdminUser: (userId: string, operationToken: string) =>
    request<{ user: AdminUser }>(`/api/admin/users/${userId}/disable`, {
      method: 'POST', body: JSON.stringify({ phase: 'execute', operationToken }),
    }),
  previewOwnerTransfer: (input: AdminOwnerTransferPreviewRequest) =>
    request<{ preview: AdminMutationPreview }>('/api/admin/owner-transfer/preview', {
      method: 'POST', body: JSON.stringify(input),
    }),
  transferOwner: (input: AdminOwnerTransferRequest) =>
    request<{ currentOwner: AdminUser; newOwner: AdminUser }>('/api/admin/owner-transfer', {
      method: 'POST', body: JSON.stringify(input),
    }),
  searchAdminTeams: (search: AdminTeamSearchRequest, signal?: AbortSignal) =>
    request<AdminPage<AdminTeam>>('/api/admin/teams/search', {
      method: 'POST', body: JSON.stringify(search), signal,
    }),
  createAdminTeam: (input: AdminTeamCreate) =>
    request<{ team: AdminTeam }>('/api/admin/teams', {
      method: 'POST', body: JSON.stringify(input),
    }),
  updateAdminTeam: (teamId: string, input: { name: string; baseRevision: number }) =>
    request<{ team: AdminTeam }>(`/api/admin/teams/${teamId}`, {
      method: 'PATCH', body: JSON.stringify(input),
    }),
  previewAdminTeamManagerChange: (teamId: string, input: AdminTeamManagerChangeInput) =>
    request<{ preview: AdminMutationPreview }>(`/api/admin/teams/${teamId}/change-manager`, {
      method: 'POST', body: JSON.stringify({ phase: 'preview', baseRevision: input.baseRevision, input: {
        managerUserId: input.managerUserId,
      } }),
    }),
  changeAdminTeamManager: (teamId: string, operationToken: string) =>
    request<{ team: AdminTeam }>(`/api/admin/teams/${teamId}/change-manager`, {
      method: 'POST', body: JSON.stringify({ phase: 'execute', operationToken }),
    }),
  previewArchiveAdminTeam: (teamId: string, baseRevision: number) =>
    request<{ preview: AdminMutationPreview }>(`/api/admin/teams/${teamId}/archive`, {
      method: 'POST', body: JSON.stringify({ phase: 'preview', baseRevision, input: {} }),
    }),
  archiveAdminTeam: (teamId: string, operationToken: string) =>
    request<{ team: AdminTeam }>(`/api/admin/teams/${teamId}/archive`, {
      method: 'POST', body: JSON.stringify({ phase: 'execute', operationToken }),
    }),
  restoreAdminTeam: (teamId: string, managerUserId: string, baseRevision: number) =>
    request<{ team: AdminTeam }>(`/api/admin/teams/${teamId}/restore`, {
      method: 'POST', body: JSON.stringify({ managerUserId, baseRevision }),
    }),
  changeAdminAgentTeam: (userId: string, input: AdminAgentTeamChange) =>
    request<{ user: AdminUser; affectedAccountIds: string[] }>(`/api/admin/agents/${userId}/change-team`, {
      method: 'POST', body: JSON.stringify(input),
    }),
  searchAdminAccounts: (search: AdminAccountSearchRequest, signal?: AbortSignal) =>
    request<AdminPage<AdminAccount>>('/api/admin/accounts/search', {
      method: 'POST', body: JSON.stringify(search), signal,
    }),
  previewAdminAccountAssignment: (
    accountId: string,
    input: AdminAccountAssignmentPreviewRequest,
  ) => request<{ preview: AdminMutationPreview }>(`/api/admin/accounts/${accountId}/assignment-preview`, {
    method: 'POST', body: JSON.stringify(input),
  }),
  assignAdminAccount: (accountId: string, input: AdminAccountAssignmentRequest) =>
    request<{ account: AdminAccount }>(`/api/admin/accounts/${accountId}/assign`, {
      method: 'POST', body: JSON.stringify(input),
    }),
  confirmManualDesktopCleanup: (taskId: string) =>
    request<{ confirmed: true; message: string }>(`/api/admin/desktop/cleanup-tasks/${taskId}/confirm-manual`, {
      method: 'POST', body: JSON.stringify({}),
    }),
  getAccountCreationContext: () => request<AccountCreationContext>('/api/account-creation-context'),
  listAccounts: () => request<{ accounts: AccountRow[] }>('/api/accounts'),
  listConversations: () => request<{ conversations: ConversationRow[] }>('/api/conversations'),
  listMessages: (id: string) => request<{ messages: MessageRow[] }>(`/api/conversations/${id}/messages`),
  getCustomerProfile: (conversationId: string, signal?: AbortSignal) =>
    request<CustomerProfile>(`/api/conversations/${conversationId}/customer-profile`, { signal }),
  updateCustomerProfile: (conversationId: string, update: CustomerProfileUpdate) =>
    request<CustomerProfile>(`/api/conversations/${conversationId}/customer-profile`, {
      method: 'PUT',
      body: JSON.stringify(update),
    }),
  searchCustomerProfiles: (search: CustomerProfileSearchRequest, signal?: AbortSignal) =>
    request<CustomerProfileListPage>('/api/customer-profiles/search', {
      method: 'POST',
      body: JSON.stringify(search),
      signal,
    }),
  searchKeywordAlerts: (search: KeywordAlertSearchRequest, signal?: AbortSignal) =>
    request<KeywordAlertListPage>('/api/keyword-alerts/search', {
      method: 'POST',
      body: JSON.stringify(search),
      signal,
    }),
  getKeywordAlertUnacknowledgedCount: () =>
    request<KeywordAlertUnacknowledgedCount>('/api/keyword-alerts/unacknowledged-count'),
  acknowledgeKeywordAlert: (alertId: string) =>
    request<{ acknowledgedAt: string }>(`/api/keyword-alerts/${alertId}/acknowledge`, {
      method: 'PATCH',
    }),
  listKeywordRules: () =>
    request<KeywordRuleListResponse>('/api/keyword-rules'),
  createKeywordRule: (rule: KeywordRuleCreate) =>
    request<KeywordRule>('/api/keyword-rules', {
      method: 'POST',
      body: JSON.stringify(rule),
    }),
  updateKeywordRule: (ruleId: string, update: KeywordRuleUpdate) =>
    request<KeywordRule>(`/api/keyword-rules/${ruleId}`, {
      method: 'PATCH',
      body: JSON.stringify(update),
    }),
  deleteKeywordRule: (ruleId: string, baseRevision: number) =>
    request<{ deleted: true }>(`/api/keyword-rules/${ruleId}`, {
      method: 'DELETE',
      body: JSON.stringify({ baseRevision }),
    }),
  retryKeywordAlertScans: () =>
    request<{ retried: number }>('/api/keyword-alert-scans/retry', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  getWhatsAppCloudConfig: () => request<{
    appId: string
    configId: string
    graphApiVersion: string
  }>('/api/whatsapp/cloud/config'),
  startWhatsAppCloudOnboarding: (displayName: string) => request<{
    sessionId: string
    url: string
    expiresAt: string
  }>('/api/whatsapp/cloud/onboarding-sessions', {
    method: 'POST', body: JSON.stringify({ displayName }),
  }),
  getWhatsAppCloudOnboarding: (sessionId: string) =>
    request<WhatsAppOnboardingStatus>(`/api/whatsapp/cloud/onboarding-sessions/${sessionId}`),
  createNativeControlGrant: (accountId: string, platformAccountExternalId?: string) =>
    request<NativeControlGrantResponse>(`/api/accounts/${accountId}/native-control-grant`, {
      method: 'POST',
      ...(platformAccountExternalId
        ? { body: JSON.stringify({ platformAccountExternalId }) }
        : {}),
    }),
  /**
   * 只翻译，不发送。用来在发送前生成可编辑的预览 + 回译对照。
   * backTranslated 为 null 表示回译服务当次失败，translated/targetLang/provider 仍然可用。
   */
  translatePreview: (conversationId: string, text: string) =>
    request<{ translated: string; backTranslated: string | null; targetLang: string; provider: string }>(
      '/api/messages/translate-preview',
      { method: 'POST', body: JSON.stringify({ conversationId, text }) },
    ),
  /**
   * preTranslated: true 时 body 必须是员工在预览框里最终确认过的文本，服务端原样发出、
   * 不再翻译一次——重译结果可能和预览不一致，那样"先看后发"就没意义了。
   * targetLang 在 preTranslated: true 时服务端会忽略，只在 preTranslated: false（旧行为）时使用。
   */
  send: (conversationId: string, body: string, opts: {
    preTranslated: boolean
    targetLang?: string
    attemptId?: string
  }) =>
    request<{ platformMessageId: string; sentText: string; provider?: string }>('/api/messages/send', {
      method: 'POST',
      body: JSON.stringify({
        conversationId,
        body,
        preTranslated: opts.preTranslated,
        targetLang: opts.targetLang,
        attemptId: opts.attemptId,
      }),
    }),
  /** targetLang 为 null 表示解锁、恢复自动跟随客户语言。 */
  updateTargetLang: (conversationId: string, targetLang: string | null) =>
    request<{ id: string; targetLang: string | null }>(
      `/api/conversations/${conversationId}/target-lang`,
      { method: 'PATCH', body: JSON.stringify({ targetLang }) },
    ),
  /**
   * 鉴权走首帧消息，不走 query string —— token 有 12 小时有效期，
   * 出现在 URL 里会被反向代理/服务端访问日志记下来，query string 鉴权就是把这个
   * 长期有效凭证写进日志。握手：先建连接（不带 token）；onopen 时发
   * {type:'auth', token}；服务端校验通过回 {type:'auth_ok'}，之后才推业务事件；
   * 5 秒内没收到合法 auth 帧服务端会 close(1008)。
   *
   * P0 现状：auth 失败或服务端主动断开（比如 token 过期）时，onclose 只是静默——
   * 没有自动重连，也没有把"实时更新已经断线"这件事告诉用户。断线后消息列表仍然
   * 可以手动刷新（切换会话会重新拉取），但翻译结果的实时推送会从此收不到，
   * 界面上不会有任何提示。这是已知的 P0 局限，留给后续任务补重连与断线提示。
   */
  /** 建账号并立即开始鉴权。二维码随后经 WebSocket 的 auth_challenge 推过来。 */
  async createAccount(input: CreateAccountInput): Promise<AccountRow> {
    const res = await request<{ account: AccountRow }>('/api/accounts', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return res.account
  },

  async renameAccount(accountId: string, displayName: string): Promise<AccountRow> {
    const res = await request<{ account: AccountRow }>(`/api/accounts/${accountId}`, {
      method: 'PATCH',
      body: JSON.stringify({ displayName }),
    })
    return res.account
  },

  /**
   * 删除账号。confirmName 必须与账号当前名称完全一致，服务端会再校验一次——
   * 这一步会连带删掉该账号下的全部会话与消息，且不可撤销。
   */
  async deleteAccount(accountId: string, confirmName: string): Promise<{ deletedMessages: number; manualCleanup: string | null }> {
    return request<{ deletedMessages: number; manualCleanup: string | null }>(
      `/api/accounts/${accountId}`,
      { method: 'DELETE', body: JSON.stringify({ confirmName }) },
    )
  },

  /** 二维码过期或中途放弃后重新发起关联 */
  async relinkAccount(accountId: string): Promise<void> {
    await request(`/api/accounts/${accountId}/relink`, { method: 'POST' })
  },

  /**
   * 提交验证码或二次验证密码。
   *
   * value 是敏感值：不要放进 URL、不要打 console、不要存进 store。
   * 从输入框直接送到这里，发完就随组件状态一起消失。
   */
  async submitAuthAnswer(accountId: string, value: string): Promise<void> {
    await request(`/api/accounts/${accountId}/auth-answer`, {
      method: 'POST',
      body: JSON.stringify({ value }),
    })
  },

  connectWs(onEvent: (e: WsServerEvent) => void): WebSocket {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`)
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }))
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as WsServerEvent | { type: 'auth_ok' }
      if (msg.type === 'auth_ok') return
      onEvent(msg as WsServerEvent)
    }
    return ws
  },
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
