import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Páginas dos spikes (medições F0) só entram no build quando pedidas (CIALIGHT_SPIKE no build); o instalador
// não leva o código delas (o WASM do signalsmith do editor vem do módulo vendorizado, não do pacote npm).
// `npm run spike*` usa o dev server, que serve tudo.
const spikePages: Record<string, string> = process.env.CIALIGHT_SPIKE
  ? { spike: resolve('src/renderer/spike.html'), 'editor-spike': resolve('src/renderer/editor-spike.html') }
  : {}

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], resolve: { alias: { '@shared': resolve('src/shared') } } },
  preload: { plugins: [externalizeDepsPlugin()], resolve: { alias: { '@shared': resolve('src/shared') } } },
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
          ...spikePages
        }
      }
    }
  }
})
