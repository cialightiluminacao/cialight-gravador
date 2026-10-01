import { describe, expect, it } from 'vitest'
import { fitZoom, maxScrollUs, pxToUs, rulerLabel, rulerTicks, usToPx, zoomAround, ZOOM_MAX, ZOOM_MIN } from './zoom'

describe('usToPx / pxToUs', () => {
  it('ida e volta mantém o instante (±1 µs)', () => {
    for (const pps of [1, 7.5, 100, 333.3, 4000]) {
      for (const scroll of [0, 1_234_567, 98_765_432]) {
        for (const us of [0, 1, 33_333, 5_000_000, 123_456_789]) {
          expect(Math.abs(pxToUs(usToPx(us, pps, scroll), pps, scroll) - us)).toBeLessThanOrEqual(1)
        }
      }
    }
  })
  it('scroll é o instante na borda esquerda; pxToUs devolve µs inteiros', () => {
    expect(usToPx(2_000_000, 100, 1_000_000)).toBe(100)
    expect(pxToUs(0, 100, 1_000_000)).toBe(1_000_000)
    expect(Number.isInteger(pxToUs(13.37, 333.3, 7))).toBe(true)
  })
})

describe('zoomAround', () => {
  it('o instante âncora fica parado sob o mouse', () => {
    const anchorPx = 437
    const pps = 100, scroll = 60_000_000
    const anchorUs = pxToUs(anchorPx, pps, scroll)
    for (const factor of [1.25, 0.8, 3, 0.1]) {
      const z = zoomAround(pps, factor, anchorUs, scroll, anchorPx)
      expect(z.pxPerSec).toBeCloseTo(pps * factor)
      expect(Math.abs(usToPx(anchorUs, z.pxPerSec, z.scrollUs) - anchorPx)).toBeLessThan(0.5)
    }
  })
  it('limita o zoom e nunca rola antes de 0', () => {
    expect(zoomAround(100, 1e6, 0, 0, 0).pxPerSec).toBe(ZOOM_MAX)
    expect(zoomAround(100, 1e-6, 0, 0, 0).pxPerSec).toBe(ZOOM_MIN)
    expect(zoomAround(100, 0.5, 1_000_000, 0, 500).scrollUs).toBe(0)
  })
})

describe('fitZoom', () => {
  it('60 s em 1200 px ≈ 20 px/s (margem de 5 %)', () => {
    const z = fitZoom(60_000_000, 1200)
    expect(z).toBeLessThanOrEqual(20)
    expect(z).toBeGreaterThanOrEqual(19)
  })
  it('projeto vazio cai no padrão; respeita os limites', () => {
    expect(fitZoom(0, 1200)).toBe(100)
    expect(fitZoom(10_000, 1200)).toBe(ZOOM_MAX)
    expect(fitZoom(100 * 3_600_000_000, 1200)).toBe(ZOOM_MIN)
  })
})

describe('rulerTicks', () => {
  it('100 px/s @ 30 fps → major 1 s', () => {
    expect(rulerTicks(100, 30).majorUs).toBe(1_000_000)
  })
  it('major ≥ 80 px, minor divide o major e fica ≥ 8 px', () => {
    for (const fps of [24, 25, 30, 60]) {
      for (const pps of [1, 2.5, 10, 33, 100, 250, 480, 1200, 4000]) {
        const { majorUs, minorUs } = rulerTicks(pps, fps)
        expect((majorUs * pps) / 1e6).toBeGreaterThanOrEqual(80)
        expect((minorUs * pps) / 1e6).toBeGreaterThanOrEqual(8)
        const ratio = majorUs / minorUs
        expect(Math.abs(ratio - Math.round(ratio))).toBeLessThan(1e-9)
      }
    }
  })
  it('de 1 quadro (zoom máximo) a 10 min', () => {
    expect(rulerTicks(4000, 30).majorUs).toBeCloseTo(1e6 / 30)
    expect(rulerTicks(0.1, 30).majorUs).toBe(600_000_000)
  })
})

describe('rulerLabel', () => {
  it('passos de quadro mostram o quadro; de segundos, mm:ss', () => {
    expect(rulerLabel(1_500_000, 1e6 / 3, 30)).toBe('00:01:15')
    expect(rulerLabel(65_000_000, 5_000_000, 30)).toBe('1:05')
    expect(rulerLabel(3_665_000_000, 60_000_000, 30)).toBe('1:01:05')
  })
})

describe('maxScrollUs', () => {
  it('deixa rolar até o fim do projeto ficar no meio da tela', () => {
    expect(maxScrollUs(60_000_000, 1000, 100)).toBe(55_000_000)
    expect(maxScrollUs(1_000_000, 1000, 100)).toBe(0)
  })
})
