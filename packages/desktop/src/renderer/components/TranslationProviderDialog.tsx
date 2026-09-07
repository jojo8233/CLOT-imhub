import type {
  TranslationProviderAvailability,
  TranslationProviderName,
} from '@im-hub/shared'
import { useEffect, useState } from 'react'
import { theme } from '../theme.js'

const PROVIDER_LABEL: Record<TranslationProviderName, string> = {
  deepl: 'DeepL',
  claude: 'Claude',
  openai: 'OpenAI',
}

interface Props {
  open: boolean
  value: TranslationProviderName
  providers: TranslationProviderAvailability[]
  loading?: boolean
  loadError?: string | null
  onSave(provider: TranslationProviderName): Promise<void> | void
  onClose(): void
}

export function TranslationProviderDialog({
  open,
  value,
  providers,
  loading = false,
  loadError = null,
  onSave,
  onClose,
}: Props) {
  const [selected, setSelected] = useState(value)
  const [submitting, setSubmitting] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setSelected(value)
    setSaveError(null)
  }, [open, value])

  if (!open) return null

  async function save(): Promise<void> {
    if (loading || submitting) return
    setSubmitting(true)
    setSaveError(null)
    try {
      await onSave(selected)
      onClose()
    } catch {
      setSaveError('保存失败，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  return <TranslationProviderDialogContent
    value={selected}
    providers={providers}
    loading={loading}
    submitting={submitting}
    error={loadError ?? saveError}
    onSelect={setSelected}
    onSave={() => void save()}
    onClose={() => { if (!submitting) onClose() }}
  />
}

export function TranslationProviderDialogContent({
  value,
  providers,
  loading = false,
  submitting,
  error,
  onSelect,
  onSave,
  onClose,
}: {
  value: TranslationProviderName
  providers: TranslationProviderAvailability[]
  loading?: boolean
  submitting: boolean
  error: string | null
  onSelect(provider: TranslationProviderName): void
  onSave(): void
  onClose(): void
}) {
  const selectedAvailable = providers.some(item => item.provider === value && item.available)
  return (
    <div role="presentation" style={overlayStyle} onMouseDown={(event) => {
      if (event.target === event.currentTarget && !submitting) onClose()
    }}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label="翻译设置"
        onSubmit={(event) => { event.preventDefault(); onSave() }}
        style={dialogStyle}
      >
        <h2 style={{ margin: 0, fontSize: theme.font.size.lg }}>默认翻译服务</h2>
        <p style={{ margin: `${theme.space.sm}px 0 ${theme.space.lg}px`, color: theme.color.textMuted }}>
          仅修改你自己的默认选择，不影响其他员工。
        </p>
        {loading ? (
          <div role="status" style={{ color: theme.color.textMuted }}>正在读取可用服务…</div>
        ) : providers.map(item => (
          <label key={item.provider} style={optionStyle(item.available)}>
            <input
              type="radio"
              name="translation-provider"
              value={item.provider}
              checked={value === item.provider}
              disabled={submitting || !item.available}
              onChange={() => onSelect(item.provider)}
            />
            <span style={{ fontWeight: theme.font.weight.bold }}>
              {PROVIDER_LABEL[item.provider]}
            </span>
            {!item.available && (
              <span style={{ marginLeft: 'auto', color: theme.color.textFaint }}>暂不可用</span>
            )}
          </label>
        ))}
        {error && <div role="alert" style={errorStyle}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: theme.space.sm, marginTop: theme.space.lg }}>
          <button type="button" className="ih-btn" disabled={submitting} onClick={onClose}>取消</button>
          <button
            type="submit"
            className="ih-btn"
            disabled={loading || submitting || !selectedAvailable}
            style={{ background: theme.color.ink, color: theme.color.lime }}
          >
            {submitting ? '保存中…' : '保存默认选择'}
          </button>
        </div>
      </form>
    </div>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'center',
  justifyContent: 'center', background: 'rgba(35,37,35,.34)', fontFamily: theme.font.sans,
}
const dialogStyle: React.CSSProperties = {
  width: 420, padding: theme.space.xl, borderRadius: theme.radius.xl,
  background: theme.color.card, boxShadow: theme.shadow.lg, color: theme.color.text,
}
const optionStyle = (available: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: theme.space.sm,
  marginBottom: theme.space.sm, padding: '11px 12px',
  border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.md,
  color: available ? theme.color.text : theme.color.textFaint,
  background: available ? theme.color.white : theme.color.surface,
})
const errorStyle: React.CSSProperties = {
  marginTop: theme.space.md, padding: '8px 10px', borderRadius: theme.radius.sm,
  color: theme.color.danger, background: theme.color.dangerSoft, fontSize: theme.font.size.sm,
}
