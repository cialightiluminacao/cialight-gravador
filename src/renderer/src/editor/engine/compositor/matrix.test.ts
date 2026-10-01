import { describe, expect, it } from 'vitest'
import { applyMat3, layerMatrix } from './matrix'

const noCrop = { l: 0, t: 0, r: 0, b: 0 }
const rect = (o: Partial<{ cx: number; cy: number; scale: number; rotation: number }> = {}): { cx: number; cy: number; scale: number; rotation: number } => ({ cx: 0.5, cy: 0.5, scale: 1, rotation: 0, ...o })

/** Caixa (clip space) ocupada pela camada: cantos do quad local [0,1]². */
function box(mat: Float32Array): { x0: number; x1: number; y0: number; y1: number } {
  const pts = [applyMat3(mat, 0, 0), applyMat3(mat, 1, 0), applyMat3(mat, 0, 1), applyMat3(mat, 1, 1)]
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
}

describe('layerMatrix', () => {
  const portrait = { w: 1080, h: 1920 }
  const src = { w: 1920, h: 1080, rotation: 0 as const }

  it('contain: 1920×1080 num canvas 1080×1920 ocupa 100 % da largura e (1080/1920)² da altura', () => {
    const { mat, uv } = layerMatrix({ rect: rect(), fit: 'contain', crop: noCrop }, src, portrait)
    const b = box(mat)
    expect(b.x1 - b.x0).toBeCloseTo(2, 5) // largura cheia em clip space (−1..1)
    expect((b.y1 - b.y0) / 2).toBeCloseTo((1080 / 1920) * (1080 / 1920), 5)
    expect((b.y0 + b.y1) / 2).toBeCloseTo(0, 5) // centralizado
    expect(uv).toEqual([0, 0, 1, 1])
  })

  it('cover: cobre o canvas inteiro (excede numa das dimensões)', () => {
    const b = box(layerMatrix({ rect: rect(), fit: 'cover', crop: noCrop }, src, portrait).mat)
    expect(b.y1 - b.y0).toBeCloseTo(2, 5)
    expect(b.x1 - b.x0).toBeGreaterThan(2)
    expect((b.x1 - b.x0) / 2).toBeCloseTo(1920 / 1080 / (1080 / 1920), 4)
  })

  it('fill: ocupa exatamente o canvas', () => {
    const b = box(layerMatrix({ rect: rect(), fit: 'fill', crop: noCrop }, src, portrait).mat)
    expect([b.x0, b.x1, b.y0, b.y1].map((v) => +v.toFixed(5))).toEqual([-1, 1, -1, 1])
  })

  it('rotação 90 da fonte troca w/h (1920×1080 girado vira em pé e preenche o canvas em pé)', () => {
    const b = box(layerMatrix({ rect: rect(), fit: 'contain', crop: noCrop }, { ...src, rotation: 90 }, portrait).mat)
    expect(b.x1 - b.x0).toBeCloseTo(2, 5)
    expect(b.y1 - b.y0).toBeCloseTo(2, 5)
  })

  it('crop l=0.25 desloca uv para 0.25 e estreita a fonte', () => {
    const { mat, uv } = layerMatrix({ rect: rect(), fit: 'contain', crop: { l: 0.25, t: 0, r: 0, b: 0 } }, src, { w: 1920, h: 1080 })
    expect(uv).toEqual([0.25, 0, 1, 1])
    const b = box(mat)
    // fonte cortada 1440×1080 → altura cheia, largura 1440/1920 do canvas
    expect(b.y1 - b.y0).toBeCloseTo(2, 5)
    expect((b.x1 - b.x0) / 2).toBeCloseTo(0.75, 5)
  })

  it('scale e centro normalizado (y para baixo no modelo, para cima no clip space)', () => {
    const b = box(layerMatrix({ rect: rect({ cx: 0.875, cy: 0.125, scale: 0.25 }), fit: 'contain', crop: noCrop }, { w: 256, h: 256, rotation: 0 }, { w: 1920, h: 1080 }).mat)
    // base = 1080×1080 px (contain), ×0.25 = 270 px; centro (1680, 135) px
    expect((b.x0 + b.x1) / 2).toBeCloseTo((1680 / 1920) * 2 - 1, 5)
    expect((b.y0 + b.y1) / 2).toBeCloseTo(1 - (135 / 1080) * 2, 5)
    expect(((b.x1 - b.x0) / 2) * 1920).toBeCloseTo(270, 3)
    expect(((b.y1 - b.y0) / 2) * 1080).toBeCloseTo(270, 3)
  })

  it('rotação da camada em graus (horário na tela) em torno do centro, em pixels', () => {
    // camada 1920×1080 num canvas 1920×1080 girada 90°: canto superior esquerdo do quad vai para o canto superior direito
    const { mat } = layerMatrix({ rect: rect({ rotation: 90 }), fit: 'fill', crop: noCrop }, src, { w: 1920, h: 1080 })
    const [x, y] = applyMat3(mat, 0, 0)
    // pixel: centro (960,540) + R90·(−960,−540) = (960+540, 540−960) = (1500, −420)
    expect(x).toBeCloseTo((1500 / 1920) * 2 - 1, 5)
    expect(y).toBeCloseTo(1 - (-420 / 1080) * 2, 5)
  })
})
