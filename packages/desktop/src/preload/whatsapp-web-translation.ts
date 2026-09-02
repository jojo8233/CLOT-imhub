import {
  NativeBubbleTranslationController,
  type NativeBubbleTranslationControllerOptions,
  type NativeBubbleTranslationStats,
} from './native-bubble-translation-controller.js'
import type { NativeTranslationTextResult } from './native-translation-coordinator.js'

export interface WhatsAppTranslationDomPort<Row extends object, Marker> {
  text(row: Row): string | null
  isConnected(row: Row): boolean
  marker(row: Row, create: boolean): Marker | null
  setText(marker: Marker, text: string): void
  setError(marker: Marker, failed: boolean): void
  setRetryHandler(marker: Marker, handler: (() => void) | null): void
  removeMarker(marker: Marker): void
  removeAllMarkers(): void
  scheduleScan(): void
}

export interface WhatsAppTranslationCoordinatorPort {
  translateMany(texts: readonly string[]): Promise<NativeTranslationTextResult[]>
  clear(): void
}

export class WhatsAppWebTranslationAdapter<Row extends object, Marker> {
  private translatedRows = new WeakMap<Row, string>()
  private generation = 0
  private readonly controller: NativeBubbleTranslationController<Row>

  constructor(
    private readonly dom: WhatsAppTranslationDomPort<Row, Marker>,
    private readonly coordinator: WhatsAppTranslationCoordinatorPort,
    controllerOptions: NativeBubbleTranslationControllerOptions = {},
  ) {
    this.controller = new NativeBubbleTranslationController<Row>({
      translate: texts => this.coordinator.translateMany(texts),
      isCurrent: item => (
        item.revision === this.generation
        && this.dom.isConnected(item.key)
        && this.dom.text(item.key) === item.text
      ),
      onPending: item => {
        const marker = this.dom.marker(item.key, true)
        if (!marker) return
        this.dom.setText(marker, '翻译中…')
        this.dom.setError(marker, false)
        this.dom.setRetryHandler(marker, null)
      },
      onSuccess: (item, translated) => {
        const marker = this.dom.marker(item.key, true)
        if (!marker) return
        this.dom.setText(marker, translated)
        this.dom.setError(marker, false)
        this.dom.setRetryHandler(marker, null)
        this.translatedRows.set(item.key, item.text)
      },
      onFailure: item => {
        const marker = this.dom.marker(item.key, true)
        if (!marker) return
        this.dom.setText(marker, '翻译暂不可用 · 点击重试')
        this.dom.setError(marker, true)
        this.translatedRows.set(item.key, item.text)
        this.dom.setRetryHandler(marker, () => this.retry(item.key))
      },
      onStale: () => this.dom.scheduleScan(),
    }, controllerOptions)
  }

  observe(row: Row, text: string): boolean {
    const marker = this.dom.marker(row, false)
    if (marker && this.translatedRows.get(row) === text) return false
    this.translatedRows.delete(row)
    return this.controller.observe({ key: row, text, revision: this.generation })
  }

  retry(row: Row): boolean {
    this.translatedRows.delete(row)
    const marker = this.dom.marker(row, false)
    if (marker) this.dom.removeMarker(marker)
    const text = this.dom.text(row)
    if (text !== null) return this.observe(row, text)
    this.dom.scheduleScan()
    return false
  }

  reset(): void {
    this.generation += 1
    this.controller.reset()
    this.coordinator.clear()
    this.dom.removeAllMarkers()
    this.translatedRows = new WeakMap<Row, string>()
  }

  stats(): NativeBubbleTranslationStats {
    return this.controller.stats()
  }
}
