import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolveInternalReleaseBuild } from './src/internal-release-config.js'

const internalRelease = resolveInternalReleaseBuild(process.env)
const releaseConstants = {
  __IM_HUB_SERVER_URL__: JSON.stringify(internalRelease.serverUrl),
  __IM_HUB_WS_URL__: JSON.stringify(internalRelease.wsUrl),
  __IM_HUB_RELEASE_CHANNEL__: JSON.stringify(internalRelease.channel),
}

export default defineConfig({
  main: {
    define: releaseConstants,
    build: {
      rollupOptions: {
        input: {
          index: 'src/main/index.ts',
          'signal-integrated-host': 'src/main/signal-integrated-host.ts',
        },
      },
    },
  },
  preload: {
    define: releaseConstants,
    build: {
      rollupOptions: {
        input: {
          index: 'src/preload/index.ts',
          'native-bridge': 'src/preload/native-bridge.ts',
          'signal-bridge': 'src/preload/signal-bridge.ts',
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    define: releaseConstants,
    build: { rollupOptions: { input: 'src/renderer/index.html' } },
    plugins: [react()],
  },
})
