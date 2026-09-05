import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  InitialPasswordPageContent,
  passwordChangeError,
  passwordFormReducer,
} from './InitialPasswordPage.js'

describe('InitialPasswordPage', () => {
  it('要求两次输入 12–128 字符的新密码，长度计算不 trim', () => {
    expect(passwordChangeError('short', 'short')).toContain('12')
    expect(passwordChangeError('a'.repeat(129), 'a'.repeat(129))).toContain('128')
    expect(passwordChangeError(' '.repeat(12), ' '.repeat(12))).toBeNull()
    expect(passwordChangeError('valid-password', 'different-value')).toContain('一致')

    const html = renderToStaticMarkup(<InitialPasswordPageContent
      displayName="Agent"
      newPassword="short"
      confirmPassword="short"
      submitting={false}
      error={passwordChangeError('short', 'short')}
      onNewPassword={() => {}}
      onConfirmPassword={() => {}}
      onSubmit={() => {}}
    />)
    expect(html).toContain('首次登录')
    expect(html.match(/type="password"/g)).toHaveLength(2)
    expect(html).toContain('12')
  })

  it('成功动作清空两个密码字段', () => {
    expect(passwordFormReducer({
      newPassword: 'replacement-password',
      confirmPassword: 'replacement-password',
    }, { type: 'clear' })).toEqual({ newPassword: '', confirmPassword: '' })
  })
})
