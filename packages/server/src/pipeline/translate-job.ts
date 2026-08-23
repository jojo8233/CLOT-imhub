import type { WsTranslationEvent } from '@im-hub/shared'
import type { EngineConfig, TranslationGateway } from '../translation/gateway.js'
import type { TranslateJobData } from './queue.js'

/** 员工侧统一看中文，所以入向消息一律译成 zh。出向消息在发送前同步翻译，不走这条队列。 */
const AGENT_LANG = 'zh'

export interface TranslateJobDeps {
  loadMessage(messageId: string): Promise<{
    id: string; body: string; direction: 'in' | 'out'; conversationId: string
  } | null>
  loadEngineConfig(conversationId: string): Promise<EngineConfig>
  /** 已有译文时跳过：MessageIngestor 对重复消息也会派发任务，靠这里挡住重复翻译 */
  hasTranslation(messageId: string, targetLang: string): Promise<boolean>
  gateway: Pick<TranslationGateway, 'translate'>
  saveTranslation(input: {
    messageId: string; targetLang: string; provider: string; translatedText: string
  }): Promise<void>
  publish(event: WsTranslationEvent): Promise<void>
}

export async function runTranslateJob(data: TranslateJobData, deps: TranslateJobDeps): Promise<void> {
  const message = await deps.loadMessage(data.messageId)
  if (!message) return
  if (message.body.trim() === '') return

  // BullMQ 的 jobId 去重只在任务还在队列里时有效；任务完成并被清理后，
  // 同一 messageId 再次入队会真的再跑一遍。这里兜住那种情况。
  if (await deps.hasTranslation(message.id, AGENT_LANG)) return

  const config = await deps.loadEngineConfig(data.conversationId)
  const result = await deps.gateway.translate({
    text: message.body, from: 'auto', to: AGENT_LANG, config,
  })

  await deps.saveTranslation({
    messageId: message.id, targetLang: AGENT_LANG,
    provider: result.provider, translatedText: result.text,
  })

  await deps.publish({
    type: 'translation', messageId: message.id, targetLang: AGENT_LANG,
    translatedText: result.text, provider: result.provider,
  })
}
