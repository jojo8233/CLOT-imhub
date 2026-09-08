import { describe, expect, it } from 'vitest'
import { expectedHealthStatus } from './container-smoke-logic.mjs'

describe('container smoke health contract', () => {
  it('expects ready for the readiness endpoint', () => {
    expect(expectedHealthStatus('https://imhub.jojo2333.net/health/ready')).toBe('ready')
  })

  it('expects live for the liveness endpoint', () => {
    expect(expectedHealthStatus('https://imhub.jojo2333.net/health/live')).toBe('live')
  })
})
