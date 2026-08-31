import { describe, expect, it } from 'vitest'
import { WhatsAppDomFailureGate } from './whatsapp-web-health.js'

describe('WhatsApp DOM failure gate', () => {
  it('MutationObserver 高频扫描不能把持续时间门槛压缩成瞬时误报', () => {
    const gate = new WhatsAppDomFailureGate(6_000)
    for (let index = 0; index < 200; index += 1) {
      expect(gate.observeFailure('selector', 1_000 + index * 20)).toBe(false)
    }
    expect(gate.observeFailure('selector', 6_999)).toBe(false)
    expect(gate.observeFailure('selector', 7_000)).toBe(true)
    expect(gate.observeFailure('selector', 20_000)).toBe(false)
  })

  it('失败原因变化后重新计时，避免把不同加载阶段拼成一次错误', () => {
    const gate = new WhatsAppDomFailureGate(6_000)
    expect(gate.observeFailure('identity', 1_000)).toBe(false)
    expect(gate.observeFailure('identity', 6_999)).toBe(false)
    expect(gate.observeFailure('proxyReady', 7_000)).toBe(false)
    expect(gate.observeFailure('proxyReady', 12_999)).toBe(false)
    expect(gate.observeFailure('proxyReady', 13_000)).toBe(true)
  })

  it('只有已经报告过的持续故障在恢复时要求清除 UI 错误', () => {
    const gate = new WhatsAppDomFailureGate(6_000)
    expect(gate.observeFailure('selector', 1_000)).toBe(false)
    expect(gate.observeHealthy()).toBe(false)
    expect(gate.observeFailure('selector', 2_000)).toBe(false)
    expect(gate.observeFailure('selector', 8_000)).toBe(true)
    expect(gate.observeHealthy()).toBe(true)
    expect(gate.observeHealthy()).toBe(false)
  })
})
