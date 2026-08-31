import {
  NATIVE_BRIDGE_PROTOCOL_VERSION,
  type NativeCommandResultEvent,
  type NativeConversationContext,
  type NativeGuestEvent,
  type NativeHostCommand,
  type NativeTranslationBatchInput,
  type NativeTranslationBatchResult,
} from '@im-hub/shared'
import {
  acknowledgeWhatsAppAttempt,
  discardWhatsAppAttempt,
  latestWhatsAppAttempt,
  readWhatsAppAttempt,
  writeWhatsAppAttempt,
  type WhatsAppSendAttemptRecord,
} from './whatsapp-web-attempt-ledger.js'
import {
  isChineseLanguage,
  normalizeWhatsAppDomText,
  normalizeWhatsAppStorageIdentity,
  sha256Text,
  whatsappChatJidFromDataId,
  whatsappMessageDirectionFromDataId,
} from './whatsapp-web-utils.js'
import {
  confirmedWhatsAppDomMessageId,
  resolveWhatsAppExistingAttempt,
  whatsappDraftMatchesFingerprint,
  whatsappNewAttemptRevisionIsCurrent,
  whatsappSendPreflightStillValid,
  WhatsAppSendAttemptGuard,
} from './whatsapp-web-send.js'
import { WhatsAppDomFailureGate } from './whatsapp-web-health.js'
import { replaceWhatsAppComposerText } from './whatsapp-web-composer.js'

interface WhatsAppBridgeApi {
  emit(event: NativeGuestEvent): void
  onCommand(listener: (command: NativeHostCommand) => void): void
  translateBatch(input: NativeTranslationBatchInput): Promise<NativeTranslationBatchResult[] | undefined>
  detectLanguage(text: string): Promise<string | undefined>
}

interface CurrentContext {
  revision: number
  value: NativeConversationContext
}

interface QueuedTranslation {
  row: HTMLElement
  text: string
  generation: number
}

const IDENTITY_KEYS = ['last-wid-md', 'last-wid', 'WALid'] as const
const MESSAGE_ROW_SELECTORS = [
  '#app [data-testid="drawer-left"] div[role="row"] div[data-id][data-testid^="conv-msg-"]',
  '#app div[data-id][data-testid^="conv-msg-"]',
  '#app div[data-id] .message-in',
  '#app div[data-id] .message-out',
  '#main [data-testid^="conv-msg-"]',
  '#main div[role="row"]',
  '#main .message-in',
  '#main .message-out',
] as const
const MESSAGE_TEXT_SELECTORS = [
  'span.copyable-text[data-testid*="selectable-text"]:not([data-pre-plain-text]):not(.quoted-mention)',
  'span.copyable-text:not([data-pre-plain-text]):not(.quoted-mention)',
  '.selectable-text:not([data-pre-plain-text]):not(.quoted-mention)',
  'span.copyable-text span[data-testid*="selectable-text"]:not([data-pre-plain-text]):not(.quoted-mention)',
  '.copyable-text:not(.quoted-mention)',
] as const
const COMPOSER_SELECTORS = [
  '#main footer [data-testid="conversation-compose-box-input"][contenteditable="true"]',
  '#main footer div[contenteditable="true"][role="textbox"]',
  '#main footer div[contenteditable="true"]',
] as const
const SEND_BUTTON_SELECTORS = [
  '#main footer [data-testid="compose-btn-send"]',
  '#main footer button [data-icon="send"]',
  '#main footer [role="button"] [data-icon="send"]',
] as const
const TRANSLATION_ATTRIBUTE = 'data-imhub-whatsapp-translation'
const MAX_TRANSLATION_CACHE = 500
const MAX_TRANSLATION_CONCURRENCY = 3

export function startWhatsAppWebBridge(api: WhatsAppBridgeApi): void {
  new WhatsAppWebController(api).start()
}

class WhatsAppWebController {
  private identity: string | null = null
  private lastIdentityEmittedAt = 0
  private missingIdentityTicks = 0
  private context: CurrentContext | null = null
  private contextRevision = 0
  private contextGeneration = 0
  private proxyReady = false
  private observer: MutationObserver | null = null
  private scanTimer: ReturnType<typeof setTimeout> | null = null
  private lastComposerSignature = ''
  private lastComposerEmittedAt = 0
  private translatedRows = new WeakMap<HTMLElement, string>()
  private queuedRows = new WeakSet<HTMLElement>()
  private readonly translationQueue: QueuedTranslation[] = []
  private readonly translationCache = new Map<string, Promise<string>>()
  private activeTranslations = 0
  private translationGeneration = 0
  private readonly selectorFailureGate = new WhatsAppDomFailureGate(6_000)
  private readonly bridgePhaseFailureGate = new WhatsAppDomFailureGate(15_000)
  private translationVisibilityTicks = 0
  private translationVisibilityReported = false
  private translationVisibilityTimer: ReturnType<typeof setTimeout> | null = null
  private readonly sendAttemptGuard = new WhatsAppSendAttemptGuard()

  constructor(private readonly api: WhatsAppBridgeApi) {}

  start(): void {
    this.api.onCommand(command => { void this.handleCommand(command) })
    this.api.emit({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'bridge.ready',
    })
    const install = (): void => {
      if (this.observer) return
      this.observer = new MutationObserver(() => this.scheduleScan())
      this.observer.observe(document.documentElement, {
        childList: true,
        characterData: true,
        subtree: true,
      })
      setInterval(() => { void this.tick() }, 750)
      void this.tick()
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', install, { once: true })
    } else {
      install()
    }
  }

  private async tick(): Promise<void> {
    this.refreshIdentity()
    await this.refreshContext()
    this.scanMessages()
    await this.emitComposerState()
  }

  private refreshIdentity(): void {
    const next = readCurrentIdentity()
    if (next) {
      this.missingIdentityTicks = 0
      const changed = next !== this.identity
      if (!changed && Date.now() - this.lastIdentityEmittedAt < 3_000) return
      this.identity = next
      this.lastIdentityEmittedAt = Date.now()
      if (changed) {
        this.proxyReady = false
        this.resetPageTranslations()
      }
      this.api.emit({
        protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
        type: 'account.identity',
        platformAccountExternalId: next,
      })
      return
    }
    if (!this.identity) return
    this.missingIdentityTicks += 1
    if (this.missingIdentityTicks < 8) return
    this.identity = null
    this.lastIdentityEmittedAt = 0
    this.proxyReady = false
    this.updateContext(null)
    this.resetPageTranslations()
    this.api.emit({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'account.signed-out',
    })
  }

  private async refreshContext(): Promise<void> {
    const generation = ++this.contextGeneration
    const main = document.querySelector<HTMLElement>('#main')
    if (!main) {
      if (this.context) this.updateContext(null)
      return
    }
    const title = currentConversationTitle(main)
    const jid = currentConversationJid(main)
    if (!jid && !title) return
    const platformConversationId = jid
      ? `wa:${jid}`
      : `wa-title:${(await sha256Text(title ?? '')).slice(0, 32)}`
    if (generation !== this.contextGeneration) return
    this.updateContext({
      platformConversationId,
      contactExternalId: jid ?? platformConversationId,
      contactDisplayName: title,
    })
  }

  private updateContext(value: NativeConversationContext | null): void {
    if (sameContext(this.context?.value ?? null, value)) return
    this.contextRevision += 1
    this.context = value ? { revision: this.contextRevision, value } : null
    this.lastComposerSignature = ''
    this.api.emit({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'context.changed',
      contextRevision: this.contextRevision,
      context: value,
    })
  }

  private resetPageTranslations(): void {
    this.translationGeneration += 1
    for (const marker of document.querySelectorAll(`[${TRANSLATION_ATTRIBUTE}]`)) marker.remove()
    this.translationQueue.length = 0
    this.translationCache.clear()
    this.translatedRows = new WeakMap()
    this.queuedRows = new WeakSet()
  }

  private scheduleScan(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer)
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null
      this.scanMessages()
      void this.emitComposerState()
    }, 120)
  }

  private scanMessages(): void {
    const main = document.querySelector<HTMLElement>('#main')
    const stalledPhase = !this.identity ? 'identity' : !this.proxyReady ? 'proxyReady' : !main ? 'main' : null
    if (stalledPhase) {
      if (this.bridgePhaseFailureGate.observeFailure(stalledPhase, Date.now())) {
        this.api.emit({
          protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
          type: 'bridge.error',
          code: 'whatsapp_bridge_phase_stalled',
          message: `WhatsApp 双语桥接停在 ${stalledPhase} 阶段`,
        })
      }
      return
    }
    this.bridgePhaseFailureGate.observeHealthy()
    const rows = currentMessageRows().slice(-300)
    this.updateSelectorHealth(rows)
    for (const row of rows) {
      const text = messageText(row)
      if (!text || text.length > 4_000) continue
      if (this.translatedRows.get(row) === text && translationMarker(row, false)) continue
      if (this.queuedRows.has(row)) continue
      const marker = translationMarker(row, true)
      if (!marker) continue
      marker.textContent = '翻译中…'
      this.queuedRows.add(row)
      this.translationQueue.push({ row, text, generation: this.translationGeneration })
    }
    this.drainTranslationQueue()
    this.scheduleTranslationVisibilityCheck()
  }

  private scheduleTranslationVisibilityCheck(): void {
    if (this.translationVisibilityTimer) return
    this.translationVisibilityTimer = setTimeout(() => {
      this.translationVisibilityTimer = null
      this.updateTranslationVisibility()
    }, 400)
  }

  private updateTranslationVisibility(): void {
    const rows = currentMessageRows().slice(-300)
    const readable = rows.filter(row => Boolean(messageText(row)))
    if (readable.length === 0) {
      this.translationVisibilityTicks = 0
      return
    }
    const markers = readable.flatMap(row => [translationMarker(row, false)]).filter(isHTMLElement)
    const connected = markers.filter(marker => marker.isConnected)
    const visible = connected.filter(marker => markerVisibleInViewport(marker))
    const loading = connected.filter(marker => marker.textContent === '翻译中…').length
    const failed = connected.filter(marker => marker.hasAttribute('data-imhub-translation-error')).length
    const stats = {
      rows: rows.length,
      readable: readable.length,
      markers: markers.length,
      connected: connected.length,
      visible: visible.length,
      loading,
      failed,
      translated: Math.max(0, connected.length - loading - failed),
      queued: this.translationQueue.length,
      active: this.activeTranslations,
    }
    if (visible.length > 0) {
      this.translationVisibilityTicks = 0
      this.translationVisibilityReported = false
      return
    }
    this.translationVisibilityTicks += 1
    if (this.translationVisibilityTicks < 8 || this.translationVisibilityReported) return
    this.translationVisibilityReported = true
    this.api.emit({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'bridge.error',
      code: 'whatsapp_translation_marker_hidden',
      message: `WhatsApp 译文节点未进入可见布局；安全诊断：${JSON.stringify(stats)}`,
    })
  }

  private updateSelectorHealth(rows: HTMLElement[]): void {
    const main = document.querySelector<HTMLElement>('#main')
      ?? document.querySelector<HTMLElement>('#app')
    const hasReadableMessage = rows.some(row => Boolean(messageText(row)))
    if (!main || hasReadableMessage) {
      if (this.selectorFailureGate.observeHealthy()) {
        this.api.emit({
          protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
          type: 'bridge.ready',
        })
        this.refreshIdentity()
      }
      return
    }
    if (!this.selectorFailureGate.observeFailure('selector', Date.now())) return
    this.api.emit({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'bridge.error',
      code: 'whatsapp_dom_selector_unavailable',
      message: `WhatsApp 页面结构已变化，双语气泡暂不可用；安全诊断：${whatsappDomDiagnostic(main, rows).slice(0, 1_500)}`,
    })
  }

  private drainTranslationQueue(): void {
    while (this.activeTranslations < MAX_TRANSLATION_CONCURRENCY) {
      const next = this.translationQueue.shift()
      if (!next) return
      this.activeTranslations += 1
      void this.translateRow(next).finally(() => {
        this.activeTranslations -= 1
        this.queuedRows.delete(next.row)
        this.drainTranslationQueue()
      })
    }
  }

  private async translateRow(item: QueuedTranslation): Promise<void> {
    if (item.generation !== this.translationGeneration) return
    const marker = translationMarker(item.row, true)
    if (!marker) return
    try {
      const translated = await this.translateText(item.text)
      if (item.generation !== this.translationGeneration
        || !item.row.isConnected
        || messageText(item.row) !== item.text) {
        this.scheduleScan()
        return
      }
      marker.textContent = translated
      marker.removeAttribute('data-imhub-translation-error')
      marker.onclick = null
      this.translatedRows.set(item.row, item.text)
    } catch {
      marker.textContent = '翻译暂不可用 · 点击重试'
      marker.setAttribute('data-imhub-translation-error', 'true')
      this.translatedRows.set(item.row, item.text)
      marker.onclick = () => {
        this.translatedRows.delete(item.row)
        marker.remove()
        this.scheduleScan()
      }
    }
  }

  private translateText(text: string): Promise<string> {
    const cached = this.translationCache.get(text)
    if (cached) return cached
    const operation = (async (): Promise<string> => {
      const detected = await this.api.detectLanguage(text)
      let targetLang = isChineseLanguage(detected) ? 'en' : 'zh'
      let result = (await this.api.translateBatch({
        texts: [text], targetLang, ...(detected ? { sourceLang: detected } : {}),
      }))?.[0]
      if (!detected && result && isChineseLanguage(result.detectedLang) && targetLang === 'zh') {
        targetLang = 'en'
        result = (await this.api.translateBatch({
          texts: [text], targetLang, sourceLang: result.detectedLang,
        }))?.[0]
      }
      if (!result || result.failed || !result.translated.trim()) throw new Error('translation failed')
      return result.translated
    })().catch(error => {
      this.translationCache.delete(text)
      throw error
    })
    if (this.translationCache.size >= MAX_TRANSLATION_CACHE) {
      const oldest = this.translationCache.keys().next().value
      if (typeof oldest === 'string') this.translationCache.delete(oldest)
    }
    this.translationCache.set(text, operation)
    return operation
  }

  private async handleCommand(command: NativeHostCommand): Promise<void> {
    if (command.type === 'bridge.request-state') {
      this.proxyReady = true
      if (this.identity) {
        this.api.emit({
          protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
          type: 'account.identity',
          platformAccountExternalId: this.identity,
        })
      }
      this.api.emit({
        protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
        type: 'context.changed',
        contextRevision: this.contextRevision,
        context: this.context?.value ?? null,
      })
      this.scanMessages()
      await this.emitComposerState(true)
      return
    }
    if (command.type === 'composer.ack-send') {
      await acknowledgeWhatsAppAttempt(command.attemptId, command.platformMessageId)
      await this.emitComposerState(true)
      return
    }
    if (command.type !== 'composer.get-draft'
      && command.type !== 'composer.set-draft'
      && command.type !== 'composer.send') return
    if (!this.commandMatchesContext(command)) {
      this.emitCommandFailure(command, 'stale_context', 'WhatsApp 当前会话已经变化')
      return
    }
    if (command.type === 'composer.get-draft') {
      const input = composerInput()
      if (!input) {
        this.emitCommandFailure(command, 'whatsapp_composer_unavailable', 'WhatsApp 输入框不可用')
        return
      }
      this.emitCommandSuccess(command, { draft: composerText(input) })
      return
    }
    if (command.type === 'composer.set-draft') {
      const input = composerInput()
      if (!input || !setComposerText(input, command.text)) {
        this.emitCommandFailure(command, 'whatsapp_draft_write_failed', '无法写入 WhatsApp 输入框')
        return
      }
      const confirmed = await waitUntil(
        () => composerText(input) === normalizeWhatsAppDomText(command.text),
        1_500,
      )
      if (!confirmed || !this.commandMatchesContext(command)) {
        this.emitCommandFailure(command, 'whatsapp_draft_write_failed', 'WhatsApp 输入框未确认新草稿')
        return
      }
      this.emitCommandSuccess(command, { draft: composerText(input) })
      await this.emitComposerState(true)
      return
    }
    await this.sendComposer(command)
  }

  private commandMatchesContext(command: {
    contextRevision: number
    platformConversationId: string
  }): boolean {
    return this.context?.revision === command.contextRevision
      && this.context.value.platformConversationId === command.platformConversationId
  }

  private async sendComposer(command: Extract<NativeHostCommand, { type: 'composer.send' }>): Promise<void> {
    if (!command.draftFingerprint || command.attemptContextRevision === undefined) {
      this.emitCommandFailure(command, 'whatsapp_attempt_unbound', 'WhatsApp 发送缺少正文指纹')
      return
    }
    const binding = {
      platformConversationId: command.platformConversationId,
      contextRevision: command.attemptContextRevision,
      draftFingerprint: command.draftFingerprint,
    }
    const guardResult = this.sendAttemptGuard.begin(command.attemptId, binding)
    if (guardResult !== 'acquired') {
      this.emitCommandFailure(
        command,
        guardResult === 'mismatch' ? 'attempt_context_mismatch' : 'whatsapp_send_result_unknown',
        guardResult === 'mismatch'
          ? 'WhatsApp 发送 attempt 与正文或会话不一致'
          : 'WhatsApp 发送正在确认，已阻止重复发送',
      )
      return
    }
    try {
      await this.sendComposerWithGuard(command, binding)
    } finally {
      this.sendAttemptGuard.finish(command.attemptId, binding)
    }
  }

  private async sendComposerWithGuard(
    command: Extract<NativeHostCommand, { type: 'composer.send' }>,
    binding: {
      platformConversationId: string
      contextRevision: number
      draftFingerprint: string
    },
  ): Promise<void> {
    let existing: WhatsAppSendAttemptRecord | null
    try {
      existing = await readWhatsAppAttempt(command.attemptId)
    } catch {
      this.emitCommandFailure(command, 'whatsapp_send_ledger_unavailable', 'WhatsApp 发送账本不可用，未发送')
      return
    }
    const existingResolution = resolveWhatsAppExistingAttempt(existing, {
      platformConversationId: binding.platformConversationId,
      contextRevision: binding.contextRevision,
      draftFingerprint: binding.draftFingerprint,
    })
    if (existingResolution.kind !== 'new') {
      if (existingResolution.kind === 'mismatch') {
        this.emitCommandFailure(command, 'attempt_context_mismatch', 'WhatsApp 发送 attempt 与正文或会话不一致')
        return
      }
      if (existingResolution.kind === 'confirmed') {
        this.emitCommandSuccess(command, { platformMessageId: existingResolution.platformMessageId })
      } else {
        this.emitCommandFailure(command, 'whatsapp_send_result_unknown', '上次 WhatsApp 发送结果未知，已阻止重复发送')
      }
      return
    }
    if (!whatsappNewAttemptRevisionIsCurrent(binding.contextRevision, command.contextRevision)) {
      this.emitCommandFailure(command, 'attempt_context_mismatch', 'WhatsApp 新发送 attempt 的初始会话版本不匹配')
      return
    }
    const input = composerInput()
    const draft = input ? composerText(input) : ''
    if (!input || !draft) {
      this.emitCommandFailure(command, 'whatsapp_composer_empty', 'WhatsApp 输入框为空，未发送')
      return
    }
    if (!await whatsappDraftMatchesFingerprint(draft, binding.draftFingerprint)) {
      this.emitCommandFailure(command, 'attempt_context_mismatch', 'WhatsApp 输入框正文已经变化')
      return
    }
    const sendTarget = sendButton()
    if (!sendTarget) {
      this.emitCommandFailure(command, 'whatsapp_send_unavailable', 'WhatsApp 发送按钮不可用')
      return
    }
    const beforeIds = new Set(currentMessageRows()
      .map(messageDataId)
      .filter((value): value is string => value !== null))
    const attempt: WhatsAppSendAttemptRecord = {
      attemptId: command.attemptId,
      platformConversationId: command.platformConversationId,
      contextRevision: binding.contextRevision,
      draftFingerprint: binding.draftFingerprint,
      state: 'pending',
      platformMessageId: null,
      createdAt: Date.now(),
    }
    try {
      await writeWhatsAppAttempt(attempt)
    } catch {
      this.emitCommandFailure(command, 'whatsapp_send_ledger_unavailable', 'WhatsApp 发送账本不可用，未发送')
      return
    }
    if (!whatsappSendPreflightStillValid({
      contextMatches: this.commandMatchesContext(command),
      preparedDraft: draft,
      currentDraft: composerText(input),
      sendTargetConnected: sendTarget.isConnected,
    })) {
      try {
        await discardWhatsAppAttempt(command.attemptId)
      } catch {
        this.emitCommandFailure(command, 'whatsapp_send_ledger_unavailable', 'WhatsApp 会话已变化且发送账本清理失败')
        return
      }
      this.emitCommandFailure(command, 'attempt_context_mismatch', 'WhatsApp 会话或输入框在发送前已经变化')
      return
    }
    sendTarget.click()
    const platformMessageId = await waitForOutgoingMessage(
      draft,
      beforeIds,
      6_000,
      () => this.commandMatchesContext(command),
    )
    if (!platformMessageId) {
      this.emitCommandFailure(command, 'whatsapp_send_result_unknown', 'WhatsApp 已执行发送，但未确认最终消息 ID')
      await this.emitComposerState(true)
      return
    }
    attempt.state = 'confirmed'
    attempt.platformMessageId = platformMessageId
    try {
      await writeWhatsAppAttempt(attempt)
    } catch {
      this.emitCommandFailure(command, 'whatsapp_send_result_unknown', 'WhatsApp 已确认消息，但发送账本更新失败')
      return
    }
    this.emitCommandSuccess(command, { platformMessageId })
    await this.emitComposerState(true)
  }

  private emitCommandSuccess(
    command: Extract<NativeHostCommand, {
      type: 'composer.get-draft' | 'composer.set-draft' | 'composer.send'
    }>,
    extra: { draft?: string; platformMessageId?: string },
  ): void {
    this.api.emit({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'command.result',
      requestId: command.requestId,
      command: command.type,
      contextRevision: command.contextRevision,
      ok: true,
      ...(command.type === 'composer.send' ? { attemptId: command.attemptId } : {}),
      ...extra,
    } satisfies NativeCommandResultEvent)
  }

  private emitCommandFailure(
    command: Extract<NativeHostCommand, {
      type: 'composer.get-draft' | 'composer.set-draft' | 'composer.send'
    }>,
    code: string,
    message: string,
  ): void {
    this.api.emit({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'command.result',
      requestId: command.requestId,
      command: command.type,
      contextRevision: command.contextRevision,
      ok: false,
      ...(command.type === 'composer.send' ? { attemptId: command.attemptId } : {}),
      error: { code, message },
    } satisfies NativeCommandResultEvent)
  }

  private async emitComposerState(force = false): Promise<void> {
    const context = this.context
    if (!context) return
    const input = composerInput()
    const draft = input ? composerText(input) : ''
    const attempt = await latestWhatsAppAttempt(context.value.platformConversationId)
    const signature = JSON.stringify([
      context.revision, draft, Boolean(input && draft), attempt?.attemptId,
      attempt?.state, attempt?.platformMessageId,
    ])
    if (!force && signature === this.lastComposerSignature
      && Date.now() - this.lastComposerEmittedAt < 3_000) return
    this.lastComposerSignature = signature
    this.lastComposerEmittedAt = Date.now()
    this.api.emit({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'composer.state',
      contextRevision: context.revision,
      platformConversationId: context.value.platformConversationId,
      draft,
      canSend: Boolean(input && draft),
      ...(attempt ? {
        sendAttempt: {
          attemptId: attempt.attemptId,
          contextRevision: attempt.contextRevision,
          draftFingerprint: attempt.draftFingerprint,
          platformMessageId: attempt.platformMessageId,
        },
      } : {}),
    })
  }
}

function readCurrentIdentity(): string | null {
  try {
    for (const key of IDENTITY_KEYS) {
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const identity = normalizeWhatsAppStorageIdentity(raw)
      if (identity) return identity
    }
  } catch {
    // 页面存储暂不可读时维持 waiting，不输出存储内容。
  }
  return null
}

function currentConversationTitle(main: HTMLElement): string | null {
  const selectors = [
    'header [data-testid="conversation-info-header-chat-title"]',
    'header span[title]',
    'header [dir="auto"]',
  ]
  for (const selector of selectors) {
    const element = main.querySelector<HTMLElement>(selector)
    const title = normalizeWhatsAppDomText(element?.getAttribute('title') ?? element?.textContent ?? '')
    if (title) return title.slice(0, 512)
  }
  return null
}

function currentConversationJid(main: HTMLElement): string | null {
  for (const row of messageRows(main).reverse()) {
    const raw = messageDataId(row)
    const jid = raw ? whatsappChatJidFromDataId(raw) : null
    if (jid) return jid
  }
  const selected = document.querySelector<HTMLElement>('#pane-side [aria-selected="true"]')
  if (!selected) return null
  for (const element of [selected, ...selected.querySelectorAll<HTMLElement>('[data-id]')]) {
    const jid = whatsappChatJidFromDataId(element.getAttribute('data-id') ?? '')
    if (jid) return jid
  }
  return null
}

function sameContext(left: NativeConversationContext | null, right: NativeConversationContext | null): boolean {
  return left?.platformConversationId === right?.platformConversationId
    && left?.contactExternalId === right?.contactExternalId
    && left?.contactDisplayName === right?.contactDisplayName
}

function messageRows(root: ParentNode = document): HTMLElement[] {
  const seen = new Set<HTMLElement>()
  const seenIds = new Set<string>()
  const rows: HTMLElement[] = []
  for (const selector of MESSAGE_ROW_SELECTORS) {
    const scopedSelector = root === document
      ? selector
      : selector.replace(/^#(?:main|app) /, '')
    for (const candidate of root.querySelectorAll<HTMLElement>(scopedSelector)) {
      const row = candidate.closest<HTMLElement>('.message-in, .message-out')
        ?? (candidate.matches('[data-id][data-testid^="conv-msg-"]')
          ? candidate
          : candidate.querySelector<HTMLElement>('[data-id][data-testid^="conv-msg-"]') ?? candidate)
      const dataId = messageDataId(row)
      if (seen.has(row) || (dataId !== null && seenIds.has(dataId))) continue
      if (!canonicalMessageRow(row) && !messageDirection(row)) continue
      seen.add(row)
      if (dataId !== null) seenIds.add(dataId)
      rows.push(row)
    }
  }
  return rows
}

function canonicalMessageRow(row: HTMLElement): boolean {
  if (!messageDataId(row)) return false
  return row.matches('[data-testid^="conv-msg-"]')
    || row.closest('[data-testid^="conv-msg-"]') !== null
    || row.querySelector('[data-testid^="conv-msg-"]') !== null
}

function currentMessageRows(): HTMLElement[] {
  const main = document.querySelector<HTMLElement>('#main')
  return main ? messageRows(main) : []
}

function whatsappTextLeafCandidates(root: HTMLElement): HTMLElement[] {
  const candidates = new Set<HTMLElement>()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement
    if (!parent
      || parent.closest('header, footer, [contenteditable="true"], [data-imhub-whatsapp-translation]')) continue
    const length = normalizeWhatsAppDomText(node.nodeValue ?? '').length
    if (length > 0 && length <= 4_000) candidates.add(parent)
  }
  return [...candidates]
}

function whatsappDomDiagnostic(root: HTMLElement | null, rows: HTMLElement[]): string {
  if (!root) return JSON.stringify({ root: false })
  const count = (selector: string): number => root.querySelectorAll(selector).length
  const structures = new Map<string, number>()
  for (const element of whatsappTextLeafCandidates(root)) {
    const structure = whatsappElementStructure(element, root)
    structures.set(structure, (structures.get(structure) ?? 0) + 1)
  }
  return JSON.stringify({
    root: root.id === 'main' ? 'main' : 'app',
    rows: rows.length,
    dataId: count('[data-id]'),
    roleRow: count('[role="row"]'),
    messageDirection: count('.message-in, .message-out'),
    conversationMessage: count('[data-testid^="conv-msg-"]'),
    dataPrePlain: count('[data-pre-plain-text]'),
    copyableText: count('.copyable-text'),
    selectableText: count('.selectable-text'),
    selectableTestId: count('[data-testid*="selectable-text"]'),
    dirAuto: count('[dir="auto"]'),
    dirLtr: count('[dir="ltr"]'),
    textLeaves: whatsappTextLeafCandidates(root).length,
    structures: [...structures.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 4),
  })
}

function whatsappElementStructure(element: HTMLElement, root: HTMLElement): string {
  const parts: string[] = []
  let current: HTMLElement | null = element
  for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
    const classes = [...current.classList].slice(0, 6).join('.')
    const attributes = [...current.attributes]
      .map(attribute => attribute.name)
      .filter(name => !['class', 'style', 'title', 'aria-label', 'data-id'].includes(name))
      .slice(0, 6)
      .join(',')
    parts.push(`${current.tagName.toLowerCase()}${classes ? `.${classes}` : ''}${attributes ? `[${attributes}]` : ''}`)
    if (current === root) break
  }
  return parts.join('>')
}

function isHTMLElement(value: HTMLElement | null): value is HTMLElement {
  return value !== null
}

function markerVisibleInViewport(marker: HTMLElement): boolean {
  const style = getComputedStyle(marker)
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
  const rect = marker.getBoundingClientRect()
  return rect.width > 0
    && rect.height > 0
    && rect.bottom > 0
    && rect.right > 0
    && rect.top < window.innerHeight
    && rect.left < window.innerWidth
}

function messageDirection(row: HTMLElement): 'in' | 'out' | null {
  if (row.matches('.message-in') || row.querySelector('.message-in')) return 'in'
  if (row.matches('.message-out') || row.querySelector('.message-out')) return 'out'
  const className = row.className
  if (typeof className === 'string' && /(^|\s)message-in(\s|$)/.test(className)) return 'in'
  if (typeof className === 'string' && /(^|\s)message-out(\s|$)/.test(className)) return 'out'
  if (row.querySelector('[data-icon="tail-in"], [data-testid*="tail-in"]')) return 'in'
  if (row.querySelector('[data-icon="tail-out"], [data-testid*="tail-out"]')) return 'out'
  const fromDataId = whatsappMessageDirectionFromDataId(messageDataId(row))
  if (fromDataId) return fromDataId
  if (row.querySelector([
    '[data-icon="msg-check"]',
    '[data-icon="msg-dblcheck"]',
    '[data-icon="msg-time"]',
    '[data-icon="msg-error"]',
    '[data-testid="msg-check"]',
    '[data-testid="msg-dblcheck"]',
  ].join(', '))) return 'out'
  if (!canonicalMessageRow(row)) return null
  const anchor = messageTextElement(row) ?? row
  const rect = anchor.getBoundingClientRect()
  const mainRect = document.querySelector<HTMLElement>('#main')?.getBoundingClientRect()
  const frameLeft = mainRect && mainRect.width > 0 ? mainRect.left : 0
  const frameWidth = mainRect && mainRect.width > 0 ? mainRect.width : window.innerWidth
  if (rect.width <= 0 || frameWidth <= 0) return null
  return rect.left + rect.width / 2 < frameLeft + frameWidth / 2 ? 'in' : 'out'
}

function messageTextElement(row: HTMLElement): HTMLElement | null {
  for (const selector of MESSAGE_TEXT_SELECTORS) {
    const best = [...row.querySelectorAll<HTMLElement>(selector)]
      .filter(element => !element.closest(`[${TRANSLATION_ATTRIBUTE}]`)
        && !element.matches('[contenteditable="true"]'))
      .sort((left, right) => normalizeWhatsAppDomText(right.textContent ?? '').length
        - normalizeWhatsAppDomText(left.textContent ?? '').length)[0]
    if (best) return best
  }
  return null
}

function messageText(row: HTMLElement): string {
  const element = messageTextElement(row)
  if (!element) return ''
  const clone = element.cloneNode(true) as HTMLElement
  for (const translation of clone.querySelectorAll(`[${TRANSLATION_ATTRIBUTE}]`)) translation.remove()
  return normalizeWhatsAppDomText(clone.textContent ?? '')
}

function translationMarker(row: HTMLElement, create: boolean): HTMLElement | null {
  const existing = row.querySelector<HTMLElement>(`[${TRANSLATION_ATTRIBUTE}="true"]`)
  if (existing || !create) return existing
  const text = messageTextElement(row)
  if (!text) return null
  const marker = document.createElement('div')
  marker.setAttribute(TRANSLATION_ATTRIBUTE, 'true')
  marker.setAttribute('role', 'note')
  marker.style.cssText = [
    'border-top:1px solid color-mix(in srgb,currentColor 24%,transparent)',
    'margin-top:5px',
    'padding-top:5px',
    'white-space:pre-wrap',
    'overflow-wrap:anywhere',
    'font-size:0.95em',
    'line-height:1.35',
    'opacity:0.88',
    'display:block',
    'width:100%',
  ].join(';')
  // 当前 WhatsApp 父层会裁切额外子项；TranGPT 也把翻译 root 直接挂在正文元素内。
  // messageText() 会在读取原文时移除该 marker 的 clone，避免把译文再次送去翻译。
  text.append(marker)
  return marker
}

function messageDataId(row: HTMLElement): string | null {
  const owner = row.closest<HTMLElement>('[data-id]')
  const raw = row.getAttribute('data-id')
    ?? owner?.getAttribute('data-id')
    ?? row.querySelector<HTMLElement>('[data-id]')?.getAttribute('data-id')
  return raw && raw.length <= 500 ? raw : null
}

function composerInput(): HTMLElement | null {
  for (const selector of COMPOSER_SELECTORS) {
    const input = document.querySelector<HTMLElement>(selector)
    if (input) return input
  }
  return null
}

function composerText(input: HTMLElement): string {
  return normalizeWhatsAppDomText(input.innerText || input.textContent || '')
}

function setComposerText(input: HTMLElement, text: string): boolean {
  try {
    return replaceWhatsAppComposerText({
      focus: () => { input.focus() },
      selectContents: () => {
        const selection = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(input)
        selection?.removeAllRanges()
        selection?.addRange(range)
      },
      insertText: value => document.execCommand('insertText', false, value),
      readText: () => composerText(input),
    }, text)
  } catch {
    return false
  }
}

function sendButton(): HTMLElement | null {
  for (const selector of SEND_BUTTON_SELECTORS) {
    const candidate = document.querySelector<HTMLElement>(selector)
    const button = candidate?.closest<HTMLElement>('button, [role="button"]') ?? candidate
    if (button) return button
  }
  return null
}

async function waitForOutgoingMessage(
  draft: string,
  beforeIds: ReadonlySet<string>,
  timeoutMs: number,
  contextStillCurrent: () => boolean,
): Promise<string | null> {
  const expected = normalizeWhatsAppDomText(draft)
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (!contextStillCurrent()) return null
    const confirmed = confirmedWhatsAppDomMessageId(expected, beforeIds, currentMessageRows().map(row => ({
      direction: messageDirection(row),
      text: messageText(row),
      dataId: messageDataId(row),
    })))
    if (confirmed) return confirmed
    await delay(150)
  }
  return null
}

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return true
    await delay(50)
  }
  return false
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
