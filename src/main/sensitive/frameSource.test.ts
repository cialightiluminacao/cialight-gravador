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
    expect(a).not.toContain('-t')
    expect(a[a.indexOf('-frames:v') + 1]).toBe('4')
    expect(a.slice(-5)).toEqual(['-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
  })
  it('grade ancorada em fromUs, em tempo absoluto do arquivo (achado #1 da revisão final)', () => {
    const a = frameStreamArgs({ ...base, fromUs: 1_050_000 })
    // tempos absolutos (mediabunny): sem o start_time do arquivo; -ss só posiciona (não descarta o quadro na tela)
    expect(a.slice(0, a.indexOf('-i'))).toEqual(expect.arrayContaining(['-copyts', '-seek_timestamp', '1', '-noaccurate_seek']))
    expect(a.indexOf('-copyts')).toBeLessThan(a.indexOf('-i'))
    expect(a[a.indexOf('-vf') + 1]).toBe('setpts=PTS-1.050000/TB,fps=fps=2:round=up:start_time=0,scale=8:8,format=gray')
    expect(a[a.indexOf('-fps_mode') + 1]).toBe('passthrough')
    // sub-quadros: [from, to] inclusivo
    const b = frameStreamArgs({ ...base, fromUs: 1_500_000, toUs: 2_000_000, fps: 10, inclusiveEnd: true })
    expect(b[b.indexOf('-frames:v') + 1]).toBe('6')
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
