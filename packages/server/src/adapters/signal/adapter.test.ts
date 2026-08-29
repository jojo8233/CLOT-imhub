import { describe, expect, it } from 'vitest'
import { signalAuthFailureReason } from './adapter.js'

describe('signalAuthFailureReason', () => {
  it('把缺少可执行文件转换成可操作且不含原始路径的提示', () => {
    const error = Object.assign(new Error('spawn /secret/path/signal-cli ENOENT'), { code: 'ENOENT' })
    const reason = signalAuthFailureReason(error)

    expect(reason).toContain('SIGNAL_CLI_BINARY')
    expect(reason).not.toContain('/secret/path')
  })

  it('把过期关联转换成重新扫码提示', () => {
    expect(signalAuthFailureReason(new Error('Link request timed out, please try again.')))
      .toBe('Signal 二维码已过期，请重新关联后再扫码')
  })

  it('未知错误不回显上游可能携带的敏感内容', () => {
    const reason = signalAuthFailureReason(new Error('failed for sgnl://linkdevice?token=secret'))

    expect(reason).toBe('Signal 关联失败；请检查本机 signal-cli 与 Java 版本后重试')
    expect(reason).not.toContain('secret')
  })
})
