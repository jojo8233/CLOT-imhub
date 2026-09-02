import { useCallback, useEffect, useRef, useState } from 'react'
import { nativeOutboxBridge } from '../native-bridge.js'
import { useStore } from '../store.js'
import { theme } from '../theme.js'
import {
  loadWidths,
  MIN,
  RESIZER_WIDTH,
  saveWidths,
  showsNativeTranslationDock,
  usesCloudConversationWorkspace,
} from '../layout.js'
import { CustomerPanel } from './CustomerPanel.js'
import { NativeClient, signalOutboxStatusError } from './NativeClient.js'
import { Resizer } from './Resizer.js'
import { TranslationDock } from './TranslationDock.js'
import { ChatWorkspace } from './ChatWorkspace.js'

const DEFAULT_CUSTOMER_WIDTH = 310

/** 单一会话工作区：原生客户端与固定翻译输入坞在中间，客户档案固定在右侧。 */
export function NativeConversationWorkspace() {
  const activeAccountId = useStore(s => s.activeAccountId)
  const cloudApiActive = useStore(s => usesCloudConversationWorkspace(
    s.accounts.find(account => account.id === activeAccountId),
  ))
  if (cloudApiActive) return <ChatWorkspace />
  return <NativeClientConversationWorkspace />
}

function NativeClientConversationWorkspace() {
  const activePlatform = useStore(s => s.activePlatform)
  const activeAccountId = useStore(s => s.activeAccountId)
  const activeNative = useStore(s => activeAccountId
    ? s.nativeBridgeByAccount[activeAccountId]
    : undefined)
  const rowRef = useRef<HTMLDivElement>(null)
  const dragStartRef = useRef(DEFAULT_CUSTOMER_WIDTH)
  const customerWidthRef = useRef(loadWidths()?.customer ?? DEFAULT_CUSTOMER_WIDTH)
  const [rowWidth, setRowWidth] = useState(0)
  const [customerWidth, setCustomerWidth] = useState(customerWidthRef.current)
  const [outboxBusy, setOutboxBusy] = useState(false)
  const [outboxActionError, setOutboxActionError] = useState<string | null>(null)

  const signalOutbox = activePlatform === 'signal' ? activeNative?.outbox : undefined
  const signalOutboxNotice = signalOutbox?.deadLetterCount
    ? `消息回传有 ${signalOutbox.deadLetterCount} 条永久失败事件`
    : signalOutbox?.lastErrorCode
      ? signalOutboxStatusError(signalOutbox)
      : signalOutbox?.pendingCount
        ? `消息回传队列待处理 ${signalOutbox.pendingCount} 条`
        : null
  const signalBridgeNotice = activePlatform === 'signal'
    ? activeNative?.notice
      ?? (activeNative?.connection === 'failed' ? activeNative.error : null)
    : null

  const clampCustomerWidth = useCallback((width: number): number => {
    const max = Math.max(MIN.customer, rowWidth - MIN.chat - RESIZER_WIDTH)
    return Math.round(Math.min(Math.max(width, MIN.customer), max))
  }, [rowWidth])

  useEffect(() => {
    const row = rowRef.current
    if (!row) return
    const observer = new ResizeObserver(entries => {
      setRowWidth(entries[0]?.contentRect.width ?? 0)
    })
    observer.observe(row)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (rowWidth <= 0) return
    setCustomerWidth(current => {
      const next = clampCustomerWidth(current)
      customerWidthRef.current = next
      return next
    })
  }, [clampCustomerWidth, rowWidth])

  const showCustomer = rowWidth === 0 || rowWidth >= MIN.chat + MIN.customer + RESIZER_WIDTH

  function beginDrag(): void {
    dragStartRef.current = customerWidthRef.current
  }

  function dragCustomer(dx: number): void {
    const next = clampCustomerWidth(dragStartRef.current - dx)
    customerWidthRef.current = next
    setCustomerWidth(next)
  }

  function saveCustomerWidth(): void {
    const previous = loadWidths()
    saveWidths({ list: previous?.list ?? MIN.list, customer: customerWidthRef.current })
  }

  function resetCustomerWidth(): void {
    const next = clampCustomerWidth(DEFAULT_CUSTOMER_WIDTH)
    customerWidthRef.current = next
    setCustomerWidth(next)
    const previous = loadWidths()
    saveWidths({ list: previous?.list ?? MIN.list, customer: next })
  }

  async function retrySignalDeadLetters(): Promise<void> {
    if (!activeAccountId || outboxBusy) return
    setOutboxBusy(true)
    setOutboxActionError(null)
    try {
      await nativeOutboxBridge.retryDeadLetters(activeAccountId)
    } catch (error) {
      setOutboxActionError(error instanceof Error ? error.message : '永久失败事件重试失败')
    } finally {
      setOutboxBusy(false)
    }
  }

  async function discardSignalDeadLetters(): Promise<void> {
    if (!activeAccountId || outboxBusy) return
    const count = signalOutbox?.deadLetterCount ?? 0
    if (!window.confirm(
      `将永久清除 ${count} 条 Signal 回传失败事件。清除后无法恢复，仅在人工核对后继续。`,
    )) return
    setOutboxBusy(true)
    setOutboxActionError(null)
    try {
      await nativeOutboxBridge.discardDeadLetters(activeAccountId)
    } catch (error) {
      setOutboxActionError(error instanceof Error ? error.message : '永久失败事件清除失败')
    } finally {
      setOutboxBusy(false)
    }
  }

  return (
    <div ref={rowRef} style={{ flex: 1, minWidth: 0, display: 'flex', overflow: 'hidden' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <NativeClient />
        {showsNativeTranslationDock(activePlatform) ? <TranslationDock /> : null}
        {activePlatform === 'whatsapp' || activePlatform === 'signal'
          ? (
            <div style={{
              flexShrink: 0, padding: '10px 16px', background: theme.color.surface,
              borderTop: `1px solid ${theme.color.border}`, color: theme.color.textMuted,
              fontSize: theme.font.size.sm,
            }}>
              <div>
                {activePlatform === 'signal'
                  ? 'Signal Desktop 开发模式：入站文字、图片/贴纸元数据及编辑/删除/回应已续验；翻译可写入当前原生草稿，自动发送尚未开启，请在 Signal 输入框确认后手动发送。'
                  : 'WhatsApp Web 补丁模式：当前可见纯文字气泡会调用 im-hub 翻译网关显示中英译文；页面选择器变化时可能暂时失效。'}
              </div>
              {activePlatform === 'signal'
                && (signalBridgeNotice || signalOutboxNotice || outboxActionError) ? (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: theme.space.sm,
                  marginTop: 6, color: signalBridgeNotice
                    || signalOutbox?.deadLetterCount || signalOutbox?.lastErrorCode
                    ? theme.color.danger
                    : theme.color.textFaint,
                }}>
                  <span>{signalBridgeNotice ?? signalOutboxNotice ?? outboxActionError}</span>
                  {signalOutbox?.deadLetterCount ? (
                    <>
                      <button
                        className="ih-btn"
                        disabled={outboxBusy || activeNative?.connection !== 'ready'}
                        onClick={() => void retrySignalDeadLetters()}
                      >
                        重试
                      </button>
                      <button
                        className="ih-btn"
                        disabled={outboxBusy || activeNative?.connection !== 'ready'}
                        onClick={() => void discardSignalDeadLetters()}
                      >
                        清除记录
                      </button>
                    </>
                  ) : null}
                  {(signalBridgeNotice || signalOutboxNotice) && outboxActionError
                    ? <span>{outboxActionError}</span>
                    : null}
                </div>
              ) : null}
            </div>
          )
          : null}
      </div>

      {showCustomer && (
        <>
          <Resizer
            label="调整客户资料宽度"
            onStart={beginDrag}
            onMove={dragCustomer}
            onEnd={saveCustomerWidth}
            onReset={resetCustomerWidth}
          />
          <div style={{ width: customerWidth, flexShrink: 0, minWidth: 0, display: 'flex' }}>
            <CustomerPanel nativePending />
          </div>
        </>
      )}
    </div>
  )
}
