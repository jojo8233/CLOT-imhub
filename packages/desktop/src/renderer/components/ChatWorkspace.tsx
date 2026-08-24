import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  clampWidths, defaultWidths, loadWidths, saveWidths, visiblePanels,
  RESIZER_WIDTH, type PanelWidths,
} from '../layout.js'
import { useStore } from '../store.js'
import { ChatPanel } from './ChatPanel.js'
import { ConversationList } from './ConversationList.js'
import { CustomerPanel } from './CustomerPanel.js'
import { Resizer } from './Resizer.js'

// 拖拽时父组件每帧都会重渲染。这三个面板的 props 在拖拽期间不变，
// memo 之后只有被拖的那一栏的容器 div 会动，消息列表不会跟着重算。
const MemoConversationList = memo(ConversationList)
const MemoChatPanel = memo(ChatPanel)
const MemoCustomerPanel = memo(CustomerPanel)

/**
 * 会话页的三栏工作区：会话列表 | 聊天区 | 客户资料，两条分隔条可拖。
 *
 * 宽度的真相有两处，要分清：
 *   - `widths` state：稳定值，用于渲染和落盘
 *   - `live` ref：拖拽过程中的即时值，直接写进 DOM
 *
 * 拖拽时**不走 setState**，而是直接改容器的 style.width。三栏里挂着几百条
 * 消息和会话行，每帧 setState 会明显掉帧。松手才提交一次 state 并存盘。
 *
 * 代价是拖拽中途若发生无关重渲染（比如 WebSocket 推来一条新消息），React 会
 * 用旧的 state 覆盖掉我们写进 DOM 的宽度，看起来就是"拖着拖着弹回去了"。
 * 所以每次渲染后都用 useLayoutEffect 把 live 值再刷一遍。
 */
export function ChatWorkspace() {
  const rowRef = useRef<HTMLDivElement>(null)
  const listBoxRef = useRef<HTMLDivElement>(null)
  const customerBoxRef = useRef<HTMLDivElement>(null)

  /** 三栏可分配的总宽（已扣掉两条分隔条）。0 表示还没量到 */
  const [avail, setAvail] = useState(0)
  const [widths, setWidths] = useState<PanelWidths | null>(null)
  const [focus, setFocus] = useState(false)
  const activeConversationId = useStore(s => s.activeConversationId)

  const live = useRef<PanelWidths>({ list: 0, customer: 0 })
  const dragStart = useRef<PanelWidths>({ list: 0, customer: 0 })
  const dragging = useRef(false)
  // avail 要在 pointermove 里读到最新值，但拖拽回调不重新绑定，所以走 ref
  const availRef = useRef(0)
  availRef.current = avail

  useEffect(() => {
    const el = rowRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      // 两条分隔条不参与分配。某一栏被折叠时会少一条，误差 5px，忽略不计
      setAvail(Math.max(0, w - RESIZER_WIDTH * 2))
    })
    ro.observe(el)
    return () => { ro.disconnect() }
  }, [])

  // 量到宽度后初始化；之后窗口每次变化都按新的可用空间重新夹一遍，
  // 这样从宽屏拖到窄屏时不会留下一个超出边界的存档值。
  useEffect(() => {
    if (avail <= 0) return
    setWidths(prev => clampWidths(prev ?? loadWidths() ?? defaultWidths(avail), avail))
  }, [avail])

  useLayoutEffect(() => {
    if (widths) live.current = widths
  }, [widths])

  const applyLive = useCallback((): void => {
    if (listBoxRef.current) listBoxRef.current.style.width = `${live.current.list}px`
    if (customerBoxRef.current) customerBoxRef.current.style.width = `${live.current.customer}px`
  }, [])

  // 拖拽中途被无关重渲染打断时，把 DOM 宽度拉回即时值
  useLayoutEffect(() => {
    if (dragging.current) applyLive()
  })

  const beginDrag = useCallback((): void => {
    dragging.current = true
    dragStart.current = { ...live.current }
  }, [])

  const endDrag = useCallback((): void => {
    dragging.current = false
    setWidths(live.current)
    saveWidths(live.current)
  }, [])

  const dragList = useCallback((dx: number): void => {
    live.current = clampWidths(
      { list: dragStart.current.list + dx, customer: dragStart.current.customer },
      availRef.current,
    )
    applyLive()
  }, [applyLive])

  // 右边这条往左拖是把客户资料变宽，所以是减 dx
  const dragCustomer = useCallback((dx: number): void => {
    live.current = clampWidths(
      { list: dragStart.current.list, customer: dragStart.current.customer - dx },
      availRef.current,
    )
    applyLive()
  }, [applyLive])

  const reset = useCallback((): void => {
    const d = defaultWidths(availRef.current)
    live.current = d
    setWidths(d)
    saveWidths(d)
  }, [])

  const toggleFocus = useCallback(() => { setFocus(f => !f) }, [])

  // 窗口太窄时按 聊天区优先 的顺序折叠辅助栏。专注模式把两栏都收掉。
  const room = visiblePanels(avail)
  const showCustomer = !focus && room.customer
  // 但"没选会话时也把列表收掉"会让人卡死：屏幕上只剩一句"从左边选一个会话"，
  // 而左边什么都没有。这种时候宁可把聊天区挤到最小宽度以下——反正它是空的。
  const showList = !focus && (room.list || activeConversationId === null)

  // 还没量到宽度前先渲染骨架：直接铺 flex 值会闪一下再跳到正确宽度
  const listW = widths?.list ?? 0
  const customerW = widths?.customer ?? 0

  return (
    <div ref={rowRef} style={{ display: 'flex', flex: 1, minWidth: 0, overflow: 'hidden' }}>
      {showList && (
        <>
          <div ref={listBoxRef} style={{ width: listW, flexShrink: 0, minWidth: 0, display: 'flex' }}>
            <MemoConversationList />
          </div>
          <Resizer
            label="调整会话列表宽度"
            onStart={beginDrag}
            onMove={dragList}
            onEnd={endDrag}
            onReset={reset}
          />
        </>
      )}

      <MemoChatPanel focus={focus} onToggleFocus={toggleFocus} />

      {showCustomer && (
        <>
          <Resizer
            label="调整客户资料宽度"
            onStart={beginDrag}
            onMove={dragCustomer}
            onEnd={endDrag}
            onReset={reset}
          />
          {/* 客户信息固定在最右侧，不随会话切换消失——位置稳定才能形成肌肉记忆 */}
          <div ref={customerBoxRef} style={{ width: customerW, flexShrink: 0, minWidth: 0, display: 'flex' }}>
            <MemoCustomerPanel />
          </div>
        </>
      )}
    </div>
  )
}
