import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { NormalizedMessage } from '@im-hub/shared'
import type { IngestMessageResult, MessageIngestor } from '../ingest/ingestor.js'
import { WhatsAppGraphClient, WhatsAppGraphError } from './graph-client.js'
import type {
  AcceptedWhatsAppMessageInput,
  CreateWhatsAppCloudAccountInput,
  KyselyWhatsAppCloudRepo,
  WhatsAppCloudAccountRecord,
  WhatsAppSendAttemptInput,
  WhatsAppSendAttemptRecord,
  WhatsAppStatusInput,
  WhatsAppOnboardingSessionRecord,
} from './repo.js'
import { WHATSAPP_ACCESS_TOKEN_PURPOSE } from './repo.js'
import { SecretCipher } from './secret-cipher.js'
import type { ParsedWhatsAppWebhook } from './webhook-payload.js'

export interface WhatsAppCloudPublicConfig {
  appId: string
  configId: string
  graphApiVersion: string
}

export interface WhatsAppCloudServiceOptions extends WhatsAppCloudPublicConfig {
  graphClient(version: string): WhatsAppGraphClient
  publicBaseUrl: string
}

type CloudRepo = Pick<KyselyWhatsAppCloudRepo,
  | 'createAccount'
  | 'findByAccountId'
  | 'findByWebhookIdentity'
  | 'startAttempt'
  | 'completeAccepted'
  | 'finishAttempt'
  | 'saveStatus'
  | 'createOnboardingSession'
  | 'claimOnboardingSession'
  | 'finishOnboardingSession'
  | 'findOnboardingSessionForOwner'
>

export interface WhatsAppCloudServiceDeps {
  repo: CloudRepo
  cipher: SecretCipher
  ingestor: Pick<MessageIngestor, 'ingestDetailed'>
  onInboundStored(result: IngestMessageResult): void | Promise<void>
  onOutgoingAccepted(messageId: string): void | Promise<void>
}

export interface OnboardWhatsAppCloudAccountInput {
  ownerUserId: string
  teamId: string | null
  displayName: string
  code: string
  wabaId: string
  phoneNumberId: string
}

export interface SendWhatsAppTextInput {
  attemptId: string
  accountId: string
  conversationId: string
  actorUserId: string
  targetExternalId: string
  body: string
}

export class WhatsAppCloudAttemptError extends Error {
  constructor(
    message: string,
    public readonly code: 'attempt_payload_mismatch' | 'attempt_result_unknown' | 'attempt_failed',
  ) {
    super(message)
    this.name = 'WhatsAppCloudAttemptError'
  }
}

export class WhatsAppOnboardingError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = 'WhatsAppOnboardingError'
  }
}

export class WhatsAppCloudService {
  constructor(
    private readonly options: WhatsAppCloudServiceOptions,
    private readonly deps: WhatsAppCloudServiceDeps,
  ) {}

  publicConfig(): WhatsAppCloudPublicConfig {
    return {
      appId: this.options.appId,
      configId: this.options.configId,
      graphApiVersion: this.options.graphApiVersion,
    }
  }

  async createOnboardingSession(input: {
    ownerUserId: string
    teamId: string | null
    displayName: string
  }): Promise<{ sessionId: string; url: string; expiresAt: string }> {
    const sessionId = randomUUID()
    const ticket = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
    await this.deps.repo.createOnboardingSession({
      id: sessionId,
      ownerUserId: input.ownerUserId,
      teamId: input.teamId,
      displayName: input.displayName,
      ticketSha256: createHash('sha256').update(ticket, 'utf8').digest('hex'),
      expiresAt,
    })
    const base = this.options.publicBaseUrl.replace(/\/$/, '')
    return {
      sessionId,
      url: `${base}/whatsapp/cloud/onboard#ticket=${encodeURIComponent(ticket)}`,
      expiresAt: expiresAt.toISOString(),
    }
  }

  async completeOnboardingSession(input: {
    ticket: string
    code: string
    wabaId: string
    phoneNumberId: string
  }): Promise<void> {
    const ticketSha256 = createHash('sha256').update(input.ticket, 'utf8').digest('hex')
    const session = await this.deps.repo.claimOnboardingSession(ticketSha256, new Date())
    if (!session) throw new WhatsAppOnboardingError('关联票据无效或已过期', 'invalid_onboarding_ticket')
    try {
      const account = await this.onboardAccount({
        ownerUserId: session.ownerUserId,
        teamId: session.teamId,
        displayName: session.displayName,
        code: input.code,
        wabaId: input.wabaId,
        phoneNumberId: input.phoneNumberId,
      })
      await this.deps.repo.finishOnboardingSession(session.id, 'completed', account.id, null)
    } catch (error) {
      const code = error instanceof WhatsAppGraphError ? error.code : 'onboarding_failed'
      await this.deps.repo.finishOnboardingSession(session.id, 'failed', null, code)
      throw error
    }
  }

  async onboardingStatus(
    sessionId: string,
    ownerUserId: string,
  ): Promise<Pick<WhatsAppOnboardingSessionRecord, 'state' | 'accountId' | 'expiresAt'> | null> {
    const session = await this.deps.repo.findOnboardingSessionForOwner(sessionId, ownerUserId)
    return session ? {
      state: session.state,
      accountId: session.accountId,
      expiresAt: session.expiresAt,
    } : null
  }

  async onboardAccount(input: OnboardWhatsAppCloudAccountInput): Promise<{
    id: string
    platform: 'whatsapp'
    display_name: string
    status: 'connected'
    owner_user_id: string
    team_id: string | null
    history_available_from: string
    connection_mode: 'cloud_api'
  }> {
    const graph = this.options.graphClient(this.options.graphApiVersion)
    const accessToken = await graph.exchangeEmbeddedSignupCode(input.code)
    await graph.assertPhoneBelongsToWaba(accessToken, input.wabaId, input.phoneNumberId)
    await graph.subscribeWaba(accessToken, input.wabaId)

    const accountId = randomUUID()
    const secretId = randomUUID()
    const linkedAt = new Date()
    const encryptedToken = this.deps.cipher.encrypt(
      accountId,
      WHATSAPP_ACCESS_TOKEN_PURPOSE,
      accessToken,
    )
    const createInput: CreateWhatsAppCloudAccountInput = {
      accountId,
      secretId,
      ownerUserId: input.ownerUserId,
      teamId: input.teamId,
      displayName: input.displayName,
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      graphApiVersion: this.options.graphApiVersion,
      encryptedToken,
      linkedAt,
    }
    await this.deps.repo.createAccount(createInput)
    return {
      id: accountId,
      platform: 'whatsapp',
      display_name: input.displayName,
      status: 'connected',
      owner_user_id: input.ownerUserId,
      team_id: input.teamId,
      history_available_from: linkedAt.toISOString(),
      connection_mode: 'cloud_api',
    }
  }

  async handleWebhook(parsed: ParsedWhatsAppWebhook): Promise<{
    acceptedInbound: number
    acceptedStatuses: number
    unsupportedMessageCount: number
  }> {
    let acceptedInbound = 0
    let acceptedStatuses = 0

    for (const event of parsed.inboundTexts) {
      const account = await this.deps.repo.findByWebhookIdentity(event.wabaId, event.phoneNumberId)
      if (!account) continue
      const normalized: NormalizedMessage = {
        platform: 'whatsapp',
        accountId: account.accountId,
        platformConversationId: `u:${event.senderExternalId}`,
        platformMessageId: event.platformMessageId,
        direction: 'in',
        senderExternalId: event.senderExternalId,
        senderDisplayName: event.senderDisplayName,
        conversationDisplayName: event.senderDisplayName,
        body: event.body,
        mediaRefs: [],
        replyToPlatformMessageId: event.replyToPlatformMessageId,
        sentAt: event.sentAt,
        raw: { source: 'whatsapp_cloud_api', type: 'text' },
      }
      await this.deps.ingestor.ingestDetailed(normalized, this.deps.onInboundStored)
      acceptedInbound++
    }

    for (const event of parsed.statuses) {
      const account = await this.deps.repo.findByWebhookIdentity(event.wabaId, event.phoneNumberId)
      if (!account) continue
      const statusInput: WhatsAppStatusInput = {
        accountId: account.accountId,
        platformMessageId: event.platformMessageId,
        status: event.status,
        statusAt: event.statusAt,
        errorCode: event.errorCode,
      }
      if (await this.deps.repo.saveStatus(statusInput)) acceptedStatuses++
    }

    return {
      acceptedInbound,
      acceptedStatuses,
      unsupportedMessageCount: parsed.unsupportedMessageCount,
    }
  }

  async sendText(input: SendWhatsAppTextInput): Promise<string> {
    const account = await this.deps.repo.findByAccountId(input.accountId)
    if (!account) throw new Error('WhatsApp Cloud API 账号不可用')
    const attemptInput: WhatsAppSendAttemptInput = {
      attemptId: input.attemptId,
      accountId: input.accountId,
      conversationId: input.conversationId,
      actorUserId: input.actorUserId,
      targetExternalId: input.targetExternalId,
      bodySha256: createHash('sha256').update(input.body, 'utf8').digest('hex'),
      authorizationRevision: account.authorizationRevision,
    }
    const { created, attempt } = await this.deps.repo.startAttempt(attemptInput)
    this.assertAttemptMatches(attempt, attemptInput)
    if (!created) return this.resolveExistingAttempt(attempt)

    const accessToken = this.deps.cipher.decrypt(
      account.accountId,
      WHATSAPP_ACCESS_TOKEN_PURPOSE,
      account.encryptedToken,
    )
    let graphAccepted = false
    try {
      const platformMessageId = await this.options.graphClient(account.graphApiVersion).sendText(
        accessToken,
        account.phoneNumberId,
        input.targetExternalId,
        input.body,
      )
      graphAccepted = true
      const sentAt = new Date()
      const accepted: AcceptedWhatsAppMessageInput = {
        attemptId: input.attemptId,
        accountId: input.accountId,
        conversationId: input.conversationId,
        platformMessageId,
        senderExternalId: account.phoneNumberId,
        targetExternalId: input.targetExternalId,
        body: input.body,
        sentAt,
      }
      const stored = await this.deps.repo.completeAccepted(accepted)
      try {
        await this.deps.onOutgoingAccepted(stored.messageId)
      } catch {
        // 最终平台 ID 与消息已经原子落库；实时推送失败只能让客户端稍后重拉，
        // 不能把 accepted 倒退成 unknown，也不能诱导用户再次发送。
        console.error('[whatsapp-cloud] 平台已接受并落库，但实时消息通知失败；客户端需重拉快照')
      }
      return platformMessageId
    } catch (error) {
      if (error instanceof WhatsAppGraphError) {
        const state = error.kind === 'unknown' ? 'unknown' : 'failed'
        await this.deps.repo.finishAttempt(input.attemptId, state, error.code)
      } else if (graphAccepted) {
        // 已拿到最终 id 后本地原子落库失败，绝不能把它退化为“明确未发送”再重试。
        await this.deps.repo.finishAttempt(
          input.attemptId,
          'unknown',
          'post_accept_persistence_failed',
        )
      }
      throw error
    }
  }

  private assertAttemptMatches(
    attempt: WhatsAppSendAttemptRecord,
    expected: WhatsAppSendAttemptInput,
  ): void {
    const matches = attempt.accountId === expected.accountId
      && attempt.conversationId === expected.conversationId
      && attempt.actorUserId === expected.actorUserId
      && attempt.targetExternalId === expected.targetExternalId
      && attempt.bodySha256 === expected.bodySha256
      && attempt.authorizationRevision === expected.authorizationRevision
    if (!matches) {
      throw new WhatsAppCloudAttemptError(
        '同一 attemptId 已绑定其他正文、会话或授权版本',
        'attempt_payload_mismatch',
      )
    }
  }

  private resolveExistingAttempt(attempt: WhatsAppSendAttemptRecord): string {
    if (attempt.state === 'accepted' && attempt.platformMessageId) return attempt.platformMessageId
    if (attempt.state === 'failed') {
      throw new WhatsAppCloudAttemptError('该发送 attempt 已明确失败，请修改后新建 attempt', 'attempt_failed')
    }
    throw new WhatsAppCloudAttemptError(
      '该发送 attempt 的平台结果未知，禁止自动重发，请人工对账',
      'attempt_result_unknown',
    )
  }
}
