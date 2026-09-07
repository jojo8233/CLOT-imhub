import type { TranslationProviderName } from '@im-hub/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TranslationProviderDialogContent } from './TranslationProviderDialog.js'

describe('TranslationProviderDialog', () => {
  it('显示全部 provider，选中当前值并禁用不可用选项', () => {
    const html = renderToStaticMarkup(<TranslationProviderDialogContent
      value="claude"
      providers={[
        { provider: 'deepl', available: true },
        { provider: 'claude', available: true },
        { provider: 'openai', available: false },
      ]}
      submitting={false}
      error={null}
      onSelect={(_provider: TranslationProviderName) => undefined}
      onSave={() => undefined}
      onClose={() => undefined}
    />)

    expect(html).toContain('DeepL')
    expect(html).toContain('Claude')
    expect(html).toContain('OpenAI')
    expect(html).toContain('暂不可用')
    expect(html).toMatch(/checked="" value="claude"/)
    expect(html).toMatch(/disabled="" name="translation-provider" value="openai"/)
  })

  it('保存失败在对话框内显示，提交期间不能重复操作', () => {
    const html = renderToStaticMarkup(<TranslationProviderDialogContent
      value="deepl"
      providers={[{ provider: 'deepl', available: true }]}
      submitting
      error="保存失败，请稍后重试"
      onSelect={() => undefined}
      onSave={() => undefined}
      onClose={() => undefined}
    />)

    expect(html).toContain('role="alert"')
    expect(html).toContain('保存失败，请稍后重试')
    expect(html).toContain('保存中…')
  })
})
