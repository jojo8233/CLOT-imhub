import { describe, expect, it } from 'vitest'
import {
  resolveWhatsAppSendAction,
  whatsappSendActionRemainsCurrent,
} from './whatsapp-web-send-action.js'

interface FakeNode {
  name: string
  parent: FakeNode | null
  connected: boolean
  visible: boolean
  disabled: boolean
  ariaLabel: string | null
  interactive: boolean
  matches: Set<string>
}

function node(
  name: string,
  options: Partial<Omit<FakeNode, 'name' | 'parent' | 'matches'>> & {
    parent?: FakeNode | null
    matches?: Iterable<string>
  } = {},
): FakeNode {
  return {
    name,
    parent: options.parent ?? null,
    connected: options.connected ?? true,
    visible: options.visible ?? true,
    disabled: options.disabled ?? false,
    ariaLabel: options.ariaLabel ?? null,
    interactive: options.interactive ?? false,
    matches: new Set(options.matches ?? []),
  }
}

function port() {
  return {
    query(scope: FakeNode, selector: string): readonly FakeNode[] {
      const result: FakeNode[] = []
      const visit = (current: FakeNode): void => {
        if (current.matches.has(selector)) result.push(current)
        for (const child of children.get(current) ?? []) visit(child)
      }
      visit(scope)
      return result
    },
    interactiveTarget(signal: FakeNode): FakeNode | null {
      let current: FakeNode | null = signal
      while (current) {
        if (current.interactive) return current
        current = current.parent
      }
      return null
    },
    isWithin(scope: FakeNode, target: FakeNode): boolean {
      let current: FakeNode | null = target
      while (current) {
        if (current === scope) return true
        current = current.parent
      }
      return false
    },
    isConnected: (target: FakeNode) => target.connected,
    isVisible: (target: FakeNode) => target.visible,
    isDisabled: (target: FakeNode) => target.disabled || target.matches.has('[aria-disabled="true"]'),
    ariaLabel: (target: FakeNode) => target.ariaLabel,
  }
}

const children = new Map<FakeNode, FakeNode[]>()

function attach(parent: FakeNode, child: FakeNode): FakeNode {
  child.parent = parent
  const siblings = children.get(parent) ?? []
  siblings.push(child)
  children.set(parent, siblings)
  return child
}

function compose(scope: FakeNode, target: FakeNode): void {
  attach(scope, target)
}

describe('WhatsApp Web send action resolver', () => {
  it('send icon 自身是 role button 时解析为唯一发送动作', () => {
    const scope = node('scope')
    const send = node('send', { interactive: true, matches: ['[data-icon="send"]'] })
    compose(scope, send)

    expect(resolveWhatsAppSendAction(scope, port())).toEqual({ kind: 'resolved', target: send })
  })

  it('send icon 位于 button 后代时返回其交互祖先', () => {
    const scope = node('scope')
    const button = attach(scope, node('button', { interactive: true }))
    const icon = attach(button, node('icon', { matches: ['[data-icon="send"]'] }))

    expect(resolveWhatsAppSendAction(scope, port())).toEqual({ kind: 'resolved', target: button })
    expect(icon.parent).toBe(button)
  })

  it('精确 compose send test id 可以解析', () => {
    const scope = node('scope')
    const send = node('send', { interactive: true, matches: ['[data-testid="compose-btn-send"]'] })
    compose(scope, send)

    expect(resolveWhatsAppSendAction(scope, port())).toEqual({ kind: 'resolved', target: send })
  })

  it('同一 target 被多个强信号命中时只算一个', () => {
    const scope = node('scope')
    const send = node('send', {
      interactive: true,
      matches: [
        '[data-testid="compose-btn-send"]',
        '[data-testid="send"]',
        '[data-icon="send"]',
      ],
    })
    compose(scope, send)

    expect(resolveWhatsAppSendAction(scope, port())).toEqual({ kind: 'resolved', target: send })
  })

  it('断连、隐藏、disabled、aria-disabled 和 scope 外 target 不可用', () => {
    const cases: Array<[string, FakeNode]> = [
      ['disconnected', node('disconnected', { connected: false, interactive: true })],
      ['hidden', node('hidden', { visible: false, interactive: true })],
      ['disabled', node('disabled', { disabled: true, interactive: true })],
      ['aria-disabled', node('aria-disabled', {
        interactive: true,
        matches: ['[aria-disabled="true"]'],
      })],
    ]

    for (const [label, target] of cases) {
      const scope = node(`scope-${label}`)
      target.matches.add('[data-icon="send"]')
      compose(scope, target)
      expect(resolveWhatsAppSendAction(scope, port()), label).toEqual({
        kind: 'unavailable',
        reason: 'unusable',
      })
      children.clear()
    }

    const scope = node('scope-outside')
    const outside = node('outside', { interactive: true, matches: ['[data-icon="send"]'] })
    const portWithOutsideSignal = {
      ...port(),
      query: (_scope: FakeNode, selector: string): readonly FakeNode[] =>
        selector === '[data-icon="send"]' ? [outside] : [],
    }
    expect(resolveWhatsAppSendAction(scope, portWithOutsideSignal)).toEqual({
      kind: 'unavailable',
      reason: 'missing',
    })
  })

  it('两个不同强 target 同时可用时返回 ambiguous', () => {
    const scope = node('scope')
    const first = node('first', { interactive: true, matches: ['[data-icon="send"]'] })
    const second = node('second', { interactive: true, matches: ['[data-testid="send"]'] })
    compose(scope, first)
    compose(scope, second)

    expect(resolveWhatsAppSendAction(scope, port())).toEqual({
      kind: 'unavailable',
      reason: 'ambiguous',
    })
  })

  it('强 target 存在但不可用时不降级到 aria target', () => {
    const scope = node('scope')
    const strong = node('strong', { disabled: true, interactive: true, matches: ['[data-icon="send"]'] })
    const aria = node('aria', { ariaLabel: 'send', interactive: true, matches: ['button[aria-label]'] })
    compose(scope, strong)
    compose(scope, aria)

    expect(resolveWhatsAppSendAction(scope, port())).toEqual({
      kind: 'unavailable',
      reason: 'unusable',
    })
  })

  it('aria 只精确接受 send、发送和发送消息', () => {
    const accepted = ['send', '发送', '发送消息']
    for (const ariaLabel of accepted) {
      const scope = node(`scope-${ariaLabel}`)
      const target = node(`target-${ariaLabel}`, {
        ariaLabel,
        interactive: true,
        matches: ['button[aria-label], [role="button"][aria-label]'],
      })
      compose(scope, target)
      expect(resolveWhatsAppSendAction(scope, port()), ariaLabel).toEqual({
        kind: 'resolved',
        target,
      })
      children.clear()
    }

    for (const ariaLabel of ['send message', '发送消息 now', 'send-copy']) {
      const scope = node(`scope-${ariaLabel}`)
      const target = node(`target-${ariaLabel}`, {
        ariaLabel,
        interactive: true,
        matches: ['button[aria-label], [role="button"][aria-label]'],
      })
      compose(scope, target)
      expect(resolveWhatsAppSendAction(scope, port()), ariaLabel).toEqual({
        kind: 'unavailable',
        reason: 'missing',
      })
      children.clear()
    }

    const scope = node('scope-normalized')
    const target = node('target-normalized', {
      ariaLabel: '  SeNd  ',
      interactive: true,
      matches: ['button[aria-label], [role="button"][aria-label]'],
    })
    compose(scope, target)
    expect(resolveWhatsAppSendAction(scope, port())).toEqual({ kind: 'resolved', target })
  })

  it('二次解析必须仍返回同一个 target', () => {
    const scope = node('scope')
    const send = node('send', { interactive: true, matches: ['[data-icon="send"]'] })
    compose(scope, send)
    const domPort = port()
    const first = resolveWhatsAppSendAction(scope, domPort)
    const second = resolveWhatsAppSendAction(scope, domPort)

    expect(first).toEqual({ kind: 'resolved', target: send })
    expect(second).toEqual({ kind: 'resolved', target: send })
    expect(first.kind === 'resolved' && second.kind === 'resolved'
      ? whatsappSendActionRemainsCurrent(first.target, second)
      : false).toBe(true)
  })

  it('scope 为空时返回 no-scope', () => {
    expect(resolveWhatsAppSendAction(null, port())).toEqual({
      kind: 'unavailable',
      reason: 'no-scope',
    })
  })
})
