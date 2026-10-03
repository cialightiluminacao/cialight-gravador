import { describe, expect, it } from 'vitest'
import { clipMovesIn } from './contentPose'
import { createMediaItem } from './factory'
import type { Anim, Asset, MediaItem } from './project'

const S = 1_000_000
const vid: Asset = { id: 'v', name: 'v', kind: 'video', source: { type: 'file', path: 'C:/v.mp4', size: 1, mtimeMs: 1 }, durationUs: 10 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready' }
const clip = (): MediaItem => ({ ...createMediaItem(vid, 0, 'video'), id: 'm' }) as MediaItem
const keys = (...ks: [number, number][]): Anim<number> => ({ value: ks[0][1], keys: ks.map(([tUs, value]) => ({ tUs, value, ease: 'linear' as const })) })

describe('clipMovesIn', () => {
  it('clipe parado: nunca', () => {
    expect(clipMovesIn(clip(), 0, 10 * S)).toBe(false)
  })
  it('keys x 0→0,5 entre 1–2 s: só os intervalos que cruzam o segmento', () => {
    const m = clip()
    m.visual!.transform.x = keys([S, 0], [2 * S, 0.5])
    expect(clipMovesIn(m, 0, S)).toBe(false)
    expect(clipMovesIn(m, 1.5 * S, 3 * S)).toBe(true)
    expect(clipMovesIn(m, 2 * S, 5 * S)).toBe(false)
    expect(clipMovesIn(m, 0, 10 * S)).toBe(true)
  })
  it('keys de mesmo valor: constante', () => {
    const m = clip()
    m.visual!.transform.scale = keys([S, 1.8], [3 * S, 1.8], [4 * S, 1.8])
    expect(clipMovesIn(m, 0, 10 * S)).toBe(false)
  })
  it('animIn/animOut com geometria: só a janela', () => {
    const m = clip()
    m.visual!.animIn = { preset: 'zoom', durationUs: S }
    expect(clipMovesIn(m, 0, 0.5 * S)).toBe(true)
    expect(clipMovesIn(m, S, 10 * S)).toBe(false)
    m.visual!.animOut = { preset: 'pop', durationUs: S }
    expect(clipMovesIn(m, 9.5 * S, 10 * S)).toBe(true)
    expect(clipMovesIn(m, 5 * S, 9 * S)).toBe(false)
    m.visual!.animIn = { preset: 'fade', durationUs: S }
    expect(clipMovesIn(m, 0, S)).toBe(false)
  })
  it('corte animado conta', () => {
    const m = clip()
    m.visual!.crop.l = keys([0, 0], [S, 0.2])
    expect(clipMovesIn(m, 0, 0.5 * S)).toBe(true)
    expect(clipMovesIn(m, S, 2 * S)).toBe(false)
  })
  it('"segurar" com valores diferentes: conservador (segmento inteiro se move)', () => {
    const m = clip()
    m.visual!.transform.x = { value: 0.5, keys: [{ tUs: S, value: 0.5, ease: 'hold' }, { tUs: 3 * S, value: 0.8, ease: 'hold' }] }
    expect(clipMovesIn(m, 2 * S, 2.5 * S)).toBe(true)
  })
  it('rotação animada conta', () => {
    const m = clip()
    m.visual!.transform.rotation = keys([S, 0], [2 * S, 30])
    expect(clipMovesIn(m, 0, S)).toBe(false)
    expect(clipMovesIn(m, 1.5 * S, 2 * S)).toBe(true)
  })
  it('keys fora da duração do clipe: só vale o que cruza [a, b)', () => {
    const m = clip() // 10 s
    m.visual!.transform.x = keys([12 * S, 0.5], [14 * S, 0.9])
    expect(clipMovesIn(m, 0, 10 * S)).toBe(false)
    m.visual!.transform.y = keys([-2 * S, 0.2], [4 * S, 0.6])
    expect(clipMovesIn(m, 0, S)).toBe(true)
    expect(clipMovesIn(m, 4 * S, 10 * S)).toBe(false)
  })
})
