import { describe, expect, it } from 'vitest'
import { PRESETS } from './presets'
import { estimateLiveMB, estimateOutputMB, typicalVideoKbps } from './sizeEstimate'

const MIN = 60_000

describe('typicalVideoKbps', () => {
  it('small: 1400 kbps independentemente da fonte (sempre ≤ 720p30)', () => {
    expect(typicalVideoKbps(PRESETS.small, 1080, 60)).toBe(1400)
    expect(typicalVideoKbps(PRESETS.small, 720, 30)).toBe(1400)
  })
  it('high: 720p 5000 · 1080p30 9000 · 1080p60 12000 · 1440p 16000', () => {
    expect(typicalVideoKbps(PRESETS.high, 720, 30)).toBe(5000)
    expect(typicalVideoKbps(PRESETS.high, 1080, 30)).toBe(9000)
    expect(typicalVideoKbps(PRESETS.high, 1080, 60)).toBe(12000)
    expect(typicalVideoKbps(PRESETS.high, 1440, 30)).toBe(16000)
  })
  it('max: high × 1,6', () => {
    expect(typicalVideoKbps(PRESETS.max, 1080, 30)).toBe(14400)
    expect(typicalVideoKbps(PRESETS.max, 720, 30)).toBe(8000)
  })
  it('cutOnly/separate: bitrate medido, senão 5000', () => {
    expect(typicalVideoKbps(PRESETS.cutOnly, 1080, 30)).toBe(5000)
    expect(typicalVideoKbps(PRESETS.cutOnly, 1080, 30, 7300)).toBe(7300)
    expect(typicalVideoKbps(PRESETS.separate, 1080, 30, 7300)).toBe(7300)
  })
})

describe('estimateOutputMB', () => {
  it('small 10 min ≈ (1400+96) kbps × 600 s / 8192', () => {
    expect(estimateOutputMB(PRESETS.small, 10 * MIN, 1080, 30)).toBeCloseTo((1496 * 600) / 8192, 5)
  })
  it('high 1080p60 1 min ≈ (12000+192)×60/8192', () => {
    expect(estimateOutputMB(PRESETS.high, MIN, 1080, 60)).toBeCloseTo((12192 * 60) / 8192, 5)
  })
  it('cutOnly usa medido + 192k de áudio', () => {
    expect(estimateOutputMB(PRESETS.cutOnly, MIN, 1080, 30, 8000)).toBeCloseTo((8192 * 60) / 8192, 5)
  })
  it('separate: 2× vídeo (tela + combinado) + 2× WAV', () => {
    expect(estimateOutputMB(PRESETS.separate, MIN, 1080, 30, 8000)).toBeCloseTo(((2 * 8000 + 2 * 1536) * 60) / 8192, 5)
  })
  it('duração zero → 0', () => {
    expect(estimateOutputMB(PRESETS.high, 0, 1080, 30)).toBe(0)
  })
})

describe('estimateLiveMB', () => {
  it('converte bytes em MB e calcula kbps médio', () => {
    // 15 MB em 10 s → 15 × 8192 / 10 = 12 288 kbps
    const r = estimateLiveMB(15 * 1024 * 1024, 10_000)
    expect(r.mbSoFar).toBe(15)
    expect(r.kbps).toBe(12288)
    expect(r.mbProjected).toBeNull()
  })
  it('com totalMs projeta o tamanho final', () => {
    const r = estimateLiveMB(15 * 1024 * 1024, 10_000, 60_000)
    expect(r.mbProjected).toBe(90)
  })
  it('sem tempo decorrido → kbps 0', () => {
    expect(estimateLiveMB(1000, 0)).toEqual({ mbSoFar: 1000 / 1048576, kbps: 0, mbProjected: null })
  })
})
