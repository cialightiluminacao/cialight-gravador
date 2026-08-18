import { describe, expect, it } from 'vitest'
import { MediaClock } from './mediaClock'

describe('MediaClock', () => {
  it('antes de start() o tempo de mídia é 0', () => {
    const c = new MediaClock()
    expect(c.mediaTimeMs(5000)).toBe(0)
    expect(c.isPaused).toBe(false)
    expect(c.pauses).toEqual([])
    expect(c.startedAtMs).toBe(0)
  })

  it('sem pausas, t_media = t_wall − início', () => {
    const c = new MediaClock()
    c.start(1000)
    expect(c.startedAtMs).toBe(1000)
    expect(c.mediaTimeMs(1000)).toBe(0)
    expect(c.mediaTimeMs(4500)).toBe(3500)
  })

  it('duas pausas são descontadas', () => {
    const c = new MediaClock()
    c.start(0)
    c.pause(1000)
    c.resume(1500) // pausa de 500 ms
    c.pause(3000)
    c.resume(4000) // pausa de 1000 ms
    expect(c.pauses).toEqual([
      { startMs: 1000, endMs: 1500 },
      { startMs: 3000, endMs: 4000 }
    ])
    expect(c.mediaTimeMs(5000)).toBe(5000 - 1500)
  })

  it('durante a pausa o tempo de mídia congela', () => {
    const c = new MediaClock()
    c.start(0)
    c.pause(2000)
    expect(c.isPaused).toBe(true)
    expect(c.mediaTimeMs(2000)).toBe(2000)
    expect(c.mediaTimeMs(2500)).toBe(2000)
    expect(c.mediaTimeMs(9000)).toBe(2000)
    c.resume(3000)
    expect(c.isPaused).toBe(false)
    expect(c.mediaTimeMs(3000)).toBe(2000)
    expect(c.mediaTimeMs(3400)).toBe(2400)
  })

  it('pause() repetido e resume() sem pausa são ignorados', () => {
    const c = new MediaClock()
    c.start(0)
    c.resume(100)
    expect(c.pauses).toEqual([])
    c.pause(1000)
    c.pause(1200)
    c.resume(1500)
    expect(c.pauses).toEqual([{ startMs: 1000, endMs: 1500 }])
  })

  it('stop() encerra pausa aberta', () => {
    const c = new MediaClock()
    c.start(0)
    c.pause(1000)
    c.stop(1800)
    expect(c.isPaused).toBe(false)
    expect(c.pauses).toEqual([{ startMs: 1000, endMs: 1800 }])
    expect(c.mediaTimeMs(1800)).toBe(1000)
  })

  it('após stop() o tempo de mídia congela no instante do stop', () => {
    const c = new MediaClock()
    c.start(0)
    c.stop(4000)
    expect(c.mediaTimeMs(4000)).toBe(4000)
    expect(c.mediaTimeMs(9999)).toBe(4000)
  })

  it('start() de novo reinicia o relógio', () => {
    const c = new MediaClock()
    c.start(0)
    c.pause(100)
    c.stop(200)
    c.start(1000)
    expect(c.pauses).toEqual([])
    expect(c.startedAtMs).toBe(1000)
    expect(c.mediaTimeMs(1300)).toBe(300)
  })

  it('pauses retorna cópia (não expõe estado interno)', () => {
    const c = new MediaClock()
    c.start(0)
    c.pause(10)
    c.resume(20)
    const p = c.pauses
    p.push({ startMs: 0, endMs: 0 })
    expect(c.pauses).toHaveLength(1)
  })
})
