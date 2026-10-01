import { describe, expect, it } from 'vitest'
import { createEmptyProject } from './factory'
import type { Asset } from './project'
import * as ops from './ops'
import { snapDelta, snapPoints } from './snap'

const S = 1_000_000
const asset: Asset = { id: 'a1', name: 'a1', kind: 'video', source: { type: 'file', path: 'C:/a1.mp4', size: 1, mtimeMs: 1 }, durationUs: 4 * S, status: 'ready' }

describe('snap', () => {
  it('pontos incluem 0, playhead, bordas e marcadores, exceto itens excluídos', () => {
    let p = ops.addAsset(createEmptyProject('t'), asset)
    const r1 = ops.addMediaFromAsset(p, 'a1', S); p = r1.project
    const r2 = ops.addMediaFromAsset(p, 'a1', 6 * S); p = r2.project
    p = ops.addMarker(p, 3 * S)
    const pts = snapPoints(p, 2_500_000, r2.itemIds)
    expect(pts).toEqual(expect.arrayContaining([
      { us: 0, kind: 'zero' }, { us: 2_500_000, kind: 'playhead' }, { us: S, kind: 'itemStart' }, { us: 5 * S, kind: 'itemEnd' }, { us: 3 * S, kind: 'marker' }
    ]))
    expect(pts.some((x) => x.us === 6 * S || x.us === 10 * S)).toBe(false)
  })
  it('snapDelta escolhe o menor ajuste dentro da tolerância', () => {
    const pt = { us: 2_950_000, kind: 'itemEnd' as const }
    expect(snapDelta([1_000_000, 3_000_000], [pt], 100_000)).toEqual({ deltaUs: -50_000, point: pt })
    expect(snapDelta([1_000_000, 3_000_000], [{ us: 1_020_000, kind: 'marker' }, pt], 100_000)).toEqual({ deltaUs: 20_000, point: { us: 1_020_000, kind: 'marker' } })
  })
  it('fora da tolerância não encaixa', () => {
    expect(snapDelta([1_000_000], [{ us: 2_000_000, kind: 'playhead' }], 100_000)).toEqual({ deltaUs: 0, point: null })
  })
})
