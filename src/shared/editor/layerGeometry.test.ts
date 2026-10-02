import { describe, expect, it } from 'vitest'
import { layerBase } from './layerGeometry'

describe('layerBase', () => {
  const canvas = { w: 1920, h: 1080 }
  it('corte reduz o trecho da fonte; contain encaixa o trecho cortado no quadro', () => {
    const g = layerBase({ l: 0.25, t: 0, r: 0.25, b: 0 }, 'contain', { w: 1920, h: 1080, rotation: 0 }, canvas)
    expect(g.uv).toEqual([0.25, 0, 0.75, 1])
    expect([g.cw, g.ch]).toEqual([960, 1080])
    expect([g.bw, g.bh]).toEqual([960, 1080])
  })
  it('cover, fill e fonte girada 90°', () => {
    expect(layerBase({ l: 0, t: 0, r: 0, b: 0 }, 'cover', { w: 1000, h: 1000, rotation: 0 }, canvas)).toMatchObject({ bw: 1920, bh: 1920 })
    expect(layerBase({ l: 0.5, t: 0, r: 0, b: 0 }, 'fill', { w: 1000, h: 1000, rotation: 0 }, canvas)).toMatchObject({ bw: 1920, bh: 1080, cw: 500 })
    expect(layerBase({ l: 0, t: 0, r: 0, b: 0 }, 'contain', { w: 1920, h: 1080, rotation: 90 }, canvas)).toMatchObject({ dw: 1080, dh: 1920, bh: 1080 })
  })
  it('corte além do possível fica preso (trecho mínimo, nunca negativo)', () => {
    const g = layerBase({ l: 0.8, t: -1, r: 0.5, b: 0 }, 'contain', { w: 100, h: 100, rotation: 0 }, canvas)
    expect(g.uv[0]).toBe(0.8)
    expect(g.uv[1]).toBe(0)
    expect(g.uv[2]).toBeGreaterThan(0.8)
  })
})
