import { createHash } from 'node:crypto'
import { Queue } from 'bullmq'
import type Redis from 'ioredis'
import type { TranslateQueue } from '../ingest/ingestor.js'

export interface TranslateJobData {
  messageId: string
  conversationId: string
  /** 编辑后的正文必须产生新 jobId，不能被已完成的初版任务挡住。 */
  revision?: string
}

export const TRANSLATE_QUEUE = 'translate'

export function translateJobId(job: TranslateJobData): string {
  // BullMQ 把冒号用作内部 key 分隔符，custom jobId 明确不能包含冒号。ISO 时间
  // 天然带冒号，因此把 revision 稳定哈希后再拼接；同版本仍得到同一个 jobId。
  const revision = createHash('sha256')
    .update(job.revision ?? 'initial')
    .digest('hex')
    .slice(0, 16)
  return `${job.messageId}-${revision}`
}

export class BullTranslateQueue implements TranslateQueue {
  private readonly queue: Queue<TranslateJobData>

  constructor(connection: Redis) {
    this.queue = new Queue<TranslateJobData>(TRANSLATE_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    })
  }

  async enqueueTranslate(job: TranslateJobData): Promise<void> {
    // 同一正文版本的重复上报不重复翻译；平台确认编辑后 revision 变化，必须重新跑。
    await this.queue.add('translate', job, { jobId: translateJobId(job) })
  }
}
