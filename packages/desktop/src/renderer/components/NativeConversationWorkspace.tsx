import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store.js'
import { theme } from '../theme.js'
import { loadWidths, MIN, RESIZER_WIDTH, saveWidths } from '../layout.js'
import { CustomerPanel } from './CustomerPanel.js'
import { NativeClient } from './NativeClient.js'
import { Resizer } from './Resizer.js'
import { TranslationDock } from './TranslationDock.js'

const DEFAULT_CUSTOMER_WIDTH = 310

/** 单一会话工作区：原生客户端与固定翻译输入坞在中间，客户档案固定在右侧。 */
export function NativeConversationWorkspace() {
  const activePlatform = useStore(s => s.activePlatform)
  const rowRef = useRef<HTMLDivElement>(null)
  const dragStartRef = useRef(DEFAULT_CUSTOMER_WIDTH)
  const customerWidthRef = useRef(loadWidths()?.customer ?? DEFAULT_CUSTOMER_WIDTH)
  const [rowWidth, setRowWidth] = useState(0)
  const [customerWidth, setCustomerWidth] = useState(customerWidthRef.current)

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

  return (
    <div ref={rowRef} style={{ flex: 1, minWidth: 0, display: 'flex', overflow: 'hidden' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <NativeClient />
        {activePlatform === 'whatsapp' || activePlatform === 'signal'
          ? (
            <div style={{
              flexShrink: 0, padding: '10px 16px', background: theme.color.surface,
              borderTop: `1px solid ${theme.color.border}`, color: theme.color.textMuted,
              fontSize: theme.font.size.sm,
            }}>
              {activePlatform === 'signal'
                ? 'Signal Desktop 首检模式：同窗口登录、切换及原生文字、图片、贴纸发送已验证；翻译与消息回传尚未开启。'
                : 'WhatsApp Web 测试模式：当前验证独立登录、多开和原生文字收发；翻译与消息回传尚未开启。'}
            </div>
          )
          : <TranslationDock />}
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
