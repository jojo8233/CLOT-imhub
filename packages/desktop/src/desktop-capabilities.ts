import type { DesktopReleaseChannel } from './internal-release-config.js'

export interface DesktopPlatformCapabilities {
  telegram: boolean
  signal: boolean
  whatsapp: boolean
}

export interface DesktopPlatformCapabilityInput {
  releaseChannel: DesktopReleaseChannel
  signalIntegrated: boolean
  telegramStatic: boolean
}

export function resolveDesktopPlatformCapabilities(
  input: DesktopPlatformCapabilityInput,
): DesktopPlatformCapabilities {
  return {
    telegram: input.releaseChannel === 'development' || input.telegramStatic,
    signal: input.signalIntegrated,
    whatsapp: true,
  }
}

export const DEVELOPMENT_PLATFORM_CAPABILITIES: DesktopPlatformCapabilities = {
  telegram: true,
  signal: true,
  whatsapp: true,
}

export const NO_PRELOAD_PLATFORM_CAPABILITIES: DesktopPlatformCapabilities = {
  telegram: false,
  signal: false,
  whatsapp: false,
}
