export const DESKTOP_INSTALLATION_SYNC_CHANNEL = 'imhub:desktop-installation-sync'

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_ACCOUNT_IDS = 500

export function parseDesktopInstallationSyncPayload(value: unknown): { accountIds: string[] } {
  if (!record(value)
    || Object.keys(value).some(key => key !== 'accountIds')
    || !Array.isArray(value.accountIds)
    || value.accountIds.length > MAX_ACCOUNT_IDS
    || !value.accountIds.every(accountId => typeof accountId === 'string' && ACCOUNT_ID.test(accountId))) {
    throw new Error('桌面安装同步参数无效')
  }
  return { accountIds: [...new Set(value.accountIds)] }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
