import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { frameCountFor, frameStreamArgs } from './frameSource'

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

describe('frameStreamArgs (ruling R23: a faixa de vídeo do asset)', () => {
  const base = { file: 'C:\v\rec.mp4', fromUs: 1_000_000, toUs: 3_000_000, fps: 2, scale: 'scale=8:8', inclusiveEnd: false }
  const mapOf = (a: string[]): string => a[a.indexOf('-map') + 1]
  it('padrão 0:v:0; videoStreamIndex vira 0:v:N', () => {
    expect(mapOf(frameStreamArgs(base))).toBe('0:v:0')
    expect(mapOf(frameStreamArgs({ ...base, stream: 1 }))).toBe('0:v:1')
    expect(mapOf(frameStreamArgs({ ...base, stream: 3 }))).toBe('0:v:3')
  })
  it('índice inválido cai no 0 (o main já recusa antes)', () => {
    expect(mapOf(frameStreamArgs({ ...base, stream: -1 }))).toBe('0:v:0')
    expect(mapOf(frameStreamArgs({ ...base, stream: 1.5 }))).toBe('0:v:0')
  })
  it('trecho, filtro e saída crua em cinza', () => {
    const a = frameStreamArgs({ ...base, stream: 1 })
    expect(a.slice(a.indexOf('-ss'), a.indexOf('-ss') + 2)).toEqual(['-ss', '1.000000'])
    expect(a[a.indexOf('-t') + 1]).toBe('2.000000')
    expect(a[a.indexOf('-vf') + 1]).toBe('fps=2:round=up,scale=8:8,format=gray')
    expect(a.slice(-5)).toEqual(['-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
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
