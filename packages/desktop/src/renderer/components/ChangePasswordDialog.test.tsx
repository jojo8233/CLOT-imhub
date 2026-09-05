import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  ChangePasswordDialogContent,
  changePasswordFormReducer,
} from './ChangePasswordDialog.js'

describe('ChangePasswordDialog', () => {
  it('显示当前密码和两次新密码，提交期间不能关闭或重复提交', () => {
    const html = renderToStaticMarkup(<ChangePasswordDialogContent
      currentPassword="current-password"
      newPassword="replacement-password"
      confirmPassword="replacement-password"
      submitting
      error={null}
      onCurrentPassword={() => {}}
      onNewPassword={() => {}}
      onConfirmPassword={() => {}}
      onSubmit={() => {}}
      onClose={() => {}}
    />)

    expect(html).toContain('修改密码')
    expect(html.match(/type="password"/g)).toHaveLength(3)
    expect(html).toContain('disabled')
  })

  it('成功动作清空当前密码和两个新密码字段', () => {
    expect(changePasswordFormReducer({
      currentPassword: 'current-password',
      newPassword: 'replacement-password',
      confirmPassword: 'replacement-password',
    }, { type: 'clear' })).toEqual({
      currentPassword: '', newPassword: '', confirmPassword: '',
    })
  })
})
