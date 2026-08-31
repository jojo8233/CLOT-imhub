import { describe, expect, it, vi } from 'vitest'
import { NATIVE_BRIDGE_PROTOCOL_VERSION, type NativeHostCommand } from '@im-hub/shared'
import { deliverNativeHostCommand, waitForNativeGuestFocus } from './native-command-delivery.js'

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
  it('WhatsApp 写草稿前先确认原生焦点已交还 guest webContents', async () => {
    const calls: string[] = []
    const target = {
      focus: vi.fn(() => { calls.push('focus') }),
      isFocused: vi.fn(() => true),
      send: vi.fn((_channel: string, value: NativeHostCommand) => { calls.push(`send:${value.type}`) }),
    }

    await deliverNativeHostCommand(
      target,
      'command-channel',
      command('composer.set-draft'),
      true,
      async () => {
        calls.push('focus-confirmed')
        return true
      },
    )

    expect(calls).toEqual(['focus', 'focus-confirmed', 'send:composer.set-draft'])
  })

  it('只读草稿与非 WhatsApp guest 不抢宿主焦点', async () => {
    const target = { focus: vi.fn(), isFocused: vi.fn(), send: vi.fn() }

    await deliverNativeHostCommand(target, 'command-channel', command('composer.get-draft'), true)
    await deliverNativeHostCommand(target, 'command-channel', command('composer.set-draft'), false)

    expect(target.focus).not.toHaveBeenCalled()
    expect(target.isFocused).not.toHaveBeenCalled()
    expect(target.send).toHaveBeenCalledTimes(2)
  })

  it('原生焦点没有确认时不把修改命令交给 guest', async () => {
    const target = { focus: vi.fn(), isFocused: vi.fn(() => false), send: vi.fn() }

    await expect(deliverNativeHostCommand(
      target,
      'command-channel',
      command('composer.set-draft'),
      true,
      async () => false,
    )).rejects.toThrow('原生客户端输入焦点不可用')

    expect(target.send).not.toHaveBeenCalled()
  })

  it('原生焦点出现后再留一个事件周期供 guest document 更新', async () => {
    const isFocused = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
    const pause = vi.fn(async () => {})

    await expect(waitForNativeGuestFocus({ isFocused }, pause, 3)).resolves.toBe(true)
    expect(pause).toHaveBeenCalledTimes(2)
  })
})
