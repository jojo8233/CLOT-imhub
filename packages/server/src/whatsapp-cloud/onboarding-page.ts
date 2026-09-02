import type { WhatsAppCloudPublicConfig } from './service.js'

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/**
 * Embedded Signup 必须运行在公开 HTTPS origin。页面只拿公开 app/config/version 与
 * URL fragment 中的一次性 ticket；Meta code 立即 POST 回同源服务端，不进入 Electron。
 */
export function renderWhatsAppOnboardingPage(
  config: WhatsAppCloudPublicConfig,
  nonce: string,
): string {
  const publicConfig = safeJson(config)
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>关联 WhatsApp Business</title>
  <style nonce="${nonce}">
    body{margin:0;background:#eef0ec;color:#292b29;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{max-width:520px;margin:10vh auto;padding:32px;background:#fff;border-radius:24px;box-shadow:0 16px 50px rgba(30,35,30,.12)}
    h1{margin:0 0 10px;font-size:24px}p{line-height:1.7;color:#676c67}button{border:0;border-radius:999px;padding:12px 22px;background:#292b29;color:#b7f34a;font-weight:700;font-size:15px;cursor:pointer}button:disabled{opacity:.45;cursor:default}.error{color:#bd3c37}.ok{color:#39751d}
  </style>
</head>
<body><main>
  <h1>关联 WhatsApp Business</h1>
  <p id="status">正在加载 Meta 官方关联流程…</p>
  <button id="start" disabled>继续使用 Meta 关联</button>
</main>
<script nonce="${nonce}">
(() => {
  'use strict'
  const config = ${publicConfig}
  const status = document.getElementById('status')
  const start = document.getElementById('start')
  const params = new URLSearchParams(location.hash.slice(1))
  const ticket = params.get('ticket') || ''
  history.replaceState(null, '', location.pathname)
  let code = null
  let assets = null
  let completing = false

  function fail(message) {
    status.textContent = message
    status.className = 'error'
    start.disabled = true
  }
  async function maybeComplete() {
    if (!code || !assets || completing) return
    completing = true
    status.textContent = '正在由 im-hub 服务端确认授权…'
    try {
      const response = await fetch('/api/whatsapp/cloud/onboard/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticket,
          code,
          wabaId: assets.waba_id,
          phoneNumberId: assets.phone_number_id,
        }),
      })
      if (!response.ok) throw new Error('complete failed')
      status.textContent = '关联完成。可以关闭此页面并返回 im-hub。'
      status.className = 'ok'
      start.hidden = true
    } catch {
      fail('关联确认失败或票据已过期。请返回 im-hub 重新发起。')
    }
  }

  window.addEventListener('message', event => {
    if (event.origin !== 'https://www.facebook.com' && event.origin !== 'https://web.facebook.com') return
    let payload = event.data
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload) } catch { return }
    }
    if (!payload || payload.type !== 'WA_EMBEDDED_SIGNUP') return
    if (payload.event === 'FINISH'
      && payload.data
      && typeof payload.data.waba_id === 'string'
      && typeof payload.data.phone_number_id === 'string') {
      assets = payload.data
      void maybeComplete()
    } else if (payload.event === 'CANCEL' || payload.event === 'ERROR') {
      fail('Meta 关联流程未完成。请返回 im-hub 后重试。')
    }
  })

  window.fbAsyncInit = () => {
    window.FB.init({ appId: config.appId, cookie: false, xfbml: false, version: config.graphApiVersion })
    status.textContent = '此页面由 Meta 官方 Embedded Signup 完成授权；im-hub 页面不会看到 access token。'
    start.disabled = false
  }
  start.addEventListener('click', () => {
    if (!ticket || !window.FB) return fail('关联票据无效，请返回 im-hub 重新发起。')
    start.disabled = true
    window.FB.login(response => {
      const received = response && response.authResponse && response.authResponse.code
      if (typeof received !== 'string' || received === '') return fail('Meta 未返回授权码，请重试。')
      code = received
      void maybeComplete()
    }, {
      config_id: config.configId,
      response_type: 'code',
      override_default_response_type: true,
      extras: { sessionInfoVersion: '3' },
    })
  })

  if (!ticket) return fail('关联票据缺失，请返回 im-hub 重新发起。')
  const sdk = document.createElement('script')
  sdk.src = 'https://connect.facebook.net/en_US/sdk.js'
  sdk.async = true
  sdk.defer = true
  sdk.crossOrigin = 'anonymous'
  sdk.onerror = () => fail('无法加载 Meta 官方关联组件，请检查网络后重试。')
  document.head.appendChild(sdk)
})()
</script></body></html>`
}
