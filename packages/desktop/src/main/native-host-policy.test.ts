import { describe, expect, it } from 'vitest'
import {
  nativeAccountIdFromPartition,
  nativeClientBridgeAllowed,
  nativeClientComposerFocusRequired,
  nativeClientPermissionAllowed,
  nativeClientUrlAllowed,
  nativePartitionAllowed,
} from './native-host-policy.js'

describe('native host policy', () => {
  it('只允许补丁客户端与官方 WhatsApp Web origin', () => {
    expect(nativeClientUrlAllowed('http://localhost:1234/')).toBe(true)
    expect(nativeClientUrlAllowed('http://localhost:1234/chat')).toBe(true)
    expect(nativeClientUrlAllowed('https://web.whatsapp.com/')).toBe(true)
    expect(nativeClientUrlAllowed('https://web.whatsapp.com/inbox')).toBe(true)
    expect(nativeClientUrlAllowed('http://localhost.evil.example:1234/')).toBe(false)
    expect(nativeClientUrlAllowed('https://web.whatsapp.com.evil.example/')).toBe(false)
    expect(nativeClientUrlAllowed('https://web.telegram.org/')).toBe(false)
  })

  it('只给明确登记的 Telegram 与 WhatsApp 补丁客户端注入 bridge', () => {
    expect(nativeClientBridgeAllowed('http://localhost:1234/')).toBe(true)
    expect(nativeClientBridgeAllowed('https://web.whatsapp.com/')).toBe(true)
    expect(nativeClientBridgeAllowed('https://example.com/')).toBe(false)
  })

  it('只有 WhatsApp composer 命令需要主进程交还 guest 原生焦点', () => {
    expect(nativeClientComposerFocusRequired('https://web.whatsapp.com/')).toBe(true)
    expect(nativeClientComposerFocusRequired('https://web.whatsapp.com/inbox')).toBe(true)
    expect(nativeClientComposerFocusRequired('http://localhost:1234/')).toBe(false)
    expect(nativeClientComposerFocusRequired('https://web.whatsapp.com.evil.example/')).toBe(false)
  })

  it('只允许 WhatsApp 主框架持久化存储，其余 guest 权限继续拒绝', () => {
    expect(nativeClientPermissionAllowed(
      'https://web.whatsapp.com/',
      'persistent-storage',
      true,
    )).toBe(true)
    expect(nativeClientPermissionAllowed(
      'https://web.whatsapp.com/chat',
      'persistent-storage',
      false,
    )).toBe(false)
    expect(nativeClientPermissionAllowed(
      'https://web.whatsapp.com/',
      'storage-access',
      true,
    )).toBe(false)
    expect(nativeClientPermissionAllowed(
      'https://web.whatsapp.com/',
      'media',
      true,
    )).toBe(false)
    expect(nativeClientPermissionAllowed(
      'https://web.whatsapp.com.evil.example/',
      'persistent-storage',
      true,
    )).toBe(false)
    expect(nativeClientPermissionAllowed(
      'not a url',
      'persistent-storage',
      true,
    )).toBe(false)
  })

  it('partition 必须带规范 UUID 账号 id', () => {
    expect(nativePartitionAllowed('persist:native-123e4567-e89b-42d3-a456-426614174000')).toBe(true)
    expect(nativePartitionAllowed('persist:native-account-1')).toBe(false)
    expect(nativePartitionAllowed('persist:other-123e4567-e89b-42d3-a456-426614174000')).toBe(false)
    expect(nativeAccountIdFromPartition('persist:native-123E4567-E89B-42D3-A456-426614174000'))
      .toBe('123e4567-e89b-42d3-a456-426614174000')
    expect(nativeAccountIdFromPartition('persist:native-account-1')).toBeNull()
  })
})
