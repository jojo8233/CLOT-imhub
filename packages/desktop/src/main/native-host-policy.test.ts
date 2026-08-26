import { describe, expect, it } from 'vitest'
import { nativeClientUrlAllowed, nativePartitionAllowed } from './native-host-policy.js'

describe('native host policy', () => {
  it('只允许补丁客户端开发 origin', () => {
    expect(nativeClientUrlAllowed('http://localhost:1234/')).toBe(true)
    expect(nativeClientUrlAllowed('http://localhost:1234/chat')).toBe(true)
    expect(nativeClientUrlAllowed('http://localhost.evil.example:1234/')).toBe(false)
    expect(nativeClientUrlAllowed('https://web.telegram.org/')).toBe(false)
  })

  it('partition 必须带规范 UUID 账号 id', () => {
    expect(nativePartitionAllowed('persist:native-123e4567-e89b-42d3-a456-426614174000')).toBe(true)
    expect(nativePartitionAllowed('persist:native-account-1')).toBe(false)
    expect(nativePartitionAllowed('persist:other-123e4567-e89b-42d3-a456-426614174000')).toBe(false)
  })
})
