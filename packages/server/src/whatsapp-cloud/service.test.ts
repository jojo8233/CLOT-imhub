import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { WhatsAppGraphClient } from './graph-client.js'
import type { WhatsAppCloudAccountRecord, WhatsAppSendAttemptRecord } from './repo.js'
import { WHATSAPP_ACCESS_TOKEN_PURPOSE } from './repo.js'
import { SecretCipher } from './secret-cipher.js'
import { WhatsAppCloudService } from './service.js'

function graph(finalId = 'wamid.final'): WhatsAppGraphClient {
  return {
    exchangeEmbeddedSignupCode: vi.fn(async () => 'token'),
    assertPhoneBelongsToWaba: vi.fn(async () => {}),
    subscribeWaba: vi.fn(async () => {}),
    sendText: vi.fn(async () => finalId),
  } as unknown as WhatsAppGraphClient
}

function fixture(options: { outgoingNotificationFails?: boolean } = {}) {
  const cipher = new SecretCipher(randomBytes(32))
  const account: WhatsAppCloudAccountRecord = {
    accountId: 'account-id', ownerUserId: 'owner-id', wabaId: 'waba-id',
    phoneNumberId: 'phone-id', graphApiVersion: 'v25.0', authorizationRevision: 1,
    encryptedToken: cipher.encrypt('account-id', WHATSAPP_ACCESS_TOKEN_PURPOSE, 'token'),
  }
  const graphClient = graph()
  const attempts = new Map<string, WhatsAppSendAttemptRecord>()
  const repo = {
    createAccount: vi.fn(async () => {}),
    findByAccountId: vi.fn(async () => account),
    findByWebhookIdentity: vi.fn(async () => account),
    startAttempt: vi.fn(async (input) => {
      const current = attempts.get(input.attemptId)
      if (current) return { created: false, attempt: current }
      const created: WhatsAppSendAttemptRecord = {
        ...input, state: 'sending', platformMessageId: null, errorCode: null,
      }
      attempts.set(input.attemptId, created)
      return { created: true, attempt: created }
    }),
    completeAccepted: vi.fn(async (input) => {
      const current = attempts.get(input.attemptId)
      if (current) attempts.set(input.attemptId, {
        ...current, state: 'accepted', platformMessageId: input.platformMessageId,
      })
      return { messageId: 'message-id' }
    }),
    finishAttempt: vi.fn(async () => {}),
    saveStatus: vi.fn(async () => true),
    createOnboardingSession: vi.fn(async (_input: {
      id: string
      ownerUserId: string
      teamId: string | null
      displayName: string
      ticketSha256: string
      expiresAt: Date
    }) => {}),
    claimOnboardingSession: vi.fn(async () => null),
    finishOnboardingSession: vi.fn(async () => {}),
    findOnboardingSessionForOwner: vi.fn(async () => null),
  }
  const ingestor = { ingestDetailed: vi.fn(async () => ({
    conversationId: 'conversation-id', messageId: 'message-id', isNew: true, contentChanged: false,
  })) }
  const onOutgoingAccepted = vi.fn(async () => {
    if (options.outgoingNotificationFails) throw new Error('socket unavailable')
  })
  const service = new WhatsAppCloudService({
    appId: 'app-id', configId: 'config-id', graphApiVersion: 'v25.0',
    publicBaseUrl: 'https://imhub.example',
    graphClient: () => graphClient,
  }, {
    repo,
    cipher,
    ingestor,
    onInboundStored: vi.fn(async () => {}),
    onOutgoingAccepted,
  })
  return { service, repo, ingestor, graphClient, attempts, onOutgoingAccepted }
}

const sendInput = {
  attemptId: '11111111-1111-4111-8111-111111111111',
  accountId: 'account-id', conversationId: 'conversation-id', actorUserId: 'actor-id',
  targetExternalId: 'customer-id', body: 'translated body',
}

describe('WhatsAppCloudService', () => {
  it('双击同一 attempt 只调用一次 Graph，并复用最终 wamid', async () => {
    const { service, graphClient } = fixture()
    await expect(service.sendText(sendInput)).resolves.toBe('wamid.final')
    await expect(service.sendText(sendInput)).resolves.toBe('wamid.final')
    expect(graphClient.sendText).toHaveBeenCalledTimes(1)
  })

  it('最终 ID 已原子落库后即使实时通知失败也保持成功，避免诱导重复发送', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { service, repo } = fixture({ outgoingNotificationFails: true })
    await expect(service.sendText(sendInput)).resolves.toBe('wamid.final')
    expect(repo.finishAttempt).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('客户端需重拉快照'))
    error.mockRestore()
  })

  it('同一 attemptId 改稿会被 fingerprint 拒绝', async () => {
    const { service } = fixture()
    await service.sendText(sendInput)
    await expect(service.sendText({ ...sendInput, body: 'changed body' }))
      .rejects.toMatchObject({ code: 'attempt_payload_mismatch' })
  })

  it('已有 sending attempt 视为结果未知，不会再次调用 Graph', async () => {
    const { service, attempts, graphClient } = fixture()
    attempts.set(sendInput.attemptId, {
      ...sendInput,
      bodySha256: '2c7b57f01a65a34b6e3c871e202c5876f30ff40ad5b71b727b16f1d555a2fae3',
      authorizationRevision: 1,
      state: 'sending', platformMessageId: null, errorCode: null,
    })
    // 用服务实际算法生成的 fingerprint，避免测试把“正文不匹配”误当作未知结果。
    attempts.clear()
    const first = service.sendText(sendInput)
    await first
    const current = attempts.get(sendInput.attemptId)
    if (current) attempts.set(sendInput.attemptId, { ...current, state: 'sending', platformMessageId: null })
    await expect(service.sendText(sendInput)).rejects.toMatchObject({ code: 'attempt_result_unknown' })
    expect(graphClient.sendText).toHaveBeenCalledTimes(1)
  })

  it('签名解析后的入站纯文字使用官方 wamid 进入中央 ingestor', async () => {
    const { service, ingestor } = fixture()
    await service.handleWebhook({
      inboundTexts: [{
        wabaId: 'waba-id', phoneNumberId: 'phone-id', platformMessageId: 'wamid.in',
        senderExternalId: 'customer-id', senderDisplayName: 'Customer', body: 'hello',
        replyToPlatformMessageId: null, sentAt: new Date('2026-08-31T00:00:00Z'),
      }],
      statuses: [], unsupportedMessageCount: 0,
    })
    expect(ingestor.ingestDetailed).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'whatsapp', platformMessageId: 'wamid.in', direction: 'in',
      platformConversationId: 'u:customer-id', body: 'hello',
    }), expect.any(Function))
  })

  it('onboarding bearer 只放 URL fragment，仓储层只收到 SHA-256', async () => {
    const { service, repo } = fixture()
    const result = await service.createOnboardingSession({
      ownerUserId: 'owner-id', teamId: null, displayName: 'Cloud account',
    })
    expect(result.url).toMatch(/^https:\/\/imhub\.example\/whatsapp\/cloud\/onboard#ticket=/)
    expect(result.url).not.toContain('?ticket=')
    expect(repo.createOnboardingSession).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: 'owner-id', ticketSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    }))
    const stored = repo.createOnboardingSession.mock.calls[0]?.[0]
    expect(result.url).not.toContain(stored?.ticketSha256 ?? 'missing-hash')
  })
})
