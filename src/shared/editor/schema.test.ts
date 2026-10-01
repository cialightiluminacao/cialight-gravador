import { describe, expect, it } from 'vitest'
import { parseProject, validateProject } from './schema'
import { createEmptyProject, createMediaItem } from './factory'
import type { Asset, Project } from './project'

const asset: Asset = { id: 'a1', name: 'a', kind: 'video', source: { type: 'file', path: 'x', size: 1, mtimeMs: 1 }, durationUs: 2_000_000, status: 'ready' }
const withItems = (items: ReturnType<typeof createMediaItem>[]): Project => {
  const p = createEmptyProject('x')
  p.assets = [asset]
  p.tracks[0].items = items
  return p
}
describe('schema', () => {
  it('round-trip', () => { const p = createEmptyProject('x'); expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p) })
  it('round-trip com item', () => { const p = withItems([createMediaItem(asset, 0, 'video')]); expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p) })
  it('round-trip com filmstrip/peaks e filmstripInfo', () => {
    const p = createEmptyProject('x')
    p.assets = [{ ...asset, filmstrip: 'cache/a1.strip.jpg', filmstripInfo: { frames: 6, everyUs: 1_000_000, tileW: 114, tileH: 64 }, peaks: 'cache/a1.peaks.bin' }]
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
  })
  it('filmstripInfo inválido lança', () => {
    const p = createEmptyProject('x')
    p.assets = [{ ...asset, filmstripInfo: { frames: 6, everyUs: 1.5, tileW: 114, tileH: 64 } }]
    expect(() => parseProject(JSON.parse(JSON.stringify(p)))).toThrow(/filmstripInfo/)
  })
  it('anotações: autoFadeMs opcional (número ≥ 0 ou null), round-trip', () => {
    const p = createEmptyProject('x')
    const ann = (autoFadeMs?: number | null): Project['tracks'][number]['items'][number] => ({ id: 'an', type: 'annotations', sessionId: 's', inUs: 0, startUs: 0, durationUs: 1_000_000, ...(autoFadeMs !== undefined ? { autoFadeMs } : {}) })
    for (const v of [undefined, null, 3000]) {
      p.tracks[0].items = [ann(v)]
      expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
    }
    p.tracks[0].items = [ann(-1)]
    expect(() => parseProject(JSON.parse(JSON.stringify(p)))).toThrow()
  })
  it('versão futura lança', () => expect(() => parseProject({ ...createEmptyProject('x'), version: 2 })).toThrow())
  it('detecta sobreposição', () => {
    const a = { ...createMediaItem(asset, 0, 'video'), id: 'i1', durationUs: 1_000_000 }
    const b = { ...createMediaItem(asset, 500_000, 'video'), id: 'i2', durationUs: 1_000_000 }
    expect(validateProject(withItems([a, b])).some((m) => m.includes('sobrepõe'))).toBe(true)
  })
  it('detecta sobreposição não adjacente (fim máximo acumulado)', () => {
    const a = { ...createMediaItem(asset, 0, 'video'), id: 'i1', durationUs: 2_000_000 }
    const b = { ...createMediaItem(asset, 2_000_000, 'video'), id: 'i2', durationUs: 100_000 }
    const c = { ...createMediaItem(asset, 1_500_000, 'video'), id: 'i3', durationUs: 100_000, inUs: 0 }
    const d = { ...createMediaItem(asset, 1_000_000, 'video'), id: 'i0', durationUs: 100_000 }
    // ordenado: i1 [0,2s), i0 [1s,1.1s), i3 [1.5s,1.6s), i2 [2s,2.1s) → i0 e i3 sobrepõem i1
    const msgs = validateProject(withItems([a, b, c, d])).filter((m) => m.includes('sobrepõe'))
    expect(msgs.some((m) => m.includes('i3') && m.includes('i1'))).toBe(true)
  })
  it('detecta keyframes com tempo repetido', () => {
    const a = { ...createMediaItem(asset, 0, 'video'), durationUs: 1_000_000 }
    a.audio = { ...a.audio, volume: { value: 1, keys: [{ tUs: 100, value: 0, ease: 'linear' }, { tUs: 100, value: 1, ease: 'linear' }] } }
    expect(validateProject(withItems([a])).some((m) => m.includes('keyframes de volume'))).toBe(true)
  })
  it('detecta excesso de fonte', () => {
    const a = { ...createMediaItem(asset, 0, 'video'), durationUs: 1_000_000, inUs: 1_500_000 }
    expect(validateProject(withItems([a])).some((m) => m.includes('excede'))).toBe(true)
  })
  it('projeto válido sem mensagens', () => {
    const a = { ...createMediaItem(asset, 0, 'video'), durationUs: 1_000_000 }
    expect(validateProject(withItems([a]))).toEqual([])
  })
})
