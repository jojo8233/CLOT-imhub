/**
 * 会话页三栏的宽度计算与持久化。
 *
 * 只放纯函数和读写存储，不碰 React——宽度夹取的规则很容易在拖拽的边界情况上
 * 出错（拖到底、窗口忽然变窄、存档来自一块更宽的屏幕），单独拎出来才好推理。
 *
 * 核心规则只有一条：**聊天区优先**。空间不够时先压客户资料，再压会话列表，
 * 最后才轮到聊天区。宽度都以像素存，不存百分比——换一块屏幕时，"上次那个
 * 会话列表多宽"比"占多少比例"更接近用户真正想要的。
 */

/** 各栏最小宽度。低于这个值列表会挤成没法用的窄条 */
export const MIN = { list: 220, chat: 480, customer: 240 } as const

/** 聊天正文列的最大宽度。再宽一行字就长到看着费劲了，多出来的空间留白 */
export const CHAT_MAX_WIDTH = 720

/** 分隔条宽度。要够手指头点得到，又不能粗到看起来像一栏 */
export const RESIZER_WIDTH = 5

/**
 * 默认占比。功能中心是固定宽度不参与分配，所以这里是"除功能中心之外"的比例：
 * 整页 20 : 45 : 20 归一化到剩余空间就是 0.235 / 0.53 / 0.235。
 */
const DEFAULT_RATIO = { list: 0.235, customer: 0.235 } as const

const STORAGE_KEY = 'im-hub.layout.v1'

/** 功能中心的两档宽度。它不参与拖拽分配，但窄屏时会被强制收成图标栏 */
export const FUNCTION_CENTER = { open: 250, collapsed: 62 } as const

/** 三个平台的补丁客户端都通过同一固定翻译坞驱动各自原生输入框。 */
export function showsNativeTranslationDock(_platform: string): boolean {
  return true
}

export function usesCloudConversationWorkspace(account: {
  platform: string
  connection_mode: string
} | undefined): boolean {
  return account?.platform === 'whatsapp' && account.connection_mode === 'cloud_api'
}

/**
 * 窗口窄到放不下"展开的功能中心 + 会话列表 + 聊天区"时，先把功能中心收成
 * 图标栏。它是这一排里最不常用又最占地方的一栏，比收掉会话列表划算得多。
 *
 * 判断依据是整排的宽度而不是三栏可用宽度——后者会随功能中心收起而变大，
 * 用它判断会来回横跳。
 */
export function functionCenterCompact(rowWidth: number): boolean {
  return rowWidth < FUNCTION_CENTER.open + MIN.list + MIN.chat + RESIZER_WIDTH * 2
}

export interface PanelWidths {
  list: number
  customer: number
}

/**
 * 把一组宽度夹进可用空间。
 *
 * @param avail 会话列表 + 聊天区 + 客户资料三者可分配的总宽（已扣掉分隔条）
 */
export function clampWidths(w: PanelWidths, avail: number): PanelWidths {
  let list = Math.round(Math.max(MIN.list, w.list))
  let customer = Math.round(Math.max(MIN.customer, w.customer))

  // 聊天区优先：先压客户资料
  if (avail - list - customer < MIN.chat) {
    customer = Math.max(MIN.customer, avail - list - MIN.chat)
  }
  // 还不够就压会话列表
  if (avail - list - customer < MIN.chat) {
    list = Math.max(MIN.list, avail - customer - MIN.chat)
  }
  // 两边都到底还是放不下：由调用方决定折叠哪一栏，这里不再硬压聊天区
  return { list, customer }
}

export function defaultWidths(avail: number): PanelWidths {
  return clampWidths(
    { list: avail * DEFAULT_RATIO.list, customer: avail * DEFAULT_RATIO.customer },
    avail,
  )
}

/**
 * 读存档。任何异常都当作"没有存档"处理——布局偏好丢了顶多回到默认值，
 * 不值得为它把整个会话页搞崩（隐私模式下 localStorage 会直接抛）。
 */
export function loadWidths(): PanelWidths | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { list, customer } = parsed as Record<string, unknown>
    if (typeof list !== 'number' || typeof customer !== 'number') return null
    if (!Number.isFinite(list) || !Number.isFinite(customer)) return null
    return { list, customer }
  } catch {
    return null
  }
}

export function saveWidths(w: PanelWidths): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(w))
  } catch {
    // 存不下就算了，本次会话内的拖拽结果仍然有效
  }
}

/**
 * 空间不够时该折叠哪几栏。先收客户资料，再收会话列表——
 * 保证聊天区在窗口小到 MIN.chat 之前始终是可用的。
 */
export function visiblePanels(avail: number): { list: boolean; customer: boolean } {
  return {
    customer: avail >= MIN.list + MIN.chat + MIN.customer,
    list: avail >= MIN.list + MIN.chat,
  }
}
