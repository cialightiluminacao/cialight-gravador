import { describe, expect, it } from 'vitest'
import { redBlob } from './pixels'

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
