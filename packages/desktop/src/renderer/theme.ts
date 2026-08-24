/**
 * 视觉基线。这一版的调子来自三件事，改之前先理解：
 *
 *   1. 只有三种"重色"：墨黑、柠檬绿、白。灰阶全部退到背景里当垫子
 *   2. 黑用来表示"当前所在/主操作"，绿用来表示"值得看一眼"。
 *      两个都是强调色，同一块区域里不要同时出现，否则互相打架
 *   3. 圆角给到夸张（外壳 34，卡片 26，内部元素 14~20）。这套风格的识别度
 *      有一半在圆角上，收小就变回普通后台了
 *
 * 不引入任何 CSS 框架或组件库，只把散落的魔法值收敛成常量，组件里继续用内联
 * style；伪类（hover/focus/滚动条）内联写不了，统一放 styles.ts。
 */
export const theme = {
  color: {
    /** 窗口底色。白壳浮在这层灰上 */
    page: '#e9eaea',
    bg: '#ffffff',
    surface: '#f4f5f5',
    surfaceHover: '#ebecec',
    border: '#e8e9e9',
    borderStrong: '#d6d8d8',
    text: '#0d0d0d',
    textMuted: '#6f7375',
    textFaint: '#a3a7a9',

    /** 墨黑：当前导航项、主按钮、自己发出的气泡 */
    ink: '#101010',
    inkDeep: '#000000',
    /** 黑底上的次要文字。写成常量是因为它出现在七八个地方 */
    onInk: 'rgba(255,255,255,.62)',
    onInkFaint: 'rgba(255,255,255,.4)',
    onInkLine: 'rgba(255,255,255,.16)',

    /** 柠檬绿：选中项、需要被注意到的状态 */
    lime: '#ccf656',
    limeDeep: '#b6e23e',
    limeSoft: '#f1fbd4',
    /** 绿底上的字一律用黑，绿是亮色，白字在上面看不清 */
    onLime: '#0d0d0d',

    accent: '#101010',
    accentHover: '#000000',
    accentSoft: '#f1fbd4',

    gold: '#ffc439',
    green: '#3fae6a',
    danger: '#e0364a',
    dangerSoft: '#fdecef',
    status: {
      connected: '#5bbd2e',
      reconnecting: '#e79a1a',
      degraded: '#ea6a1a',
      disconnected: '#e0364a',
      pending_auth: '#a3a7a9',
    },
  },
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  radius: { sm: 10, md: 14, lg: 20, xl: 26, xxl: 34, pill: 999 },
  font: {
    sans: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
    size: { xs: 11, sm: 12, base: 13, md: 14, lg: 17, xl: 24, xxl: 32 },
    /** 标题一律用 800——这套风格靠字重拉开层次，不靠字号堆大 */
    weight: { normal: 400, medium: 500, bold: 700, heavy: 800 },
  },
  shadow: {
    sm: '0 1px 3px rgba(13,13,13,.05)',
    md: '0 6px 18px rgba(13,13,13,.07)',
    lg: '0 16px 40px rgba(13,13,13,.13)',
    /** 最外层白壳专用，压得更开更淡 */
    app: '0 22px 60px rgba(13,13,13,.15)',
  },
} as const

/** 平台标识色。新增平台在这里补一行，头像和徽章会一起跟着变。 */
export const PLATFORM_COLOR: Record<string, string> = {
  telegram: '#101010',
  whatsapp: '#3fae6a',
  signal: '#101010',
  zoom: '#101010',
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
