import type { WsTranslationEvent } from '@im-hub/shared'
import type { EngineConfig, TranslationGateway } from '../translation/gateway.js'
import type { TranslateJobData } from './queue.js'
import { bilingualTranslationTarget } from '../translation/incoming-target.js'

export interface TranslateJobDeps {
  loadMessage(messageId: string): Promise<{
    id: string
    body: string
    direction: 'in' | 'out'
    conversationId: string
    accountId: string
    platform: 'telegram' | 'signal' | 'whatsapp' | 'zoom'
    platformMessageId: string
    bodyLang: string | null
    revision: string
  } | null>
  loadEngineConfig(conversationId: string): Promise<EngineConfig>
  /** 已有译文时跳过：MessageIngestor 对重复消息也会派发任务，靠这里挡住重复翻译 */
  hasTranslation(messageId: string, targetLang: string): Promise<boolean>
  gateway: Pick<TranslationGateway, 'translate'>
  saveTranslation(input: {
    messageId: string
    targetLang: string
    provider: string
    translatedText: string
    revision: string
    detectedLang: string | null
  }): Promise<boolean>
  publish(event: WsTranslationEvent): Promise<void>
}

export async function runTranslateJob(data: TranslateJobData, deps: TranslateJobDeps): Promise<void> {
  const message = await deps.loadMessage(data.messageId)
  if (!message) return
  // Signal 原生气泡要求入向与出向都显示双语；其他平台仍保持原有只翻译入向边界，
  // 避免在没有产品验收的情况下扩大翻译调用量。
  if (message.direction === 'out' && message.platform !== 'signal') return
  if (message.body.trim() === '') return
  const expectedRevision = data.revision ?? message.revision
  // 旧版本任务可能还在队列中。翻译前先挡一次，写入时还会在行锁下再校验一次。
  if (message.revision !== expectedRevision) return

  // BullMQ 的 jobId 去重只在任务还在队列里时有效；任务完成并被清理后，
  // 同一 messageId 再次入队会真的再跑一遍。这里兜住那种情况。
  let targetLang = bilingualTranslationTarget(message.bodyLang)
  if (await deps.hasTranslation(message.id, targetLang)) return

  const config = await deps.loadEngineConfig(data.conversationId)
  let result = await deps.gateway.translate({
    text: message.body, from: 'auto', to: targetLang, config,
  })
  const detectedLang = result.detectedLang
  const detectedTarget = bilingualTranslationTarget(detectedLang)
  if (detectedTarget !== targetLang) {
    targetLang = detectedTarget
    if (await deps.hasTranslation(message.id, targetLang)) return
    result = await deps.gateway.translate({
      text: message.body,
      from: detectedLang === 'und' ? 'auto' : detectedLang,
      to: targetLang,
      config,
    })
  }

  const saved = await deps.saveTranslation({
    messageId: message.id, targetLang,
    provider: result.provider, translatedText: result.text,
    revision: expectedRevision,
    detectedLang: detectedLang === 'und' ? null : detectedLang,
  })
  // 翻译期间正文已被编辑：丢掉旧结果，也不能向客户端广播。
  if (!saved) return

  await deps.publish({
    type: 'translation', messageId: message.id, platformMessageId: message.platformMessageId,
    conversationId: message.conversationId, accountId: message.accountId, platform: message.platform,
    targetLang,
    translatedText: result.text, provider: result.provider, revision: expectedRevision,
  })
}
