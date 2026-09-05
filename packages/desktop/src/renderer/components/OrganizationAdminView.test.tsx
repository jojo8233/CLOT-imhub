import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Role } from '@im-hub/shared'

import { OrganizationAdminViewContent } from './OrganizationAdminView.js'
import { AdminConfirmationDialogContent } from './AdminConfirmationDialog.js'
import {
  closeTemporaryPassword,
  copyTemporaryPassword,
  TemporaryPasswordDialogContent,
} from './TemporaryPasswordDialog.js'

describe('OrganizationAdminView owner boundary', () => {
  for (const role of ['manager', 'auditor', 'agent'] satisfies Role[]) {
    it(`${role} 直接渲染也没有管理控件`, () => {
      expect(renderToStaticMarkup(<OrganizationAdminViewContent
        role={role}
        activeTab="employees"
        onTabChange={() => {}}
        employees={<div>员工管理动作</div>}
        teams={<div>团队管理动作</div>}
        accounts={<div>账号管理动作</div>}
      />)).toBe('')
    })
  }

  it('owner 可在员工、团队和平台账号三个页签间切换', () => {
    const html = renderToStaticMarkup(<OrganizationAdminViewContent
      role="owner"
      activeTab="employees"
      onTabChange={() => {}}
      employees={<div>员工管理动作</div>}
      teams={<div>团队管理动作</div>}
      accounts={<div>账号管理动作</div>}
    />)
    expect(html).toContain('员工')
    expect(html).toContain('团队')
    expect(html).toContain('平台账号')
    expect(html).toContain('员工管理动作')
  })
})

describe('organization admin sensitive dialogs', () => {
  it('确认页先展示摘要，网络结果未知时禁止重复执行', () => {
    const html = renderToStaticMarkup(<AdminConfirmationDialogContent
      title="确认停用"
      preview={{
        operationToken: 'must-not-render',
        expiresAt: '2026-09-05T01:00:00.000Z',
        summary: { affectedAccounts: 3, cleanupTasks: 2 },
      }}
      outcome="unknown"
      currentPassword="owner-password-must-not-render"
      requiresCurrentPassword
      onCurrentPassword={() => {}}
      onConfirm={() => {}}
      onCancel={() => {}}
    />)
    expect(html).toContain('affectedAccounts')
    expect(html).toContain('>3<')
    expect(html).toContain('结果待核对')
    expect(html).toContain('disabled')
    expect(html).not.toContain('must-not-render')
  })

  it('临时密码只在成功弹窗显示，复制和清除都由显式动作触发', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const clear = vi.fn()
    const close = vi.fn()
    const html = renderToStaticMarkup(<TemporaryPasswordDialogContent
      temporaryPassword="temporary-password-sentinel"
      expiresAt="2026-09-06T00:00:00.000Z"
      copied={false}
      onCopy={() => {}}
      onClose={() => {}}
    />)
    expect(html).toContain('temporary-password-sentinel')
    expect(html).not.toContain('type="hidden"')
    expect(writeText).not.toHaveBeenCalled()
    await copyTemporaryPassword('temporary-password-sentinel', { writeText })
    expect(writeText).toHaveBeenCalledWith('temporary-password-sentinel')
    closeTemporaryPassword(clear, close)
    expect(clear.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0] ?? 0)
  })
})
