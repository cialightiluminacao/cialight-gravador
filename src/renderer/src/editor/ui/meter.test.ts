import { describe, expect, it } from 'vitest'
import { METER_FLOOR_DB, METER_HOLD_MS, meterStep, peakToFraction, type MeterState } from './meter'

describe('peakToFraction (escala em dB do medidor)', () => {
  it('0 dBFS = 1, piso = 0, −30 dB no meio; acima de 0 dBFS satura', () => {
    expect(peakToFraction(1)).toBe(1)
    expect(peakToFraction(2)).toBe(1)
    expect(peakToFraction(0)).toBe(0)
    expect(peakToFraction(Math.pow(10, METER_FLOOR_DB / 20) / 2)).toBe(0)
    expect(peakToFraction(Math.pow(10, -30 / 20))).toBeCloseTo(0.5, 9)
  })
})

describe('meterStep (balística do VU com pico)', () => {
  const zero: MeterState = { level: 0, peak: 0, peakAtMs: 0 }
  it('sobe na hora, cai devagar (24 dB/s) e o pico segura 1,5 s antes de cair', () => {
    let s = meterStep(zero, 0.8, 0, 16)
    expect(s.level).toBe(0.8)
    expect(s.peak).toBe(0.8)
    s = meterStep(s, 0, 100, 100)
    expect(s.level).toBeCloseTo(0.8 - 0.04, 9) // 2,4 dB em 100 ms = 0,04 da escala de 60 dB
    expect(s.peak).toBe(0.8)
    s = meterStep(s, 0, METER_HOLD_MS - 1, 100)
    expect(s.peak).toBe(0.8)
    s = meterStep(s, 0, METER_HOLD_MS + 100, 100)
    expect(s.peak).toBeLessThan(0.8)
    expect(s.peak).toBeGreaterThanOrEqual(s.level)
  })
  it('nunca abaixo de zero; pico novo mais alto reinicia a espera', () => {
    let s = meterStep(zero, 0.2, 0, 16)
    for (let t = 16; t < 5000; t += 16) s = meterStep(s, 0, t, 16)
    expect(s.level).toBe(0)
    expect(s.peak).toBe(0)
    s = meterStep(s, 0.5, 6000, 16)
    s = meterStep(s, 0.9, 6100, 16)
    expect(s.peakAtMs).toBe(6100)
    expect(s.peak).toBe(0.9)
  })
})
