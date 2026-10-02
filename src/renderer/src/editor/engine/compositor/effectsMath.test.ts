import { describe, expect, it } from 'vitest'
import { blurRadiusPx, downsampleFactor, effectBlurRadiusPx, effectPixelBlockPx, featherPx, gaussianWeights, pixelBlockPx, pixelCellQ, REGION_BLUR_K, regionDistPx, regionScissor, layerBlurRect } from './effectsMath'

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

describe('effectBlurRadiusPx (raio também proporcional à região)', () => {
  // faixa de texto: 0,4 × 0,094 do quadro 1080p → menor lado 101,5 px
  const text = { w: 0.4, h: 0.094 }
  it('max(raio pela altura, 1,25 × menor lado da região × intensidade)', () => {
    // k = 1,25 medido no E2E F2: texto de 47 px a 60 → contraste local 0,08 da fonte (0,5 deixava 0,34, legível)
    expect(REGION_BLUR_K).toBe(1.25)
    expect(effectBlurRadiusPx(80, text, 1920, 1080)).toBeCloseTo(Math.max(blurRadiusPx(80, 1080), 1.25 * 101.52 * 0.8), 5)
    expect(effectBlurRadiusPx(80, text, 1920, 1080)).toBeCloseTo(101.52, 3)
    // região muito estreita: vale o raio pela altura (nunca menor que antes)
    expect(effectBlurRadiusPx(60, { w: 0.4, h: 0.02 }, 1920, 1080)).toBeCloseTo(blurRadiusPx(60, 1080), 10)
    expect(effectBlurRadiusPx(0, text, 1920, 1080)).toBe(0)
  })
  it('mesma aparência em qualquer resolução (escala com a saída)', () => {
    expect(effectBlurRadiusPx(80, text, 1280, 720) / 720).toBeCloseTo(effectBlurRadiusPx(80, text, 1920, 1080) / 1080, 10)
  })
  it('lado da região limitado ao quadro; inverter usa o menor lado do QUADRO (a área escondida é o quadro fora da região)', () => {
    expect(effectBlurRadiusPx(100, { w: 4, h: 4 }, 1920, 1080)).toBeCloseTo(1.25 * 1080, 5)
    // invertido: o tamanho da região (a parte nítida) não importa
    expect(effectBlurRadiusPx(80, { w: 0.5, h: 0.5 }, 1920, 1080, true)).toBeCloseTo(1.25 * 1080 * 0.8, 5)
    expect(effectBlurRadiusPx(80, { w: 0.05, h: 0.05 }, 1920, 1080, true)).toBeCloseTo(1.25 * 1080 * 0.8, 5)
    expect(effectBlurRadiusPx(80, { w: 0.5, h: 0.5 }, 1280, 720, true) / 720).toBeCloseTo(effectBlurRadiusPx(80, { w: 0.5, h: 0.5 }, 1920, 1080, true) / 1080, 10)
    // a 50 (piso do aviso) o invertido é ≥ ao blur normal de qualquer região a 50
    expect(effectBlurRadiusPx(50, { w: 0.2, h: 0.2 }, 1920, 1080, true)).toBeGreaterThanOrEqual(effectBlurRadiusPx(50, { w: 1, h: 1 }, 1920, 1080))
    expect(effectBlurRadiusPx(60, { w: -0.4, h: -0.3 }, 1920, 1080)).toBeCloseTo(1.25 * 324 * 0.6, 5)
  })
})

describe('effectPixelBlockPx (bloco também proporcional à região)', () => {
  it('max(bloco pela altura, 0,35 × menor lado da região × intensidade)', () => {
    expect(effectPixelBlockPx(50, { w: 0.3, h: 0.3 }, 1920, 1080)).toBeCloseTo(Math.max(pixelBlockPx(50, 1080), 0.35 * 324 * 0.5), 5)
    expect(effectPixelBlockPx(50, { w: 0.2, h: 0.1 }, 1920, 1080)).toBeCloseTo(pixelBlockPx(50, 1080), 10)
    expect(effectPixelBlockPx(0, { w: 1, h: 1 }, 1920, 1080)).toBe(2)
    expect(effectPixelBlockPx(100, { w: 0.2, h: 0.2 }, 1920, 1080, true)).toBeCloseTo(0.35 * 1080, 5)
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

  it('retângulo rotacionado com feather: todo ponto com máscara > 0 (dist < feather) está na caixa', () => {
    const r = { x: 0.4, y: 0.55, w: 0.25, h: 0.12, rotation: 30, shape: 'rect' as const }
    expectMaskInside(r, 0.4)
  })

  it('elipse rotacionada e excêntrica com feather: a cauda do feather inteira cabe na caixa', () => {
    expectMaskInside({ x: 0.5, y: 0.5, w: 0.5, h: 0.05, rotation: 25, shape: 'ellipse' as const }, 0.8)
    expectMaskInside({ x: 0.3, y: 0.6, w: 0.1, h: 0.4, rotation: -60, shape: 'ellipse' as const }, 0.3)
  })

  it('elipse sem feather: caixa justa da elipse (menor que a do retângulo)', () => {
    const e = regionScissor({ x: 0.5, y: 0.5, w: 0.3, h: 0.3, rotation: 30, shape: 'ellipse' }, 0, W, H)
    const r = regionScissor({ x: 0.5, y: 0.5, w: 0.3, h: 0.3, rotation: 30, shape: 'rect' }, 0, W, H)
    expect(e.w).toBeLessThan(r.w)
    expect(e.h).toBeLessThan(r.h)
    expectMaskInside({ x: 0.5, y: 0.5, w: 0.3, h: 0.3, rotation: 30, shape: 'ellipse' as const }, 0)
  })

  /** Varre o quadro: onde a máscara do shader é > 0 (dist < feather, ou ≤ 0 sem feather) tem de estar na caixa. */
  function expectMaskInside(r: { x: number; y: number; w: number; h: number; rotation: number; shape: 'rect' | 'ellipse' }, feather: number): void {
    const s = regionScissor(r, feather, W, H)
    const f = featherPx(r, feather, W, H)
    let outside = 0
    let inside = 0
    for (let py = 0.5; py < H; py += 3) {
      for (let px = 0.5; px < W; px += 3) {
        const d = regionDistPx(r, px, py, W, H)
        if (!(f > 0 ? d < f : d <= 0)) continue
        inside++
        const glY = H - py
        if (px < s.x || px > s.x + s.w || glY < s.y || glY > s.y + s.h) outside++
      }
    }
    expect(inside).toBeGreaterThan(100)
    expect(outside).toBe(0)
  }
})

describe('regionDistPx', () => {
  it('retângulo: distância com sinal exata (rotação horária, y para baixo)', () => {
    const r = { x: 0.5, y: 0.5, w: 0.1, h: 0.1, rotation: 0, shape: 'rect' as const }
    expect(regionDistPx(r, 960, 540, 1920, 1080)).toBeCloseTo(-54, 6)
    expect(regionDistPx(r, 960 + 96 + 10, 540, 1920, 1080)).toBeCloseTo(10, 6)
  })
  it('elipse: exata nos eixos e nunca menor que a cota (f − 1)·min(a, b)', () => {
    const r = { x: 0.5, y: 0.5, w: 0.2, h: 0.1, rotation: 0, shape: 'ellipse' as const }
    expect(regionDistPx(r, 960 + 192 + 20, 540, 1920, 1080)).toBeCloseTo(20, 6)
    expect(regionDistPx(r, 960, 540 - 54 - 7, 1920, 1080)).toBeCloseTo(7, 6)
    expect(regionDistPx(r, 960, 540, 1920, 1080)).toBeLessThan(0)
  })
})

describe('pixelCellQ (bloco da pixelização em 1/256 px)', () => {
  it('arredonda para 1/256 px, nunca abaixo de 2 px; q/256 é exato e a conta inteira do shader bate com floor((i + ½)/célula)', () => {
    expect(pixelCellQ(56.7)).toBe(14515)
    expect(pixelCellQ(1)).toBe(512)
    const q = pixelCellQ(56.7)
    for (let i = 0; i < 1920; i++) expect(Math.floor(((2 * i + 1) * 128) / q)).toBe(Math.floor((i + 0.5) / (q / 256)))
  })
})

describe('layerBlurRect', () => {
  it('caixa dos cantos + 1,5 × raio + 2 células da redução, presa ao quadro', () => {
    // raio 10 → redução 2×: folga 15 + 4 = 19
    expect(layerBlurRect([[100, 200], [300, 200], [300, 260], [100, 260]], 10, 1920, 1080)).toEqual({ x: 81, y: 181, w: 238, h: 98 })
    // perto da borda e fora do quadro: presa
    expect(layerBlurRect([[-50, -50], [40, 30]], 30, 1920, 1080)).toEqual({ x: 0, y: 0, w: 40 + 45 + 8, h: 30 + 45 + 8 })
    expect(layerBlurRect([[3000, 3000], [3100, 3100]], 10, 1920, 1080)).toMatchObject({ w: 0, h: 0 })
  })
})
