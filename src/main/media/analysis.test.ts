import { describe, expect, it } from 'vitest'
import { filmstripPlan, PeaksAccumulator } from './analysis'

describe('filmstripPlan', () => {
  it('1 quadro por segundo até 300 s', () => {
    expect(filmstripPlan(6_000_000)).toEqual({ everyUs: 1_000_000, frames: 6 })
    expect(filmstripPlan(6_500_000)).toEqual({ everyUs: 1_000_000, frames: 7 })
    expect(filmstripPlan(300_000_000)).toEqual({ everyUs: 1_000_000, frames: 300 })
  })
  it('acima de 300 s: dur/300 (no máximo 300 quadros)', () => {
    expect(filmstripPlan(3_600_000_000)).toEqual({ everyUs: 12_000_000, frames: 300 })
  })
  it('mídia curtíssima: pelo menos 1 quadro', () => {
    expect(filmstripPlan(100_000)).toEqual({ everyUs: 1_000_000, frames: 1 })
  })
})

describe('PeaksAccumulator', () => {
  it('min/max por janela de 80 amostras (10 ms a 8 kHz), ×127, intercalados', () => {
    const acc = new PeaksAccumulator(80)
    const s = new Float32Array(200)
    for (let i = 0; i < 80; i++) s[i] = i === 10 ? 1 : i === 20 ? -0.5 : 0
    for (let i = 80; i < 160; i++) s[i] = 0.25
    s[170] = -2 // fora de [-1, 1]: satura
    // entrega em pedaços desalinhados com a janela (bytes do pipe chegam fragmentados)
    acc.push(s.subarray(0, 50))
    acc.push(s.subarray(50, 130))
    acc.push(s.subarray(130))
    const out = acc.finish()
    expect(Array.from(out)).toEqual([-63, 127, 32, 32, -127, 0])
  })
  it('sem amostras → vazio', () => {
    expect(new PeaksAccumulator(80).finish().length).toBe(0)
  })
})
