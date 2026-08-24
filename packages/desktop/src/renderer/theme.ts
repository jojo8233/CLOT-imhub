/**
 * 视觉基线。这是给员工盯一整天的工具，所以配色的第一目标是"看得久"，
 * 不是"截图好看"。三条原则：
 *
 *   1. 没有大片纯白，也没有接近纯黑。层次靠一组间距很小的灰阶拉开
 *      （page → bg → card → white 逐级变亮，chat 是聊天流专用的一档）。
 *      视线在栏目间移动时不该反复经历"白 → 黑 → 荧光绿"。
 *   2. 绿只当点缀。高饱和的荧光绿铺满大面积会很快让人累，所以大块区域
 *      一律用 limeSoft，纯 lime 只留给小面积的选中态、状态标和主按钮。
 *   3. 浅灰文字要够深。看不清同样费眼——弱提示到 textFaint 就是下限，
 *      不要再往浅里调，也不要靠 opacity 把文字二次调淡。
 */
export const theme = {
  color: {
    // ── 灰阶层次。从暗到亮：page < bg < card < white，chat 单独一档 ──
    /** 窗口底色，白壳浮在它上面 */
    page: '#e8eae6',
    /** 主背景：各栏底色 */
    bg: '#f5f6f4',
    /** 卡片：比主背景亮一点点，用层级而不是纯白 */
    card: '#fafbf9',
    /** 最高层：输入框、对方气泡。只有真正需要"最亮"的地方才用 */
    white: '#ffffff',
    /** 聊天流背景。比主背景再暗一档，气泡才浮得起来 */
    chat: '#f1f2f0',
    /** 凹陷填充：chip、统计块 */
    surface: '#edefeb',
    surfaceHover: '#e7e9e5',
    border: '#e4e6e2',
    borderStrong: '#d6d9d2',

    // ── 文字。三档，不再往浅里走 ──
    text: '#303330',
    textMuted: '#6f746f',
    textFaint: '#969b96',

    // ── 墨色。避开纯黑，大面积色块用 inkSoft ──
    /** 主按钮、当前导航项 */
    ink: '#292b29',
    /** 自己发出的气泡等大色块，比 ink 再亮一档 */
    inkSoft: '#303230',
    /** 悬浮层，需要压过底下的气泡才用得上更深的一档 */
    inkDeep: '#232523',
    /** 墨色上的文字也不用纯白 */
    onInk: '#f1f2ef',
    onInkMuted: 'rgba(241,242,239,.68)',
    onInkFaint: 'rgba(241,242,239,.46)',
    onInkLine: 'rgba(241,242,239,.15)',

    // ── 绿。柔和版，纯 lime 只用于小面积 ──
    lime: '#b8e85a',
    limeDeep: '#a3d446',
    /** 大面积用这个。客户卡片那种整块铺色一律走 limeSoft */
    limeSoft: '#eaf3d9',
    onLime: '#2c3025',

    accent: '#292b29',
    accentHover: '#1f211f',
    accentSoft: '#eaf3d9',

    gold: '#e0b544',
    green: '#5c9c4a',
    danger: '#c2554b',
    dangerSoft: '#f8ecea',
    status: {
      connected: '#63a83f',
      reconnecting: '#c8912f',
      degraded: '#c9722f',
      disconnected: '#c2554b',
      pending_auth: '#969b96',
    },
  },
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  radius: { sm: 10, md: 14, lg: 20, xl: 26, xxl: 34, pill: 999 },
  font: {
    sans: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
    size: { xs: 11, sm: 12, base: 13, md: 14, lg: 17, xl: 24, xxl: 32 },
    /** 标题一律用 800——这套风格靠字重拉层次，不靠字号堆大 */
    weight: { normal: 400, medium: 500, bold: 700, heavy: 800 },
  },
  shadow: {
    // 底色不再是纯白，影子跟着收淡，否则会显脏
    sm: '0 1px 2px rgba(48,51,48,.04)',
    md: '0 4px 14px rgba(48,51,48,.05)',
    lg: '0 14px 36px rgba(48,51,48,.10)',
    /** 最外层白壳专用 */
    app: '0 20px 52px rgba(48,51,48,.12)',
  },
} as const

/** 平台标识色。新增平台在这里补一行，头像和徽章会一起跟着变。 */
export const PLATFORM_COLOR: Record<string, string> = {
  telegram: '#292b29',
  whatsapp: '#5c9c4a',
  signal: '#292b29',
  zoom: '#292b29',
}

export const PLATFORM_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  signal: 'Signal',
  zoom: 'Zoom',
}

export const STATUS_LABEL: Record<string, string> = {
  connected: '在线',
  reconnecting: '重连中',
  degraded: '降级',
  disconnected: '已断开',
  pending_auth: '待登录',
}
