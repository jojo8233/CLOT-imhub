export type DesktopReleaseChannel = 'development' | 'internal-unsigned'

interface InternalReleaseEnvironment {
  IM_HUB_INTERNAL_RELEASE?: string
  IM_HUB_SERVER_URL?: string
}

interface InternalReleaseBuild {
  channel: DesktopReleaseChannel
  serverUrl: string | null
  wsUrl: string | null
}

const INVALID_INTERNAL_SERVER_URL =
  'IM_HUB_SERVER_URL must be an exact HTTPS origin for internal builds'

export function resolveInternalReleaseBuild(
  environment: InternalReleaseEnvironment,
): InternalReleaseBuild {
  if (environment.IM_HUB_INTERNAL_RELEASE !== '1') {
    return {
      channel: 'development',
      serverUrl: null,
      wsUrl: null,
    }
  }

  const rawServerUrl = environment.IM_HUB_SERVER_URL
  if (!rawServerUrl) throw new Error(INVALID_INTERNAL_SERVER_URL)

  try {
    const serverUrl = new URL(rawServerUrl)
    const isExactOrigin = rawServerUrl === serverUrl.origin
      || rawServerUrl === `${serverUrl.origin}/`
    if (
      serverUrl.protocol !== 'https:'
      || serverUrl.username !== ''
      || serverUrl.password !== ''
      || !isExactOrigin
    ) {
      throw new Error(INVALID_INTERNAL_SERVER_URL)
    }

    const wsUrl = new URL(serverUrl.origin)
    wsUrl.protocol = 'wss:'
    return {
      channel: 'internal-unsigned',
      serverUrl: serverUrl.origin,
      wsUrl: wsUrl.origin,
    }
  } catch {
    throw new Error(INVALID_INTERNAL_SERVER_URL)
  }
}

export function desktopServerUrl(
  compiledServerUrl: string | null,
  runtimeServerUrl: string | undefined,
): string {
  return compiledServerUrl ?? runtimeServerUrl ?? 'http://localhost:4000'
}

export function desktopWebSocketUrl(
  compiledWsUrl: string | null,
  serverUrl: string,
): string {
  if (compiledWsUrl) return compiledWsUrl

  const wsUrl = new URL(serverUrl)
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  return wsUrl.origin
}

export function compiledInternalServerUrl(): string | null {
  return typeof __IM_HUB_SERVER_URL__ === 'undefined'
    ? null
    : __IM_HUB_SERVER_URL__
}

export function compiledInternalWsUrl(): string | null {
  return typeof __IM_HUB_WS_URL__ === 'undefined'
    ? null
    : __IM_HUB_WS_URL__
}

export function compiledReleaseChannel(): DesktopReleaseChannel {
  return typeof __IM_HUB_RELEASE_CHANNEL__ === 'undefined'
    ? 'development'
    : __IM_HUB_RELEASE_CHANNEL__
}
