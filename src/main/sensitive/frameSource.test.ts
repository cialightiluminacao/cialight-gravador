import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { frameCountFor } from './frameSource'

describe('frameCountFor', () => {
  it('amostragem [from, to): grade a partir de fromUs, sem o instante final', () => {
    expect(frameCountFor(0, 8_000_000, 2, false)).toBe(16)
    expect(frameCountFor(0, 8_200_000, 2, false)).toBe(17)
    expect(frameCountFor(1_000_000, 1_000_001, 2, false)).toBe(1)
    expect(frameCountFor(5, 5, 2, false)).toBe(0)
  })
  it('sub-quadros [from, to]: inclui o instante final quando cai na grade', () => {
    expect(frameCountFor(1_500_000, 2_000_000, 10, true)).toBe(6)
    expect(frameCountFor(1_500_000, 2_050_000, 10, true)).toBe(6)
    expect(frameCountFor(0, 0, 10, true)).toBe(1)
  })
})

describe('privacidade: os módulos da varredura não gravam arquivos', () => {
  it('src/main/sensitive/*.ts não usa writeFile/createWriteStream/appendFile', () => {
    const dir = __dirname
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    expect(files.length).toBeGreaterThanOrEqual(4)
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8')
      expect(src, f).not.toMatch(/writeFile|createWriteStream|appendFile|mkdtemp|copyFile/)
    }
  })
})
