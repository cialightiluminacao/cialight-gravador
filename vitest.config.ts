import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // OCR real (Windows.Media.Ocr + ffmpeg, minutos): só em `npm run test:sensitive` (vitest.ocr.config.ts)
    exclude: ['**/node_modules/**', 'src/**/*.ocr.test.ts'],
    environment: 'node',
    setupFiles: ['src/test/setup.ts']
  }
})
