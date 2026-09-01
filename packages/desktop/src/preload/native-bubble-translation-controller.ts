import type { NativeTranslationTextResult } from './native-translation-coordinator.js'

const DEFAULT_BATCH_SIZE = 20
const DEFAULT_DEBOUNCE_MS = 500
const DEFAULT_MAX_CONCURRENCY = 3

export interface NativeBubbleTranslationObservation<TKey> {
  key: TKey
  text: string
  revision: string | number
}

export interface NativeBubbleTranslationPort<TKey> {
  translate(texts: readonly string[]): Promise<NativeTranslationTextResult[]>
  isCurrent(item: NativeBubbleTranslationObservation<TKey>): boolean
  onPending(item: NativeBubbleTranslationObservation<TKey>): void
  onSuccess(item: NativeBubbleTranslationObservation<TKey>, translated: string): void
  onFailure(item: NativeBubbleTranslationObservation<TKey>): void
  onStale(item: NativeBubbleTranslationObservation<TKey>): void
}

export interface NativeBubbleTranslationStats {
  queued: number
  active: number
}

export interface NativeBubbleTranslationControllerOptions {
  batchSize?: number
  debounceMs?: number
  maxConcurrency?: number
}

interface Entry<TKey> {
  item: NativeBubbleTranslationObservation<TKey>
  token: number
  epoch: number
  state: 'queued' | 'active'
}

export class NativeBubbleTranslationController<TKey> {
  private readonly batchSize: number
  private readonly debounceMs: number
  private readonly maxConcurrency: number
  private readonly byKey = new Map<TKey, Entry<TKey>>()
  private readonly queue: Entry<TKey>[] = []
  private readonly ready: Entry<TKey>[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private token = 0
  private epoch = 0
  private active = 0

  constructor(
    private readonly port: NativeBubbleTranslationPort<TKey>,
    options: NativeBubbleTranslationControllerOptions = {},
  ) {
    this.batchSize = this.positiveSafeInteger(options.batchSize, DEFAULT_BATCH_SIZE, 'batchSize')
    this.debounceMs = this.positiveSafeInteger(options.debounceMs, DEFAULT_DEBOUNCE_MS, 'debounceMs')
    this.maxConcurrency = this.positiveSafeInteger(
      options.maxConcurrency,
      DEFAULT_MAX_CONCURRENCY,
      'maxConcurrency',
    )
  }

  observe(item: NativeBubbleTranslationObservation<TKey>): boolean {
    if (!item.text.trim()) return false

    const current = this.byKey.get(item.key)
    if (
      current
      && current.item.text === item.text
      && current.item.revision === item.revision
    ) return false

    const entry: Entry<TKey> = {
      item,
      token: ++this.token,
      epoch: this.epoch,
      state: 'queued',
    }
    this.byKey.set(item.key, entry)
    this.queue.push(entry)
    this.port.onPending(item)
    this.scheduleDrain()
    return true
  }

  retry(item: NativeBubbleTranslationObservation<TKey>): boolean {
    return this.observe(item)
  }

  reset(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.queue.length = 0
    this.ready.length = 0
    this.byKey.clear()
    this.epoch += 1
  }

  stats(): NativeBubbleTranslationStats {
    let queued = 0
    for (const entry of this.byKey.values()) {
      if (entry.state === 'queued') queued += 1
    }
    return { queued, active: this.active }
  }

  private positiveSafeInteger(value: number | undefined, fallback: number, name: string): number {
    const resolved = value ?? fallback
    if (!Number.isSafeInteger(resolved) || resolved <= 0) {
      throw new Error(`${name} must be a positive safe integer`)
    }
    return resolved
  }

  private scheduleDrain(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      for (const entry of this.queue.splice(0)) {
        if (
          entry.epoch === this.epoch
          && entry.state === 'queued'
          && this.byKey.get(entry.item.key) === entry
        ) this.ready.push(entry)
      }
      this.drain()
    }, this.debounceMs)
  }

  private drain(): void {
    while (this.active < this.maxConcurrency) {
      const batch = this.takeCurrentBatch()
      if (batch.length === 0) return
      this.active += 1
      for (const entry of batch) entry.state = 'active'
      void this.translateBatch(batch).finally(() => {
        this.active -= 1
        this.drain()
      })
    }
  }

  private takeCurrentBatch(): Entry<TKey>[] {
    const batch: Entry<TKey>[] = []
    while (this.ready.length > 0 && batch.length < this.batchSize) {
      const entry = this.ready.shift()
      if (!entry) break
      if (
        entry.epoch !== this.epoch
        || entry.state !== 'queued'
        || this.byKey.get(entry.item.key) !== entry
      ) continue
      batch.push(entry)
    }
    return batch
  }

  private async translateBatch(batch: Entry<TKey>[]): Promise<void> {
    let results: NativeTranslationTextResult[]
    try {
      results = await this.port.translate(batch.map(entry => entry.item.text))
    } catch {
      results = batch.map(() => ({ status: 'failed' }))
    }

    for (const [index, entry] of batch.entries()) {
      if (entry.epoch !== this.epoch || this.byKey.get(entry.item.key) !== entry) continue
      if (!this.port.isCurrent(entry.item)) {
        this.byKey.delete(entry.item.key)
        this.port.onStale(entry.item)
        continue
      }

      this.byKey.delete(entry.item.key)
      const result = results[index]
      if (result?.status === 'translated') this.port.onSuccess(entry.item, result.translated)
      else this.port.onFailure(entry.item)
    }
  }
}
