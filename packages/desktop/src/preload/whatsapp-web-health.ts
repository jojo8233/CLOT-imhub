export class WhatsAppDomFailureGate {
  private failureStartedAt: number | null = null
  private failureReason: string | null = null
  private reported = false

  constructor(private readonly thresholdMs: number) {}

  observeFailure(reason: string, now: number): boolean {
    if (this.failureReason !== reason
      || this.failureStartedAt === null
      || now < this.failureStartedAt) {
      this.failureReason = reason
      this.failureStartedAt = now
      this.reported = false
      return false
    }
    if (this.reported || now - this.failureStartedAt < this.thresholdMs) return false
    this.reported = true
    return true
  }

  /** true 表示此前已向 host 报错，恢复时需要发 bridge.ready 清除 UI 错误。 */
  observeHealthy(): boolean {
    const shouldReportRecovery = this.reported
    this.failureStartedAt = null
    this.failureReason = null
    this.reported = false
    return shouldReportRecovery
  }
}
