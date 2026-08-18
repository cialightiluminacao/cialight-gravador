import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    root: 'src/renderer',
    resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          bar: resolve('src/renderer/bar.html'),
          overlay: resolve('src/renderer/overlay.html'),
          spike: resolve('src/renderer/spike.html')
        }
      }
    }
  }
})
