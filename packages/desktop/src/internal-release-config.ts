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

interface RendererTransportInput {
  channel: DesktopReleaseChannel
  compiledServerUrl: string | null
  compiledWsUrl: string | null
  injectedServerUrl: string | undefined
  injectedWsUrl: string | undefined
  developmentServerUrl: string | null
  developmentWsUrl: string | null
}

interface RendererTransportOrigins {
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

/**
 * internal renderer 同时核对编译常量和 preload 注入值。任一缺失或不一致都
 * 返回不可联网状态，绝不能退回开发服务。开发 URL 由调用方显式传入，以便
 * Vite 在生产构建中完整消除 localhost 字符串。
 */
export function resolveRendererTransportOrigins(
  input: RendererTransportInput,
): RendererTransportOrigins {
  if (input.channel === 'internal-unsigned') {
    const matchesCompiledOrigins = input.compiledServerUrl !== null
      && input.compiledWsUrl !== null
      && input.injectedServerUrl === input.compiledServerUrl
      && input.injectedWsUrl === input.compiledWsUrl
    return matchesCompiledOrigins
      ? { serverUrl: input.compiledServerUrl, wsUrl: input.compiledWsUrl }
      : { serverUrl: null, wsUrl: null }
  }

  return {
    serverUrl: input.injectedServerUrl ?? input.developmentServerUrl,
    wsUrl: input.injectedWsUrl ?? input.developmentWsUrl,
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
