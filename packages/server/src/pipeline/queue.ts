import { Queue } from 'bullmq'
import type Redis from 'ioredis'
import type { TranslateQueue } from '../ingest/ingestor.js'

export interface TranslateJobData {
  messageId: string
  conversationId: string
}

export const TRANSLATE_QUEUE = 'translate'

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
    // jobId 用 messageId：同一条消息重复入队不会跑两次翻译。
    // MessageIngestor 对重复消息也会派发（补偿机制），靠这里去重。
    await this.queue.add('translate', job, { jobId: job.messageId })
  }
}
