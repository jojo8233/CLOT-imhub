import type { WhatsAppSendAttemptRecord } from './whatsapp-web-attempt-ledger.js'
import { normalizeWhatsAppDomText, sha256Text } from './whatsapp-web-utils.js'

export interface WhatsAppAttemptBinding {
  platformConversationId: string
  contextRevision: number
  draftFingerprint: string
}

export type WhatsAppExistingAttemptResolution =
  | { kind: 'new' }
  | { kind: 'mismatch' }
  | { kind: 'pending' }
  | { kind: 'confirmed'; platformMessageId: string }

export interface WhatsAppDomMessageCandidate {
  direction: 'in' | 'out' | null
  text: string
  dataId: string | null
}

export type WhatsAppAttemptGuardResult = 'acquired' | 'pending' | 'mismatch'

/** 同一 renderer 内先于 IndexedDB 事务串行化并发命令，封住双击竞态。 */
export class WhatsAppSendAttemptGuard {
  private readonly active = new Map<string, WhatsAppAttemptBinding>()

  begin(attemptId: string, binding: WhatsAppAttemptBinding): WhatsAppAttemptGuardResult {
    const existing = this.active.get(attemptId)
    if (!existing) {
      this.active.set(attemptId, binding)
      return 'acquired'
    }
    return sameWhatsAppAttemptBinding(existing, binding) ? 'pending' : 'mismatch'
  }

  finish(attemptId: string, binding: WhatsAppAttemptBinding): void {
    const existing = this.active.get(attemptId)
    if (existing && sameWhatsAppAttemptBinding(existing, binding)) this.active.delete(attemptId)
  }
}

/**
 * 相同 attempt 只能恢复既有结论，不能再次触发页面发送。正文、首次 revision 或
 * 会话任一不一致都视为改绑，明确拒绝。
 */
export function resolveWhatsAppExistingAttempt(
  existing: WhatsAppSendAttemptRecord | null,
  binding: WhatsAppAttemptBinding,
): WhatsAppExistingAttemptResolution {
  if (!existing) return { kind: 'new' }
  if (existing.platformConversationId !== binding.platformConversationId
    || existing.contextRevision !== binding.contextRevision
    || existing.draftFingerprint !== binding.draftFingerprint) {
    return { kind: 'mismatch' }
  }
  if (existing.state === 'confirmed' && existing.platformMessageId) {
    return { kind: 'confirmed', platformMessageId: existing.platformMessageId }
  }
  return { kind: 'pending' }
}

function sameWhatsAppAttemptBinding(
  left: WhatsAppAttemptBinding,
  right: WhatsAppAttemptBinding,
): boolean {
  return left.platformConversationId === right.platformConversationId
    && left.contextRevision === right.contextRevision
    && left.draftFingerprint === right.draftFingerprint
}

/** 写账本后、点击前再核对会话、正文和按钮，避免切会话或用户改稿后误发。 */
export function whatsappSendPreflightStillValid(input: {
  contextMatches: boolean
  preparedDraft: string
  currentDraft: string
  sendActionCurrent: boolean
}): boolean {
  return input.contextMatches
    && input.currentDraft === input.preparedDraft
    && input.sendActionCurrent
}

/** 新 attempt 的首次 revision 必须就是当前命令 revision；只有既有账本恢复可以沿用旧值。 */
export function whatsappNewAttemptRevisionIsCurrent(
  attemptContextRevision: number,
  commandContextRevision: number,
): boolean {
  return attemptContextRevision === commandContextRevision
}

/** guest 重新计算页面草稿指纹；正文不进入 attempt 账本。 */
export async function whatsappDraftMatchesFingerprint(
  draft: string,
  fingerprint: string,
): Promise<boolean> {
  return await sha256Text(draft) === fingerprint
}

/**
 * 只接受发送前不存在、正文匹配、方向为 out 且带实际 data-id 的最新消息容器。
 * `wa-dom:` 只标注 Web DOM 确认来源，不是 Cloud API wamid。
 */
export function confirmedWhatsAppDomMessageId(
  draft: string,
  beforeIds: ReadonlySet<string>,
  candidates: readonly WhatsAppDomMessageCandidate[],
): string | null {
  const expected = normalizeWhatsAppDomText(draft)
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]
    if (!candidate
      || candidate.direction !== 'out'
      || normalizeWhatsAppDomText(candidate.text) !== expected
      || !candidate.dataId
      || beforeIds.has(candidate.dataId)) continue
    return `wa-dom:${candidate.dataId}`
  }
  return null
}
