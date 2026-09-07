import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AccountTabs, Brand } from './AccountTabs.js'
import { useStore } from '../store.js'

describe('desktop release identification', () => {
  it('只在公司内部未签名包显示清晰标识', () => {
    expect(renderToStaticMarkup(
      <Brand releaseChannel="internal-unsigned" />,
    )).toContain('内部未签名测试版')
    expect(renderToStaticMarkup(
      <Brand releaseChannel="development" />,
    )).not.toContain('内部未签名测试版')
  })

  it('当前用户区在修改密码旁提供翻译设置入口', () => {
    useStore.getState().reset()
    const html = renderToStaticMarkup(<AccountTabs
      currentUserName="Agent"
      onLogout={() => undefined}
      onChangePassword={() => undefined}
      onTranslationSettings={() => undefined}
      onAddAccount={() => undefined}
      canAddAccount
      releaseChannel="development"
    />)

    expect(html).toContain('修改密码')
    expect(html).toContain('翻译设置')
  })
})
