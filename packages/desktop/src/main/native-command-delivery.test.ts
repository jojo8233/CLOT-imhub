import { describe, expect, it, vi } from 'vitest'
import { NATIVE_BRIDGE_PROTOCOL_VERSION, type NativeHostCommand } from '@im-hub/shared'
import { deliverNativeHostCommand } from './native-command-delivery.js'

function command(type: 'composer.set-draft' | 'composer.get-draft'): NativeHostCommand {
  return {
    protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
    type,
    requestId: 'request-1',
    contextRevision: 1,
    platformConversationId: 'wa:chat-1',
    ...(type === 'composer.set-draft' ? { text: 'translated text' } : {}),
  } as NativeHostCommand
}

describe('native command delivery', () => {
  it('WhatsApp 写草稿前先把原生焦点交还 guest webContents', () => {
    const calls: string[] = []
    const target = {
      focus: vi.fn(() => { calls.push('focus') }),
      send: vi.fn((_channel: string, value: NativeHostCommand) => { calls.push(`send:${value.type}`) }),
    }

    deliverNativeHostCommand(target, 'command-channel', command('composer.set-draft'), true)

    expect(calls).toEqual(['focus', 'send:composer.set-draft'])
  })

  it('只读草稿与非 WhatsApp guest 不抢宿主焦点', () => {
    const target = { focus: vi.fn(), send: vi.fn() }

    deliverNativeHostCommand(target, 'command-channel', command('composer.get-draft'), true)
    deliverNativeHostCommand(target, 'command-channel', command('composer.set-draft'), false)

    expect(target.focus).not.toHaveBeenCalled()
    expect(target.send).toHaveBeenCalledTimes(2)
  })
})
