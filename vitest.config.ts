import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
  test: { include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], environment: 'node', setupFiles: ['src/test/setup.ts'] }
})
