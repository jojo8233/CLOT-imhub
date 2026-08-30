const INITIAL_RETRY_DELAY_MS = 1_000
const MAX_RETRY_DELAY_MS = 8_000

/**
 * 外壳 bootstrap 的单定时器退避器。重复网络错误只保留一个待执行重试；
 * 登录态变化或卸载时可同步取消，避免旧用户的迟到重试重新创建连接。
 */
export class BootstrapRetryController {
  private failureCount = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  schedule(operation: () => void): void {
    if (this.timer) return
    const exponent = Math.min(this.failureCount, 3)
    const delay = Math.min(INITIAL_RETRY_DELAY_MS * (2 ** exponent), MAX_RETRY_DELAY_MS)
    this.failureCount += 1
    this.timer = setTimeout(() => {
      this.timer = null
      operation()
    }, delay)
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  reset(): void {
    this.cancel()
    this.failureCount = 0
  }
}
