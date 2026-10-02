import { describe, expect, it } from 'vitest'
import { detailEnergy, greenBlob, redBlob } from './pixels'

describe('redBlob', () => {
  it('centro e caixa do vermelho (RGBA e RGB24); sem vermelho → null', () => {
    const w = 8, h = 6
    for (const stride of [4, 3]) {
      const d = new Uint8Array(w * h * stride).fill(40)
      for (let y = 2; y < 4; y++) for (let x = 3; x < 6; x++) { const i = (y * w + x) * stride; d[i] = 230; d[i + 1] = 10; d[i + 2] = 10 }
      expect(redBlob(d, w, h, stride)).toEqual({ cx: 4.5, cy: 3, n: 6, w: 3, h: 2 })
      expect(redBlob(new Uint8Array(w * h * stride), w, h, stride)).toBeNull()
    }
  })
})

describe('greenBlob e detailEnergy', () => {
  it('verde da caixa do alvo (inteiro e a 70 %) sobre o fundo escuro; energia de detalhe por stride', () => {
    const w = 8, h = 6
    for (const stride of [4, 3]) {
      const d = new Uint8Array(w * h * stride)
      for (let i = 0; i < w * h; i++) d.set([32, 48, 64], i * stride)
      for (let x = 2; x < 4; x++) d.set([64, 160, 96], (1 * w + x) * stride)
      d.set([45, 112, 67], (4 * w + 6) * stride)
      expect(greenBlob(d, w, h, stride)).toMatchObject({ n: 3, w: 5, h: 4 })
      // uma borda vertical de luma 0 → 100: ΔL² = 100² em cada par horizontal que a cruza
      const e = new Uint8Array(w * h * stride)
      for (let y = 0; y < h; y++) for (let x = 4; x < w; x++) e.set([100, 100, 100], (y * w + x) * stride)
      expect(detailEnergy(e, w, 0, 0, w, h, stride)).toBeCloseTo((100 * 100 * 5) / 35, 6)
    }
  })
})
