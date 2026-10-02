import { describe, expect, it } from 'vitest'
import { blurRadiusPx, downsampleFactor, featherPx, gaussianWeights, pixelBlockPx, regionScissor } from './effectsMath'

describe('blurRadiusPx', () => {
  it('0–100 → 0…4 % da altura de saída; 60 em 1080p ≈ 26 px', () => {
    expect(blurRadiusPx(0, 1080)).toBe(0)
    expect(blurRadiusPx(100, 1080)).toBeCloseTo(43.2, 5)
    expect(Math.round(blurRadiusPx(60, 1080))).toBe(26)
  })
  it('escala com a altura (mesma aparência em qualquer resolução)', () => {
    expect(blurRadiusPx(60, 720) / 720).toBeCloseTo(blurRadiusPx(60, 1080) / 1080, 10)
    expect(blurRadiusPx(60, 2160)).toBeCloseTo(2 * blurRadiusPx(60, 1080), 10)
  })
  it('intensidade fora da faixa é limitada', () => {
    expect(blurRadiusPx(-5, 1080)).toBe(0)
    expect(blurRadiusPx(250, 1080)).toBeCloseTo(43.2, 5)
  })
})

describe('pixelBlockPx', () => {
  it('0–100 → 2…altura/12', () => {
    expect(pixelBlockPx(0, 1080)).toBe(2)
    expect(pixelBlockPx(100, 1080)).toBe(90)
    expect(pixelBlockPx(50, 1080)).toBeCloseTo(46, 5)
  })
  it('escala com a altura e nunca fica abaixo de 2 px', () => {
    expect(pixelBlockPx(100, 720)).toBe(60)
    expect(pixelBlockPx(0, 12)).toBe(2)
    expect(pixelBlockPx(100, 12)).toBe(2)
  })
})

describe('downsampleFactor', () => {
  it('≥ 2 sempre; 4 acima de 24 px; 8 acima de 64 px', () => {
    expect(downsampleFactor(0)).toBe(2)
    expect(downsampleFactor(24)).toBe(2)
    expect(downsampleFactor(24.1)).toBe(4)
    expect(downsampleFactor(64)).toBe(4)
    expect(downsampleFactor(64.1)).toBe(8)
    expect(downsampleFactor(500)).toBe(8)
  })
})

describe('featherPx', () => {
  it('feather × min(w, h)/2 em pixels do quadro', () => {
    expect(featherPx({ w: 0.5, h: 0.5 }, 0.2, 1920, 1080)).toBeCloseTo(0.2 * (0.5 * 1080) / 2, 10)
    expect(featherPx({ w: 0.1, h: 0.5 }, 1, 1920, 1080)).toBeCloseTo(96, 10)
    expect(featherPx({ w: 0.1, h: 0.5 }, 0, 1920, 1080)).toBe(0)
  })
})

describe('gaussianWeights', () => {
  it('σ = raio/2, simétrico pela metade (w[0] = centro) e normalizado', () => {
    const w = gaussianWeights(6)
    expect(w.length).toBe(10) // suporte de 3σ = 9 → 0..9
    const sum = w[0] + 2 * w.slice(1).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1, 6)
    for (let i = 1; i < w.length; i++) expect(w[i]).toBeLessThan(w[i - 1])
    expect(w[2] / w[0]).toBeCloseTo(Math.exp(-4 / (2 * 9)), 6)
  })
  it('limita o número de amostras', () => {
    expect(gaussianWeights(1000, 32).length).toBe(33)
  })
})

describe('regionScissor', () => {
  const W = 1920
  const H = 1080
  /** Cantos da região rotacionada (horária na tela, y para baixo), em px do quadro. */
  function corners(r: { x: number; y: number; w: number; h: number; rotation: number }): [number, number][] {
    const th = (r.rotation * Math.PI) / 180
    const c = Math.cos(th)
    const s = Math.sin(th)
    const hw = (r.w * W) / 2
    const hh = (r.h * H) / 2
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([lx, ly]) => [r.x * W + c * lx - s * ly, r.y * H + s * lx + c * ly])
  }

  it('sem rotação nem feather: retângulo exato, com y para cima do GL', () => {
    // região 0,2..0,6 × 0,1..0,4 (y para baixo) → em GL y = H − 0,4H .. H − 0,1H
    expect(regionScissor({ x: 0.4, y: 0.25, w: 0.4, h: 0.3, rotation: 0 }, 0, W, H)).toEqual({ x: 384, y: 648, w: 768, h: 324 })
  })

  it('rotação de 45° contém os 4 cantos', () => {
    const r = { x: 0.5, y: 0.5, w: 0.3, h: 0.2, rotation: 45 }
    const s = regionScissor(r, 0, W, H)
    for (const [px, py] of corners(r)) {
      const glY = H - py
      expect(px).toBeGreaterThanOrEqual(s.x)
      expect(px).toBeLessThanOrEqual(s.x + s.w)
      expect(glY).toBeGreaterThanOrEqual(s.y)
      expect(glY).toBeLessThanOrEqual(s.y + s.h)
    }
    // e não é muito maior que a caixa dos cantos (justa, a menos do arredondamento)
    const xs = corners(r).map((p) => p[0])
    expect(s.w).toBeLessThanOrEqual(Math.max(...xs) - Math.min(...xs) + 2)
  })

  it('feather amplia a caixa por feather × min(w, h)/2 de cada lado', () => {
    const a = regionScissor({ x: 0.5, y: 0.5, w: 0.2, h: 0.2, rotation: 0 }, 0, W, H)
    const b = regionScissor({ x: 0.5, y: 0.5, w: 0.2, h: 0.2, rotation: 0 }, 0.5, W, H)
    const f = featherPx({ w: 0.2, h: 0.2 }, 0.5, W, H)
    expect(b.x).toBe(Math.floor(a.x - f))
    expect(b.w).toBeGreaterThanOrEqual(a.w + 2 * f)
  })

  it('clampa nas bordas do quadro', () => {
    const s = regionScissor({ x: 0.95, y: 0.02, w: 0.3, h: 0.3, rotation: 0 }, 0, W, H)
    expect(s.x + s.w).toBe(W)
    expect(s.y + s.h).toBe(H)
    expect(s.x).toBe(Math.floor(0.8 * W))
    expect(s.y).toBe(Math.floor(H - (0.02 + 0.15) * H))
  })

  it('região inteira fora do quadro → caixa vazia', () => {
    const s = regionScissor({ x: 1.5, y: 0.5, w: 0.2, h: 0.2, rotation: 0 }, 0, W, H)
    expect(s.w === 0 || s.h === 0).toBe(true)
  })
})
