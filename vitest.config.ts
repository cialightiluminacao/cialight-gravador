import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // OCR real (Windows.Media.Ocr + ffmpeg, minutos): só em `npm run test:sensitive` (vitest.ocr.config.ts)
    exclude: ['**/node_modules/**', 'src/**/*.ocr.test.ts'],
    environment: 'node',
    coverage: {
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/test/**', 'src/**/__fixtures__/**', 'src/**/*.d.ts'],
      reportOnFailure: true
    },
    setupFiles: ['src/test/setup.ts']
  }
})
