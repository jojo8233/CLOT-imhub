import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../../config.js'
import type { TranslationGateway } from '../../translation/gateway.js'

/**
 * 给打过补丁的原生客户端用的批量翻译接口。
 *
 * 与 /api/messages/translate-preview 的区别：那个接口绑在我们自己的会话模型上
 * （要传 conversationId、要解析会话锁定语言）。而 telegram-tt 这类客户端有它
 * 自己的会话概念，我们不掌握它的 id，只需要「这几段文字翻成这个语言」。
 *
 * 上限刻意压得比较紧：客户端那边是按 20 条一批发的，50 足够，
 * 更大的批次只会让单次请求变慢、失败时丢的更多。
 */
const batchBody = z.object({
  texts: z.array(z.string().max(4000, '单条文本过长')).min(1).max(50),
  targetLang: z.string().min(2).max(12),
  /** 不传就让引擎自己识别。已知源语言时传进来能省一次检测、也更准 */
  sourceLang: z.string().min(2).max(12).optional(),
})

const detectBody = z.object({
  text: z.string().trim().min(1).max(4000),
})

export interface TranslateRouteDeps {
  gateway: TranslationGateway
}

export async function translateRoutes(app: FastifyInstance, deps: TranslateRouteDeps): Promise<void> {
  app.post('/api/translate/batch', async (req, reply) => {
    const parsed = batchBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数不合法' })
    }
    const { texts, targetLang, sourceLang } = parsed.data

    // 逐条并发，而不是拼成一大段发出去再切开：拼接方案在任何一条包含换行或
    // 分隔符时都会错位，而错位的译文会安静地配到错误的消息上——比整批失败糟得多。
    // 缓存命中的那些根本不会出网，所以并发数不是问题。
    const results = await Promise.all(texts.map(async (text) => {
      if (text.trim() === '') {
        return { translated: '', detectedLang: 'und', provider: 'none', failed: false }
      }
      try {
        const r = await deps.gateway.translate({
          text,
          from: sourceLang ?? 'auto',
          to: targetLang,
          config: { global: config.DEFAULT_TRANSLATION_PROVIDER },
        })
        return { translated: r.text, detectedLang: r.detectedLang, provider: r.provider, failed: false }
      } catch (err) {
        // 单条失败不拖垮整批：客户端一次要 20 条，一条挂掉就让 20 条全没有
        // 是很差的体验。失败的那条标出来，客户端可以显示原文并稍后重试。
        console.error('[translate-batch] 单条翻译失败:', err instanceof Error ? err.message : err)
        return { translated: '', detectedLang: 'und', provider: 'none', failed: true }
      }
    }))

    // 顺序与入参严格一一对应，客户端靠下标配回自己的消息 id
    return { results }
  })

  /**
   * 识别一段文字是什么语言。
   *
   * 发送前校对要知道「该翻成什么语言」，依据是客户最近一条消息用的语言。
   * 借翻译引擎顺带做检测——DeepL 每次翻译都会返回 detectedLang，所以这里
   * 翻成英文只是为了拿那个附带结果，译文本身丢掉。
   *
   * 命中缓存时不产生任何外部调用，所以同一个会话反复问也不费额度。
   */
  app.post('/api/translate/detect', async (req, reply) => {
    const parsed = detectBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: '参数不合法' })

    try {
      const r = await deps.gateway.translate({
        text: parsed.data.text,
        from: 'auto',
        to: 'en',
        config: { global: config.DEFAULT_TRANSLATION_PROVIDER },
      })
      return { detectedLang: r.detectedLang }
    } catch (err) {
      console.error('[translate-detect] 识别失败:', err instanceof Error ? err.message : err)
      // 识别不出来不是错误，是"不知道"。调用方据此退回默认目标语言
      return { detectedLang: null }
    }
  })
}
