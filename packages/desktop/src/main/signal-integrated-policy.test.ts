import { describe, expect, it } from 'vitest'

import {
  signalIntegratedAccountIdAllowed,
  signalIntegratedBounds,
  signalIntegratedServerOrigins,
} from './signal-integrated-policy.js'

describe('Signal 同窗口视图策略', () => {
  it('只接受 UUID 账号 id', () => {
    expect(signalIntegratedAccountIdAllowed('123e4567-e89b-42d3-a456-426614174000')).toBe(true)
    expect(signalIntegratedAccountIdAllowed('../profile')).toBe(false)
    expect(signalIntegratedAccountIdAllowed('signal-1')).toBe(false)
  })

  it('按宿主内容区裁剪 renderer 矩形', () => {
    expect(signalIntegratedBounds(
      { x: 220.4, y: 126.6, width: 900.2, height: 640.1 },
      1400,
      900,
    )).toEqual({ x: 220, y: 127, width: 901, height: 640 })
    expect(signalIntegratedBounds(
      { x: -20, y: 100, width: 100, height: 200 },
      1400,
      900,
    )).toEqual({ x: 0, y: 100, width: 80, height: 200 })
  })

  it('拒绝空区域和非有限数值', () => {
    expect(signalIntegratedBounds(
      { x: 10, y: 10, width: 0, height: 20 },
      1400,
      900,
    )).toBeNull()
    expect(signalIntegratedBounds(
      { x: Number.NaN, y: 10, width: 20, height: 20 },
      1400,
      900,
    )).toBeNull()
  })

  it('把配置的 HTTP API 精确转换为 CSP WebSocket 来源', () => {
    expect(signalIntegratedServerOrigins('http://127.0.0.1:4000')).toEqual({
      httpOrigin: 'http://127.0.0.1:4000',
      wsOrigin: 'ws://127.0.0.1:4000',
    })
    expect(signalIntegratedServerOrigins('https://imhub.example.test')).toEqual({
      httpOrigin: 'https://imhub.example.test',
      wsOrigin: 'wss://imhub.example.test',
    })
    expect(signalIntegratedServerOrigins('file:///tmp/server')).toBeNull()
    expect(signalIntegratedServerOrigins('http://user:secret@localhost:4000')).toBeNull()
  })
})
