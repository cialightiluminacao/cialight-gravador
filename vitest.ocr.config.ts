import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Testes pesados da varredura de dados sensíveis (G3): ffmpeg + Windows.Media.Ocr reais sobre vídeos sintéticos em
// test-out/g3-scan/. Node puro (sem Electron: o setup simula o módulo `electron`), fora do `npm test`.
export default defineConfig({
  resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
  test: {
    include: ['src/**/*.ocr.test.ts'],
    environment: 'node',
    setupFiles: ['src/test/setup.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // um arquivo por vez: as medidas de vazão não disputam CPU com outro OCR
    fileParallelism: false
  }
})
