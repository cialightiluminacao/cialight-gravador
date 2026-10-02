import { describe, expect, it } from 'vitest'
import { toneAmplitude } from './pcmAnalysis'

describe('toneAmplitude (Goertzel)', () => {
  it('mede a amplitude de 220 Hz sem vazamento de 1 kHz numa janela de 50 ms', () => {
    const sr = 48000
    const x = new Float32Array(sr)
    for (let i = 0; i < sr; i++) x[i] = 0.25 * Math.sin((2 * Math.PI * 220 * i) / sr + 0.3) + 0.3 * Math.sin((2 * Math.PI * 1000 * i) / sr)
    expect(toneAmplitude(x, 1000, 2400, 220, sr)).toBeCloseTo(0.25, 4)
    expect(toneAmplitude(x, 1000, 2400, 1000, sr)).toBeCloseTo(0.3, 4)
    expect(toneAmplitude(new Float32Array(2400), 0, 2400, 220, sr)).toBe(0)
  })
})
