import {
  TRANSLATION_PROVIDERS,
  type TranslationProviderAvailability,
  type TranslationProviderName,
} from '@im-hub/shared'
import { theme } from '../theme.js'
import { translationProviderLabel } from './translation-provider-ui.js'

export function TranslationProviderSelect({
  value,
  providers,
  disabled = false,
  onChange,
}: {
  value: TranslationProviderName
  providers: TranslationProviderAvailability[]
  disabled?: boolean
  onChange(provider: TranslationProviderName): void
}) {
  return (
    <>
      <span style={{
        fontSize: theme.font.size.xs, color: theme.color.textFaint, whiteSpace: 'nowrap',
      }}>
        本次翻译
      </span>
      <select
        value={value}
        disabled={disabled || providers.length === 0}
        onChange={event => onChange(event.target.value as TranslationProviderName)}
        aria-label="本次翻译"
        style={{
          height: 30, minWidth: 94, padding: '0 25px 0 9px',
          border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.pill,
          background: theme.color.white, color: theme.color.textMuted,
          fontFamily: theme.font.sans, fontSize: theme.font.size.xs,
        }}
      >
        {TRANSLATION_PROVIDERS.map(provider => {
          const available = providers.some(item => item.provider === provider && item.available)
          return (
            <option key={provider} value={provider} disabled={!available}>
              {translationProviderLabel(provider)}{available ? '' : '（暂不可用）'}
            </option>
          )
        })}
      </select>
    </>
  )
}
