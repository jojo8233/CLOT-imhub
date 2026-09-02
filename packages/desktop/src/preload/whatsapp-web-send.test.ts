import { describe, expect, it } from 'vitest'
import type { WhatsAppSendAttemptRecord } from './whatsapp-web-attempt-ledger.js'
import {
  confirmedWhatsAppDomMessageId,
  resolveWhatsAppExistingAttempt,
  WhatsAppSendAttemptGuard,
  whatsappDraftMatchesFingerprint,
  whatsappNewAttemptRevisionIsCurrent,
  whatsappSendActionIsVisible,
  whatsappSendPreflightStillValid,
} from './whatsapp-web-send.js'
import { sha256Text } from './whatsapp-web-utils.js'

const binding = {
  platformConversationId: 'wa:555000111@c.us',
  contextRevision: 7,
  draftFingerprint: 'a'.repeat(64),
}

function attempt(
  overrides: Partial<WhatsAppSendAttemptRecord> = {},
): WhatsAppSendAttemptRecord {
  return {
    attemptId: 'attempt-stable',
    ...binding,
    state: 'pending',
    platformMessageId: null,
    createdAt: 1_788_000_000_000,
    ...overrides,
  }
}

describe('WhatsApp Web send invariants', () => {
  it('双击或 pending attempt 重放只返回结果未知，不产生新发送资格', () => {
    expect(resolveWhatsAppExistingAttempt(attempt(), binding)).toEqual({ kind: 'pending' })
  })

  it('并发双击在首个 IndexedDB 读取前也只有一个命令取得发送资格', () => {
    const guard = new WhatsAppSendAttemptGuard()
    expect(guard.begin('attempt-stable', binding)).toBe('acquired')
    expect(guard.begin('attempt-stable', binding)).toBe('pending')
    expect(guard.begin('attempt-stable', { ...binding, contextRevision: 8 })).toBe('mismatch')
    guard.finish('attempt-stable', binding)
    expect(guard.begin('attempt-stable', binding)).toBe('acquired')
  })

  it('结果丢失或进程重启后只恢复同一 attempt 已确认的最终 DOM id', () => {
    const platformMessageId = 'wa-dom:true_555000111@c.us_FINAL'
    expect(resolveWhatsAppExistingAttempt(attempt({
      state: 'confirmed',
      platformMessageId,
    }), binding)).toEqual({ kind: 'confirmed', platformMessageId })
  })

  it('同一 attempt 不能改绑到其他会话、首次 revision 或正文指纹', () => {
    expect(resolveWhatsAppExistingAttempt(attempt({
      platformConversationId: 'wa:555000222@c.us',
    }), binding)).toEqual({ kind: 'mismatch' })
    expect(resolveWhatsAppExistingAttempt(attempt({ contextRevision: 8 }), binding))
      .toEqual({ kind: 'mismatch' })
    expect(resolveWhatsAppExistingAttempt(attempt({ draftFingerprint: 'b'.repeat(64) }), binding))
      .toEqual({ kind: 'mismatch' })
  })

  it('新 attempt 只能绑定当前 revision，重启恢复旧 revision 由既有账本分支处理', () => {
    expect(whatsappNewAttemptRevisionIsCurrent(7, 7)).toBe(true)
    expect(whatsappNewAttemptRevisionIsCurrent(6, 7)).toBe(false)
  })

  it('写账本后切会话、用户改稿或发送控件变更都会阻止页面点击', () => {
    const valid = {
      contextMatches: true,
      preparedDraft: 'synthetic outbound text',
      currentDraft: 'synthetic outbound text',
      sendActionCurrent: true,
    }
    expect(whatsappSendPreflightStillValid(valid)).toBe(true)
    expect(whatsappSendPreflightStillValid({ ...valid, contextMatches: false })).toBe(false)
    expect(whatsappSendPreflightStillValid({ ...valid, currentDraft: 'user edited text' })).toBe(false)
    expect(whatsappSendPreflightStillValid({ ...valid, sendActionCurrent: false })).toBe(false)
  })

  it('发送控件可见性拒绝零面积 rect 和 collapsed visibility', () => {
    const valid = {
      rects: [{ width: 24, height: 24 }],
      display: 'flex',
      visibility: 'visible',
      pointerEvents: 'auto',
      opacity: '1',
    }
    expect(whatsappSendActionIsVisible(valid)).toBe(true)
    expect(whatsappSendActionIsVisible({
      ...valid,
      rects: [{ width: 0, height: 24 }],
    })).toBe(false)
    expect(whatsappSendActionIsVisible({ ...valid, visibility: 'collapse' })).toBe(false)
  })

  it('guest 用最终页面草稿重新计算 SHA-256，用户改稿后不再匹配', async () => {
    const fingerprint = await sha256Text('synthetic outbound text')
    await expect(whatsappDraftMatchesFingerprint('synthetic outbound text', fingerprint))
      .resolves.toBe(true)
    await expect(whatsappDraftMatchesFingerprint('user edited text', fingerprint))
      .resolves.toBe(false)
  })

  it('只接受发送前不存在、正文匹配且为出站的实际 DOM data-id', () => {
    const beforeIds = new Set(['true_555000111@c.us_EXISTING'])
    const candidates = [
      { direction: 'out' as const, text: 'synthetic outbound text', dataId: 'true_555000111@c.us_EXISTING' },
      { direction: 'in' as const, text: 'synthetic outbound text', dataId: 'false_555000111@c.us_NEW_IN' },
      { direction: 'out' as const, text: 'different text', dataId: 'true_555000111@c.us_NEW_WRONG' },
      { direction: 'out' as const, text: 'synthetic outbound text', dataId: null },
      { direction: 'out' as const, text: 'synthetic outbound text', dataId: 'true_555000111@c.us_FINAL' },
    ]

    expect(confirmedWhatsAppDomMessageId(
      'synthetic outbound text',
      beforeIds,
      candidates,
    )).toBe('wa-dom:true_555000111@c.us_FINAL')
  })

  it('没有满足全部门槛的新容器时保持未知，不借用其他平台消息 ID 算法', () => {
    expect(confirmedWhatsAppDomMessageId(
      'synthetic outbound text',
      new Set(['true_555000111@c.us_EXISTING']),
      [
        { direction: 'out', text: 'synthetic outbound text', dataId: 'true_555000111@c.us_EXISTING' },
        { direction: 'in', text: 'synthetic outbound text', dataId: 'false_555000111@c.us_NEW_IN' },
      ],
    )).toBeNull()
  })
})
