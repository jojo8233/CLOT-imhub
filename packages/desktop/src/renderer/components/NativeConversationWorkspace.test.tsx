import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LegacyWhatsAppCloudWorkspace } from './NativeConversationWorkspace.js'

describe('legacy WhatsApp Cloud workspace', () => {
  it('shows an unavailable placeholder without chat or translation actions', () => {
    const html = renderToStaticMarkup(<LegacyWhatsAppCloudWorkspace />)
    expect(html).toContain('旧 Cloud 账号')
    expect(html).toContain('当前产品不支持连接')
    expect(html).not.toContain('发送')
    expect(html).not.toContain('翻译')
  })
})
