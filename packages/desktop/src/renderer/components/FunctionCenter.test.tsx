import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FunctionCenter, FUNCTION_CENTER_ENTRIES } from './FunctionCenter.js'
import type { Role } from '@im-hub/shared'

function renderFunctionCenter(
  keywordAlertCount: number | null,
  compact = false,
  role: Role = 'owner',
): string {
  return renderToStaticMarkup(
    <FunctionCenter
      view="chat"
      keywordAlertCount={keywordAlertCount}
      onSelectView={() => undefined}
      onAddAccount={() => undefined}
      compact={compact}
      role={role}
    />,
  )
}

describe('FunctionCenter entries', () => {
  it('wires customer profiles and removes misleading translation history', () => {
    expect(FUNCTION_CENTER_ENTRIES).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '客户档案库', view: 'customerProfiles' }),
      expect.objectContaining({ title: '关键词警报', view: 'keywordAlerts' }),
    ]))
    expect(FUNCTION_CENTER_ENTRIES.some(entry => entry.title === '翻译历史')).toBe(false)
  })

  it('renders the in-memory alert badge in expanded and compact modes', () => {
    expect(renderFunctionCenter(3)).toContain('>3</span>')
    expect(renderFunctionCenter(3, true)).toContain('>3</span>')
    expect(renderFunctionCenter(100)).toContain('>99+</span>')
  })

  it('omits the badge for null and zero counts', () => {
    expect(renderFunctionCenter(null)).not.toContain('data-keyword-alert-badge')
    expect(renderFunctionCenter(0)).not.toContain('data-keyword-alert-badge')
  })

  it('管理中心入口仅 owner 可见', () => {
    expect(renderFunctionCenter(null, false, 'owner')).toContain('管理中心')
    expect(renderFunctionCenter(null, false, 'manager')).not.toContain('管理中心')
    expect(renderFunctionCenter(null, false, 'auditor')).not.toContain('管理中心')
    expect(renderFunctionCenter(null, false, 'agent')).not.toContain('管理中心')
  })

  it('auditor 不显示添加账号入口', () => {
    expect(renderFunctionCenter(null, false, 'auditor')).not.toContain('添加账号')
    expect(renderFunctionCenter(null, false, 'manager')).toContain('添加账号')
  })
})
