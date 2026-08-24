import { theme as t } from './theme.js'

/**
 * 伪类样式（hover / focus / 滚动条 / 动画）内联 style 写不了，只能走样式表。
 * 从 theme 拼出来而不是手写一份 CSS 文件，是为了颜色只有一个出处——
 * 否则改色板时这里会悄悄留在旧值上，而且不会有任何编译错误提醒你。
 */
const css = `
  * { box-sizing: border-box; }
  html, body, #root { height: 100%; margin: 0; }
  body {
    background: ${t.color.page};
    color: ${t.color.text};
    font-family: ${t.font.sans};
    -webkit-font-smoothing: antialiased;
  }
  /* Electron 里整窗拖选文字几乎只会误触，只在真正要读的内容上放开 */
  #root { user-select: none; }
  .ih-selectable, input, textarea { user-select: text; }

  button { font-family: inherit; }
  button:not(:disabled) { cursor: pointer; }
  button:disabled { cursor: default; opacity: .5; }

  input:focus, textarea:focus, select:focus {
    outline: none;
    border-color: ${t.color.accent} !important;
    box-shadow: 0 0 0 3px ${t.color.accentSoft};
  }

  /* 细滚动条：默认那条在浅灰卡片上太重，会把视线从内容上拽走 */
  .ih-scroll { overflow-y: auto; scrollbar-width: thin; }
  .ih-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
  .ih-scroll::-webkit-scrollbar-track { background: transparent; }
  .ih-scroll::-webkit-scrollbar-thumb {
    background: ${t.color.borderStrong}; border-radius: 4px;
    border: 2px solid transparent; background-clip: content-box;
  }
  .ih-scroll::-webkit-scrollbar-thumb:hover { background-color: ${t.color.textFaint}; background-clip: content-box; }

  /* 可点行的通用悬停。选中态由内联 style 覆盖 background，所以这里不加 !important */
  .ih-row { transition: background .12s ease; }
  .ih-row:hover { background: ${t.color.surfaceHover}; }

  .ih-tab { transition: background .12s ease, border-color .12s ease; }
  .ih-tab:hover { background: ${t.color.surfaceHover}; }

  .ih-btn { transition: background .12s ease, opacity .12s ease; }
  .ih-btn:not(:disabled):hover { filter: brightness(.94); }

  @keyframes ih-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  .ih-fade { animation: ih-fade .16s ease both; }

  @keyframes ih-pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
  .ih-pulse { animation: ih-pulse 1.4s ease-in-out infinite; }
`

export function injectGlobalStyles(): void {
  const el = document.createElement('style')
  el.textContent = css
  document.head.appendChild(el)
}
