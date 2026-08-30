import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
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
    build: {
      rollupOptions: {
        input: {
          index: 'src/preload/index.ts',
          'native-bridge': 'src/preload/native-bridge.ts',
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: { rollupOptions: { input: 'src/renderer/index.html' } },
    plugins: [react()],
  },
})
