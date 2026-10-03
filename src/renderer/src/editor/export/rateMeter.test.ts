import { describe, expect, it } from 'vitest'
import { RATE_WINDOW_MS, RateMeter } from './rateMeter'

describe('RateMeter (taxa da exportação por janela móvel de 10 s)', () => {
  it('início: null sem amostras, com 1 amostra e antes de 0,3 s; depois a taxa', () => {
    const m = new RateMeter()
    expect(m.fps()).toBeNull()
    m.add(1000, 5)
    expect(m.fps()).toBeNull() // 1 amostra: nada útil
    m.add(1200, 11)
    expect(m.fps()).toBeNull() // 0,2 s: cedo demais
    m.add(1400, 17)
    expect(m.fps()).toBeCloseTo(30, 9) // 12 quadros em 0,4 s
  })

  it('sem quadros novos (mesmo quadro): null', () => {
    const m = new RateMeter()
    m.add(0, 3)
    m.add(1000, 3)
    expect(m.fps()).toBeNull()
  })

  it('taxa constante: ETA exato', () => {
    const m = new RateMeter()
    for (let k = 0; k <= 600; k++) m.add(k * 200, k * 10) // 50 fps por 120 s
    expect(m.fps()).toBeCloseTo(50, 9)
    expect(m.etaS(10_000, 6000)).toBeCloseTo(80, 9)
  })

  it('mudança de taxa: depois de 10 s de amostras a ETA segue a taxa nova (não a média desde o início)', () => {
    const m = new RateMeter()
    let t = 0
    let f = 0
    for (; t < 60_000; t += 250) { m.add(t, f); f += 15 } // 60 fps por 60 s
    // cai para 15 fps
    const t1 = t
    for (; t <= t1 + RATE_WINDOW_MS + 250; t += 250) { m.add(t, f); f += 3.75 }
    const lastF = f - 3.75
    expect(m.fps()).toBeCloseTo(15, 9)
    const total = lastF + 1500
    expect(m.etaS(total, lastF)).toBeCloseTo(100, 6)
    // a média desde o início daria outra coisa (bem mais rápida)
    expect(lastF / ((t - 250) / 1000)).toBeGreaterThan(40)
  })

  it('ETA nunca negativa e null sem taxa', () => {
    const m = new RateMeter()
    expect(m.etaS(100, 10)).toBeNull()
    m.add(0, 0)
    m.add(1000, 30)
    expect(m.etaS(20, 30)).toBe(0)
  })

  it('memória: só as amostras da janela (descarte do início)', () => {
    const m = new RateMeter()
    for (let k = 0; k < 100_000; k++) m.add(k * 10, k) // 1000 s a 100 amostras/s
    // janela de 10 s → ~1000 amostras (+ a âncora), nunca as 100 000
    expect(m.size).toBeLessThanOrEqual(RATE_WINDOW_MS / 10 + 2)
    expect(m.fps()).toBeCloseTo(100, 9)
  })
})
