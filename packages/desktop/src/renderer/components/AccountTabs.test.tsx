import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Brand } from './AccountTabs.js'

describe('desktop release identification', () => {
  it('只在公司内部未签名包显示清晰标识', () => {
    expect(renderToStaticMarkup(
      <Brand releaseChannel="internal-unsigned" />,
    )).toContain('内部未签名测试版')
    expect(renderToStaticMarkup(
      <Brand releaseChannel="development" />,
    )).not.toContain('内部未签名测试版')
  })
})
