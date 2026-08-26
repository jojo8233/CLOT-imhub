import type { WsTranslationEvent } from '@im-hub/shared'
import type { EngineConfig, TranslationGateway } from '../translation/gateway.js'
import type { TranslateJobData } from './queue.js'

/** 员工侧统一看中文，所以入向消息一律译成 zh。出向消息在发送前同步翻译，不走这条队列。 */
const AGENT_LANG = 'zh'

export interface TranslateJobDeps {
  loadMessage(messageId: string): Promise<{
    id: string; body: string; direction: 'in' | 'out'; conversationId: string; revision: string
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
  // 新 ingestor 不再为出向消息入队，但部署时 Redis 里可能还有旧任务，
  // 也可能存在其他生产者。worker 自身仍要守住“只翻译入向”边界。
  if (message.direction !== 'in') return
  if (message.body.trim() === '') return
  const expectedRevision = data.revision ?? message.revision
  // 旧版本任务可能还在队列中。翻译前先挡一次，写入时还会在行锁下再校验一次。
  if (message.revision !== expectedRevision) return

  // BullMQ 的 jobId 去重只在任务还在队列里时有效；任务完成并被清理后，
  // 同一 messageId 再次入队会真的再跑一遍。这里兜住那种情况。
  if (await deps.hasTranslation(message.id, AGENT_LANG)) return

  const config = await deps.loadEngineConfig(data.conversationId)
  const result = await deps.gateway.translate({
    text: message.body, from: 'auto', to: AGENT_LANG, config,
  })

  const saved = await deps.saveTranslation({
    messageId: message.id, targetLang: AGENT_LANG,
    provider: result.provider, translatedText: result.text,
    revision: expectedRevision,
    detectedLang: result.detectedLang === 'und' ? null : result.detectedLang,
  })
  // 翻译期间正文已被编辑：丢掉旧结果，也不能向客户端广播。
  if (!saved) return

  await deps.publish({
    type: 'translation', messageId: message.id, conversationId: message.conversationId,
    targetLang: AGENT_LANG,
    translatedText: result.text, provider: result.provider, revision: expectedRevision,
  })
}
