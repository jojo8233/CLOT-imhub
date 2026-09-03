import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import type { KeywordAlertSeverity, KeywordRule } from '@im-hub/shared'
import {
  api,
  HttpError,
  NetworkError,
  UnauthorizedError,
} from '../api/client.js'
import { theme } from '../theme.js'

export type KeywordRuleManagerError = 'network' | 'conflict' | 'duplicate' | 'generic'

export interface KeywordRuleManagerContentProps {
  rules: KeywordRule[]
  degradedScanCount: number
  loading: boolean
  error: KeywordRuleManagerError | null
  pattern: string
  severity: KeywordAlertSeverity
  enabled: boolean
  editingRuleId: string | null
  pendingDeleteId: string | null
  busyRuleId: string | null
  saving: boolean
  retrying: boolean
  onPatternChange(value: string): void
  onSeverityChange(value: KeywordAlertSeverity): void
  onEnabledChange(value: boolean): void
  onSave(): void
  onEdit(rule: KeywordRule): void
  onCancelEdit(): void
  onToggleEnabled(rule: KeywordRule): void
  onRequestDelete(ruleId: string): void
  onConfirmDelete(ruleId: string): void
  onCancelDelete(): void
  onRefresh(): void
  onRetryScans(): void
}

const SEVERITY_LABEL: Record<KeywordAlertSeverity, string> = {
  normal: '普通',
  important: '重要',
  urgent: '紧急',
}

function ruleError(error: unknown): KeywordRuleManagerError | null {
  if (error instanceof UnauthorizedError) return null
  if (error instanceof NetworkError) return 'network'
  if (error instanceof HttpError && error.status === 409) {
    return error.message.includes('关键词规则已存在') ? 'duplicate' : 'conflict'
  }
  return 'generic'
}

function replaceRule(rules: KeywordRule[], replacement: KeywordRule): KeywordRule[] {
  return rules.map(rule => rule.id === replacement.id ? replacement : rule)
}

export function KeywordRuleManager() {
  const [rules, setRules] = useState<KeywordRule[]>([])
  const [degradedScanCount, setDegradedScanCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<KeywordRuleManagerError | null>(null)
  const [pattern, setPattern] = useState('')
  const [severity, setSeverity] = useState<KeywordAlertSeverity>('normal')
  const [enabled, setEnabled] = useState(true)
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const loadGenerationRef = useRef(0)

  const loadRules = useCallback(() => {
    const generation = ++loadGenerationRef.current
    setLoading(true)
    setError(null)
    void api.listKeywordRules().then(result => {
      if (generation !== loadGenerationRef.current) return
      setRules(result.rules)
      setDegradedScanCount(result.degradedScanCount)
    }).catch(loadError => {
      if (generation !== loadGenerationRef.current) return
      const mapped = ruleError(loadError)
      if (mapped) setError(mapped)
    }).finally(() => {
      if (generation === loadGenerationRef.current) setLoading(false)
    })
  }, [])

  useEffect(() => {
    loadRules()
    return () => {
      loadGenerationRef.current += 1
    }
  }, [loadRules])

  const resetForm = useCallback(() => {
    setPattern('')
    setSeverity('normal')
    setEnabled(true)
    setEditingRuleId(null)
  }, [])

  const save = useCallback(() => {
    if (saving || busyRuleId || pattern.trim() === '') return
    const current = editingRuleId
      ? rules.find(rule => rule.id === editingRuleId)
      : null
    if (editingRuleId && !current) {
      setError('generic')
      return
    }
    setSaving(true)
    setError(null)
    const request = current
      ? api.updateKeywordRule(current.id, {
        baseRevision: current.revision,
        pattern,
        severity,
        enabled,
      })
      : api.createKeywordRule({ pattern, severity, enabled })
    void request.then(savedRule => {
      setRules(previous => current
        ? replaceRule(previous, savedRule)
        : [...previous, savedRule])
      resetForm()
    }).catch(saveError => {
      const mapped = ruleError(saveError)
      if (mapped) setError(mapped)
    }).finally(() => setSaving(false))
  }, [busyRuleId, editingRuleId, enabled, pattern, resetForm, rules, saving, severity])

  const edit = useCallback((rule: KeywordRule) => {
    if (saving || busyRuleId) return
    setEditingRuleId(rule.id)
    setPattern(rule.pattern)
    setSeverity(rule.severity)
    setEnabled(rule.enabled)
    setPendingDeleteId(null)
    setError(null)
  }, [busyRuleId, saving])

  const toggleEnabled = useCallback((rule: KeywordRule) => {
    if (saving || busyRuleId) return
    setBusyRuleId(rule.id)
    setError(null)
    void api.updateKeywordRule(rule.id, {
      baseRevision: rule.revision,
      enabled: !rule.enabled,
    }).then(savedRule => {
      setRules(previous => replaceRule(previous, savedRule))
      if (editingRuleId === rule.id) {
        setEnabled(savedRule.enabled)
      }
    }).catch(updateError => {
      const mapped = ruleError(updateError)
      if (mapped) setError(mapped)
    }).finally(() => setBusyRuleId(null))
  }, [busyRuleId, editingRuleId, saving])

  const confirmDelete = useCallback((ruleId: string) => {
    if (saving || busyRuleId || pendingDeleteId !== ruleId) return
    const rule = rules.find(candidate => candidate.id === ruleId)
    if (!rule) {
      setPendingDeleteId(null)
      return
    }
    setBusyRuleId(ruleId)
    setError(null)
    void api.deleteKeywordRule(ruleId, rule.revision).then(() => {
      setRules(previous => previous.filter(candidate => candidate.id !== ruleId))
      setPendingDeleteId(null)
      if (editingRuleId === ruleId) resetForm()
    }).catch(deleteError => {
      const mapped = ruleError(deleteError)
      if (mapped) setError(mapped)
    }).finally(() => setBusyRuleId(null))
  }, [busyRuleId, editingRuleId, pendingDeleteId, resetForm, rules, saving])

  const retryScans = useCallback(() => {
    if (retrying) return
    setRetrying(true)
    setError(null)
    void api.retryKeywordAlertScans().then(() => {
      loadRules()
    }).catch(retryError => {
      const mapped = ruleError(retryError)
      if (mapped) setError(mapped)
    }).finally(() => setRetrying(false))
  }, [loadRules, retrying])

  return (
    <KeywordRuleManagerContent
      rules={rules}
      degradedScanCount={degradedScanCount}
      loading={loading}
      error={error}
      pattern={pattern}
      severity={severity}
      enabled={enabled}
      editingRuleId={editingRuleId}
      pendingDeleteId={pendingDeleteId}
      busyRuleId={busyRuleId}
      saving={saving}
      retrying={retrying}
      onPatternChange={setPattern}
      onSeverityChange={setSeverity}
      onEnabledChange={setEnabled}
      onSave={save}
      onEdit={edit}
      onCancelEdit={resetForm}
      onToggleEnabled={toggleEnabled}
      onRequestDelete={setPendingDeleteId}
      onConfirmDelete={confirmDelete}
      onCancelDelete={() => setPendingDeleteId(null)}
      onRefresh={loadRules}
      onRetryScans={retryScans}
    />
  )
}

export function KeywordRuleManagerContent({
  rules,
  degradedScanCount,
  loading,
  error,
  pattern,
  severity,
  enabled,
  editingRuleId,
  pendingDeleteId,
  busyRuleId,
  saving,
  retrying,
  onPatternChange,
  onSeverityChange,
  onEnabledChange,
  onSave,
  onEdit,
  onCancelEdit,
  onToggleEnabled,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  onRefresh,
  onRetryScans,
}: KeywordRuleManagerContentProps) {
  return (
    <section style={managerStyle}>
      <header style={sectionHeaderStyle}>
        <div>
          <h3 style={headingStyle}>关键词规则</h3>
          <div style={subtleStyle}>规则只匹配生效后的客户入站消息</div>
        </div>
        <button className="ih-btn" type="button" onClick={onRefresh} style={secondaryButtonStyle}>
          刷新规则
        </button>
      </header>

      {degradedScanCount > 0 && (
        <div style={degradedStyle}>
          <span>{degradedScanCount} 条扫描任务需要处理</span>
          <button
            className="ih-btn"
            type="button"
            disabled={retrying}
            onClick={onRetryScans}
            style={secondaryButtonStyle}
          >
            {retrying ? '正在重试…' : '重试扫描'}
          </button>
        </div>
      )}

      <div style={formStyle}>
        <label style={fieldStyle}>
          <span>关键词字面量</span>
          <input
            aria-label="关键词字面量"
            value={pattern}
            onChange={event => onPatternChange(event.currentTarget.value)}
            style={controlStyle}
          />
        </label>
        <label style={fieldStyle}>
          <span>等级</span>
          <select
            aria-label="规则等级"
            value={severity}
            onChange={event => onSeverityChange(event.currentTarget.value as KeywordAlertSeverity)}
            style={controlStyle}
          >
            <option value="normal">普通</option>
            <option value="important">重要</option>
            <option value="urgent">紧急</option>
          </select>
        </label>
        <label style={checkStyle}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={event => onEnabledChange(event.currentTarget.checked)}
          />
          启用新规则
        </label>
        <div style={{ display: 'flex', gap: theme.space.sm, alignItems: 'flex-end' }}>
          <button
            className="ih-btn"
            type="button"
            disabled={saving || pattern.trim() === ''}
            onClick={onSave}
            style={primaryButtonStyle}
          >
            {saving ? '正在保存…' : editingRuleId ? '保存修改' : '新增规则'}
          </button>
          {editingRuleId && (
            <button className="ih-btn" type="button" onClick={onCancelEdit} style={secondaryButtonStyle}>
              取消编辑
            </button>
          )}
        </div>
      </div>

      {error && (
        <div role="alert" style={errorStyle}>
          {error === 'network'
            ? '连不上服务端，请稍后重试'
            : error === 'conflict'
              ? '规则已被其他窗口更新，请刷新后重试'
              : error === 'duplicate'
                ? '关键词规则已存在'
                : '关键词规则操作失败，请稍后重试'}
          {error === 'conflict' && (
            <button className="ih-btn" type="button" onClick={onRefresh} style={inlineButtonStyle}>
              刷新规则
            </button>
          )}
        </div>
      )}

      {loading && rules.length === 0 ? (
        <RuleNotice>正在加载关键词规则…</RuleNotice>
      ) : rules.length === 0 ? (
        <RuleNotice>还没有关键词规则</RuleNotice>
      ) : (
        <div style={listStyle}>
          {rules.map(rule => (
            <article key={rule.id} style={ruleStyle}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="ih-selectable" style={patternStyle}>{rule.pattern}</div>
                <div style={subtleStyle}>
                  {SEVERITY_LABEL[rule.severity]} · {rule.enabled ? '已启用' : '已停用'} · 版本 {rule.revision}
                </div>
              </div>
              {pendingDeleteId === rule.id ? (
                <div style={confirmStyle}>
                  <span>确认删除这条规则？已有告警不会被删除。</span>
                  <button
                    className="ih-btn"
                    type="button"
                    disabled={busyRuleId === rule.id}
                    onClick={() => onConfirmDelete(rule.id)}
                    style={dangerButtonStyle}
                  >
                    确认删除
                  </button>
                  <button className="ih-btn" type="button" onClick={onCancelDelete} style={secondaryButtonStyle}>
                    取消
                  </button>
                </div>
              ) : (
                <div style={actionsStyle}>
                  <button className="ih-btn" type="button" onClick={() => onEdit(rule)} style={secondaryButtonStyle}>
                    编辑
                  </button>
                  <button
                    className="ih-btn"
                    type="button"
                    disabled={busyRuleId === rule.id}
                    onClick={() => onToggleEnabled(rule)}
                    style={secondaryButtonStyle}
                  >
                    {rule.enabled ? '停用' : '启用'}
                  </button>
                  <button
                    className="ih-btn"
                    type="button"
                    onClick={() => onRequestDelete(rule.id)}
                    style={dangerButtonStyle}
                  >
                    删除
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function RuleNotice({ children }: { children: string }) {
  return <div style={noticeStyle}>{children}</div>
}

const managerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: theme.space.md,
  padding: theme.space.xl,
}

const sectionHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: theme.space.md,
}

const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: theme.font.size.lg,
  fontWeight: theme.font.weight.heavy,
}

const subtleStyle: CSSProperties = {
  marginTop: theme.space.xs,
  color: theme.color.textMuted,
  fontSize: theme.font.size.xs,
}

const degradedStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: theme.space.md,
  padding: theme.space.md,
  borderRadius: theme.radius.md,
  background: theme.color.dangerSoft,
  color: theme.color.danger,
  fontSize: theme.font.size.sm,
}

const formStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-end',
  gap: theme.space.md,
  padding: theme.space.lg,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.lg,
  background: theme.color.card,
}

const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: theme.space.xs,
  minWidth: 180,
  color: theme.color.textMuted,
  fontSize: theme.font.size.xs,
}

const checkStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: theme.space.xs,
  minHeight: 38,
  color: theme.color.text,
  fontSize: theme.font.size.sm,
}

const controlStyle: CSSProperties = {
  minHeight: 38,
  padding: '8px 10px',
  border: `1px solid ${theme.color.borderStrong}`,
  borderRadius: theme.radius.md,
  background: theme.color.white,
  color: theme.color.text,
  font: 'inherit',
}

const primaryButtonStyle: CSSProperties = {
  minHeight: 38,
  padding: '0 14px',
  border: 0,
  borderRadius: theme.radius.md,
  background: theme.color.ink,
  color: theme.color.onInk,
  fontWeight: theme.font.weight.bold,
}

const secondaryButtonStyle: CSSProperties = {
  minHeight: 34,
  padding: '0 12px',
  border: `1px solid ${theme.color.borderStrong}`,
  borderRadius: theme.radius.md,
  background: theme.color.card,
  color: theme.color.text,
}

const dangerButtonStyle: CSSProperties = {
  ...secondaryButtonStyle,
  color: theme.color.danger,
  borderColor: theme.color.danger,
}

const inlineButtonStyle: CSSProperties = {
  ...secondaryButtonStyle,
  marginLeft: theme.space.sm,
}

const errorStyle: CSSProperties = {
  padding: theme.space.md,
  borderRadius: theme.radius.md,
  background: theme.color.dangerSoft,
  color: theme.color.danger,
  fontSize: theme.font.size.sm,
}

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: theme.space.sm,
}

const ruleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: theme.space.md,
  padding: theme.space.md,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.lg,
  background: theme.color.card,
}

const patternStyle: CSSProperties = {
  overflowWrap: 'anywhere',
  fontWeight: theme.font.weight.bold,
}

const actionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: theme.space.xs,
}

const confirmStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: theme.space.xs,
  color: theme.color.danger,
  fontSize: theme.font.size.sm,
}

const noticeStyle: CSSProperties = {
  padding: theme.space.xl,
  textAlign: 'center',
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm,
}
