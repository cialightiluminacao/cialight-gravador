import { describe, expect, it } from 'vitest'
import { SAMPLE_GRID, TRANSITION_KINDS, boundaryDist, meanDiffPerChannel, paritySample, transitionPixel, type Rgb } from './transitionOracle'

const A: Rgb = [250, 2, 1]
const B: Rgb = [1, 3, 252]

describe('modelo das transições', () => {
  it('p = 0 é A e p = 1 é B em todo ponto, para todo tipo', () => {
    for (const k of TRANSITION_KINDS) {
      for (const [u, v] of SAMPLE_GRID) {
        expect(transitionPixel(k, 0, u, v, A, B), `${k} p=0 (${u},${v})`).toEqual(A)
        const b = transitionPixel(k, 1, u, v, A, B)
        b.forEach((c, i) => expect(c, `${k} p=1`).toBeCloseTo(B[i], 9))
      }
    }
  })

  it('valores do brief: crossfade no meio, mergulho no corte, deslizar e cortina no meio', () => {
    expect(transitionPixel('crossfade', 0.5, 0.5, 0.5, [255, 0, 0], [0, 0, 255])).toEqual([127.5, 0, 127.5])
    expect(transitionPixel('dipBlack', 0.5, 0.5, 0.5, A, B)).toEqual([0, 0, 0])
    expect(transitionPixel('dipWhite', 0.5, 0.5, 0.5, A, B)).toEqual([255, 255, 255])
    expect(transitionPixel('dipBlack', 0.25, 0.5, 0.5, A, B)).toEqual([125, 1, 0.5])
    for (const k of ['slideL', 'wipeL'] as const) {
      expect(transitionPixel(k, 0.5, 0.25, 0.5, A, B)).toEqual(A)
      expect(transitionPixel(k, 0.5, 0.75, 0.5, A, B)).toEqual(B)
    }
    expect(transitionPixel('slideR', 0.5, 0.25, 0.5, A, B)).toEqual(B)
    expect(transitionPixel('slideU', 0.25, 0.5, 0.9, A, B)).toEqual(B) // B entra por baixo
    expect(transitionPixel('slideD', 0.25, 0.5, 0.1, A, B)).toEqual(B) // B entra por cima
  })

  it('zoom: canto fora da caixa de B = A·(1 − p) sobre preto; centro = mistura', () => {
    expect(transitionPixel('zoomIn', 0.2, 0.01, 0.01, A, B)).toEqual([200, 1.6, 0.8])
    const c = transitionPixel('zoomIn', 0.2, 0.5, 0.5, A, B)
    c.forEach((x, i) => expect(x).toBeCloseTo(A[i] * 0.8 + B[i] * 0.2, 9))
  })

  it('distância à borda: deslizar/cortina pela coluna da borda; mistura sem borda', () => {
    expect(boundaryDist('slideL', 0.5, 0.25, 0.5)).toBeCloseTo(0.25, 9)
    expect(boundaryDist('wipeR', 0.3, 0.3, 0.5)).toBe(0)
    expect(boundaryDist('crossfade', 0.5, 0.5, 0.5)).toBe(Infinity)
  })

  it('amostra de paridade e diferença média por canal', () => {
    const w = 8, h = 8
    const rgba = new Uint8Array(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : i % 251))
    const rgb = new Uint8Array(w * h * 3)
    for (let k = 0; k < w * h; k++) for (let c = 0; c < 3; c++) rgb[k * 3 + c] = rgba[k * 4 + c]
    const a = paritySample(rgba, w, h, 4)
    expect(a).toEqual(paritySample(rgb, w, h, 3))
    expect(a.length).toBe(2 * 2 * 3)
    expect(meanDiffPerChannel(a, a)).toEqual([0, 0, 0])
    expect(meanDiffPerChannel([10, 0, 0, 0, 0, 4], [0, 0, 0, 0, 0, 0])).toEqual([5, 0, 2])
  })
})
