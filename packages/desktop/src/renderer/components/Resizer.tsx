import { useRef, useState } from 'react'
import { RESIZER_WIDTH } from '../layout.js'
import { theme } from '../theme.js'

/**
 * 竖向拖拽分隔条。
 *
 * 用 Pointer Events + setPointerCapture：捕获之后所有事件都发到这个元素上，
 * 不需要往 window 上挂监听。好处是拖到窗口外面、鼠标松在别处，或者组件在
 * 拖拽中途被卸载，监听都会跟着元素一起走，不会漏。
 *
 * 视觉上它替代了原来两栏之间那条 1px 边框——所以相邻面板的 border 要去掉，
 * 否则会出现两条线。
 */
interface Props {
  /** 按下时调用，父组件在这里记下起始宽度 */
  onStart(): void
  /** 拖动中调用，dx 是相对按下点的位移（向右为正） */
  onMove(dx: number): void
  /** 松手或取消时调用，父组件在这里落盘 */
  onEnd(): void
  /** 双击恢复默认布局 */
  onReset(): void
  label: string
}

export function Resizer({ onStart, onMove, onEnd, onReset, label }: Props) {
  const [state, setState] = useState<'idle' | 'hover' | 'active'>('idle')
  // 回调放 ref 里，pointerdown 时闭包捕获的永远是最新的一份，
  // 不用把它们塞进依赖数组重新绑监听
  const cb = useRef({ onStart, onMove, onEnd })
  cb.current = { onStart, onMove, onEnd }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    // 只响应主键；右键和中键按下不该开始拖拽
    if (e.button !== 0) return
    // 阻止默认行为，否则拖过输入框和可选中文字时会选中一片
    e.preventDefault()

    const el = e.currentTarget
    const startX = e.clientX
    // 捕获失败不该让拖拽整个用不了：监听是挂在元素上的，没有捕获时只是
    // 拖出元素范围会断，功能仍在。真实指针上不会走到 catch。
    try { el.setPointerCapture(e.pointerId) } catch { /* 忽略 */ }
    setState('active')
    cb.current.onStart()

    // 拖拽期间整页光标锁成 col-resize，不然划过别的元素光标会来回变
    const prevCursor = document.body.style.cursor
    const prevSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const move = (ev: PointerEvent): void => { cb.current.onMove(ev.clientX - startX) }
    const finish = (ev: PointerEvent): void => {
      try { el.releasePointerCapture(ev.pointerId) } catch { /* 忽略 */ }
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', finish)
      el.removeEventListener('pointercancel', finish)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevSelect
      setState('idle')
      cb.current.onEnd()
    }

    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', finish)
    el.addEventListener('pointercancel', finish)
  }

  // 线本身始终是 1px，只换颜色——分隔条变粗会让整页布局在悬停时抖一下
  const lineColor = state === 'active'
    ? theme.color.textFaint
    : state === 'hover'
      ? theme.color.borderStrong
      : theme.color.border

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={`${label}（双击恢复默认宽度）`}
      onPointerDown={handlePointerDown}
      onDoubleClick={onReset}
      onPointerEnter={() => setState(s => s === 'active' ? s : 'hover')}
      onPointerLeave={() => setState(s => s === 'active' ? s : 'idle')}
      style={{
        width: RESIZER_WIDTH, flexShrink: 0, cursor: 'col-resize',
        display: 'flex', justifyContent: 'center', touchAction: 'none',
      }}
    >
      <div style={{ width: 1, height: '100%', background: lineColor, transition: 'background .12s ease' }} />
    </div>
  )
}
