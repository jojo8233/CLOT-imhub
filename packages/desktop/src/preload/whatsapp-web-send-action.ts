export interface WhatsAppSendActionDomPort<Node extends object> {
  query(scope: Node, selector: string): readonly Node[]
  interactiveTarget(signal: Node): Node | null
  isWithin(scope: Node, target: Node): boolean
  isConnected(target: Node): boolean
  isVisible(target: Node): boolean
  isDisabled(target: Node): boolean
  ariaLabel(target: Node): string | null
}

export type WhatsAppSendActionUnavailableReason =
  | 'no-scope'
  | 'missing'
  | 'unusable'
  | 'ambiguous'

export type WhatsAppSendActionResolution<Node extends object> =
  | { kind: 'resolved'; target: Node }
  | { kind: 'unavailable'; reason: WhatsAppSendActionUnavailableReason }

const STRONG_SEND_SIGNAL_SELECTORS = [
  '[data-testid="compose-btn-send"]',
  '[data-testid="send"]',
  '[data-icon="send"]',
] as const

const ARIA_SEND_SIGNAL_SELECTOR = 'button[aria-label], [role="button"][aria-label]'
const SEND_ARIA_LABELS = new Set(['send', '发送', '发送消息'])

export function resolveWhatsAppSendAction<Node extends object>(
  scope: Node | null,
  port: WhatsAppSendActionDomPort<Node>,
): WhatsAppSendActionResolution<Node> {
  if (!scope) return { kind: 'unavailable', reason: 'no-scope' }

  const strongTargets = targetsForSignals(
    scope,
    STRONG_SEND_SIGNAL_SELECTORS.flatMap(selector => port.query(scope, selector)),
    port,
  )
  if (strongTargets.length > 0) return resolveLevel(strongTargets, port)

  const ariaTargets = targetsForSignals(
    scope,
    port.query(scope, ARIA_SEND_SIGNAL_SELECTOR),
    port,
  ).filter(target => SEND_ARIA_LABELS.has(
    (port.ariaLabel(target) ?? '').trim().toLocaleLowerCase(),
  ))
  if (ariaTargets.length === 0) return { kind: 'unavailable', reason: 'missing' }
  return resolveLevel(ariaTargets, port)
}

export function whatsappSendActionRemainsCurrent<Node extends object>(
  target: Node,
  resolution: WhatsAppSendActionResolution<Node>,
): boolean {
  return resolution.kind === 'resolved' && resolution.target === target
}

function targetsForSignals<Node extends object>(
  scope: Node,
  signals: readonly Node[],
  port: WhatsAppSendActionDomPort<Node>,
): Node[] {
  const targets = new Set<Node>()
  for (const signal of signals) {
    const target = port.interactiveTarget(signal)
    if (target && port.isWithin(scope, target)) targets.add(target)
  }
  return [...targets]
}

function resolveLevel<Node extends object>(
  targets: readonly Node[],
  port: WhatsAppSendActionDomPort<Node>,
): WhatsAppSendActionResolution<Node> {
  const usableTargets = targets.filter(target =>
    port.isConnected(target) && port.isVisible(target) && !port.isDisabled(target),
  )
  if (usableTargets.length === 0) return { kind: 'unavailable', reason: 'unusable' }
  if (usableTargets.length === 1) return { kind: 'resolved', target: usableTargets[0] }
  return { kind: 'unavailable', reason: 'ambiguous' }
}
