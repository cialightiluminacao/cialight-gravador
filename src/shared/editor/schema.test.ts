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
  it('versão futura lança', () => expect(() => parseProject({ ...createEmptyProject('x'), version: 2 })).toThrow())
  it('detecta sobreposição', () => {
    const a = { ...createMediaItem(asset, 0, 'video'), id: 'i1', durationUs: 1_000_000 }
    const b = { ...createMediaItem(asset, 500_000, 'video'), id: 'i2', durationUs: 1_000_000 }
    expect(validateProject(withItems([a, b])).some((m) => m.includes('sobrepõe'))).toBe(true)
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
