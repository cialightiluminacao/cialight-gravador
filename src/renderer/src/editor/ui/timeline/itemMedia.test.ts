import { describe, expect, it } from 'vitest'
import type { FilmstripInfo, MediaItem } from '@shared/editor/project'
import { filmstripSlots, sourceUsAt, waveColumns, waveGains } from './itemMedia'

const S = 1_000_000
const item = (over: Partial<MediaItem> = {}): MediaItem => ({ id: 'i', type: 'media', assetId: 'a', startUs: 10 * S, durationUs: 4 * S, inUs: 2 * S, speed: 1, reverse: false, audio: { enabled: true, volume: { value: 1 }, fadeInUs: 0, fadeOutUs: 0, preservePitch: true, denoise: false, normalize: false }, ...over })

describe('sourceUsAt', () => {
  it('considera inUs, velocidade e reverso', () => {
    expect(sourceUsAt(item(), 0)).toBe(2 * S)
    expect(sourceUsAt(item({ speed: 2 }), S)).toBe(4 * S)
    // reverso: o começo do item mostra o fim do trecho usado
    expect(sourceUsAt(item({ reverse: true }), 0)).toBe(6 * S)
    expect(sourceUsAt(item({ reverse: true }), 4 * S)).toBe(2 * S)
  })
  it('congelado: o mesmo quadro em todo o item (filmstrip e onda)', () => {
    expect(sourceUsAt(item({ freeze: { atUs: 3 * S } }), 0)).toBe(3 * S)
    expect(sourceUsAt(item({ freeze: { atUs: 3 * S } }), 2 * S)).toBe(3 * S)
  })
})

describe('filmstripSlots', () => {
  const fs: FilmstripInfo = { frames: 20, everyUs: S, tileW: 114, tileH: 64 }
  it('quadros ancorados no início do item; só os que cruzam o recorte visível', () => {
    // 100 px/s, slot de 50 px (0,5 s): slots em 0, 50, 100… (px relativos ao item)
    const slots = filmstripSlots(item(), fs, 50, 100, 120, 260)
    expect(slots.map((s) => s.x)).toEqual([100, 150, 200, 250])
    // slot em 100 px = 1 s do item → fonte 3 s → quadro 3
    expect(slots[0].frame).toBe(3)
  })
  it('limita ao último quadro do sprite', () => {
    const slots = filmstripSlots(item({ inUs: 19 * S }), fs, 50, 100, 0, 400)
    expect(Math.max(...slots.map((s) => s.frame))).toBe(19)
  })
})

describe('waveColumns', () => {
  it('min/max por coluna a partir dos peaks (100 por segundo)', () => {
    // 10 s de peaks: o segundo k tem amplitude k*10
    const peaks = new Int8Array(2000)
    for (let i = 0; i < 1000; i++) {
      const a = Math.floor(i / 100) * 10
      peaks[i * 2] = -a
      peaks[i * 2 + 1] = a
    }
    // item usa a fonte a partir de 2 s; 1 px = 1 s (1 px/s): coluna 0 → segundo 2, coluna 3 → segundo 5
    const cols = waveColumns(peaks, item(), 1, 0, 4)
    expect(Array.from(cols)).toEqual([-20, 20, -30, 30, -40, 40, -50, 50])
  })
  it('fora da fonte dá silêncio', () => {
    const cols = waveColumns(new Int8Array(4).fill(100), item({ inUs: 0 }), 100, 50, 52)
    expect(Array.from(cols)).toEqual([0, 0, 0, 0])
  })
})

describe('waveGains (forma de onda reflete o volume)', () => {
  it('volume da faixa × volume do item (estático) em toda coluna', () => {
    const g = waveGains(item({ audio: { ...item().audio, volume: { value: 0.5 } } }), 2, 100, 0, 4)
    expect([...g]).toEqual([1, 1, 1, 1])
  })
  it('keyframes de volume: ganho no meio de cada coluna (tempo local do item)', () => {
    // 100 px/s: coluna c cobre [c, c+1) × 10 ms; keys 0 s → 0, 1 s → 1 (linear)
    const it = item({ audio: { ...item().audio, volume: { value: 1, keys: [{ tUs: 0, value: 0, ease: 'linear' }, { tUs: S, value: 1, ease: 'linear' }] } } })
    const g = waveGains(it, 1, 100, 50, 3)
    expect(g[0]).toBeCloseTo(0.505, 6)
    expect(g[1]).toBeCloseTo(0.515, 6)
    expect(waveGains(it, 1, 100, 200, 1)[0]).toBe(1)
  })
  it('áudio desligado: forma de onda apagada (15 %)', () => {
    const g = waveGains(item({ audio: { ...item().audio, enabled: false } }), 1, 100, 0, 2)
    expect(g[0]).toBeCloseTo(0.15, 6)
  })
})
