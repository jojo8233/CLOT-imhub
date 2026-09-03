import { renderToStaticMarkup } from 'react-dom/server'
import type { KeywordRule } from '@im-hub/shared'
import { describe, expect, it } from 'vitest'
import {
  KeywordRuleManagerContent,
  type KeywordRuleManagerContentProps,
} from './KeywordRuleManager.js'

const rule: KeywordRule = {
  id: 'rule-1',
  pattern: 'Synthetic Pattern',
  severity: 'important',
  enabled: true,
  revision: 3,
  effectiveAt: '2026-09-03T00:00:00.000Z',
  createdAt: '2026-09-03T00:00:00.000Z',
  updatedAt: '2026-09-03T00:00:00.000Z',
}

function renderContent(overrides: Partial<KeywordRuleManagerContentProps> = {}): string {
  const defaults: KeywordRuleManagerContentProps = {
    rules: [rule],
    degradedScanCount: 4,
    loading: false,
    error: null,
    pattern: '',
    severity: 'normal',
    enabled: true,
    editingRuleId: null,
    pendingDeleteId: null,
    busyRuleId: null,
    saving: false,
    retrying: false,
    onPatternChange: () => undefined,
    onSeverityChange: () => undefined,
    onEnabledChange: () => undefined,
    onSave: () => undefined,
    onEdit: () => undefined,
    onCancelEdit: () => undefined,
    onToggleEnabled: () => undefined,
    onRequestDelete: () => undefined,
    onConfirmDelete: () => undefined,
    onCancelDelete: () => undefined,
    onRefresh: () => undefined,
    onRetryScans: () => undefined,
  }
  return renderToStaticMarkup(<KeywordRuleManagerContent {...defaults} {...overrides} />)
}

function alertText(html: string): string {
  const role = html.indexOf('role="alert"')
  if (role < 0) return ''
  const start = html.lastIndexOf('<', role)
  const end = html.indexOf('</div>', role)
  return html.slice(start, end).replace(/<[^>]+>/g, '')
}

describe('KeywordRuleManagerContent', () => {
  it('renders owner rule controls, degraded count and retry action', () => {
    const html = renderContent()
    expect(html).toContain('关键词规则')
    expect(html).toContain('关键词字面量')
    expect(html).toContain('等级')
    expect(html).toContain('启用新规则')
    expect(html).toContain('新增规则')
    expect(html).toContain('Synthetic Pattern')
    expect(html).toContain('重要')
    expect(html).toContain('编辑')
    expect(html).toContain('停用')
    expect(html).toContain('删除')
    expect(html).toContain('4 条扫描任务需要处理')
    expect(html).toContain('重试扫描')
  })

  it('renders an explicit in-page soft-delete confirmation', () => {
    const html = renderContent({ pendingDeleteId: rule.id })
    expect(html).toContain('确认删除这条规则？已有告警不会被删除。')
    expect(html).toContain('确认删除')
    expect(html).toContain('取消')
  })

  it('keeps edit controls available with fixed conflict and duplicate messages', () => {
    const conflict = renderContent({
      editingRuleId: rule.id,
      pattern: 'Unsaved Pattern',
      severity: 'urgent',
      enabled: false,
      error: 'conflict',
    })
    expect(conflict).toContain('规则已被其他窗口更新，请刷新后重试')
    expect(conflict).toContain('刷新规则')
    expect(conflict).toContain('Unsaved Pattern')
    expect(conflict).toContain('保存修改')

    const duplicate = renderContent({
      pattern: 'Duplicate Pattern',
      error: 'duplicate',
    })
    expect(duplicate).toContain('关键词规则已存在')
    expect(duplicate).toContain('Duplicate Pattern')
  })

  it('uses a generic server error without echoing the submitted pattern in the alert', () => {
    const submittedPattern = 'PRIVATE_SUBMITTED_PATTERN'
    const html = renderContent({ pattern: submittedPattern, error: 'generic' })
    expect(alertText(html)).toBe('关键词规则操作失败，请稍后重试')
    expect(alertText(html)).not.toContain(submittedPattern)
  })
})
