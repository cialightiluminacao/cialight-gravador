import { describe, expect, it } from 'vitest'
import { createEffectItem, createEmptyProject, createMediaItem } from './factory'
import { attachEffects } from './followTransform'
import { deleteRanges, updateTrack } from './ops'
import type { Asset, EffectItem, MediaItem, Project } from './project'
import { applyKenBurns } from './zoom'

// Desempenho da manutenção das âncoras (maintainAttachments roda em toda edição): projeto de 1 h com um efeito ancorado
// num clipe com Ken Burns, cortado em 301 pedaços (como o corte de silêncios).
const S = 1_000_000
const H1 = 3600 * S
const vid: Asset = { id: 'v', name: 'v', kind: 'video', source: { type: 'file', path: 'C:/v.mp4', size: 1, mtimeMs: 1 }, durationUs: H1 + 10 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready' }

function hourProject(): Project {
  const p = createEmptyProject('perf')
  p.assets = [vid]
  const m = { ...createMediaItem(vid, 0, 'video'), id: 'm', durationUs: H1, linkId: 'l1' } as MediaItem
  const fx = { ...createEffectItem('blur', 0, H1, { x: 0.3, y: 0.3, w: 0.1, h: 0.1 }), id: 'fx', linkId: 'l1' } as EffectItem
  p.tracks = [
    { id: 'tv', kind: 'video', name: 'Vídeo', muted: false, hidden: false, locked: false, volume: 1, items: [m] },
    { id: 'tf', kind: 'video', name: 'Efeitos', role: 'effects', muted: false, hidden: false, locked: false, volume: 1, items: [fx] }
  ]
  return attachEffects(applyKenBurns(p, 'm', 'br').project, 'm', ['fx'])
}
/** 300 silêncios de 1 s, um a cada 12 s. */
const silences = Array.from({ length: 300 }, (_, i) => ({ fromUs: (i * 12 + 6) * S, toUs: (i * 12 + 7) * S }))
const ms = (f: () => void): number => {
  const t = performance.now()
  f()
  return performance.now() - t
}
/** Melhor de 3 (o primeiro aquece o JIT). */
const best = (f: () => void): number => Math.min(ms(f), ms(f), ms(f))

describe('desempenho das âncoras', () => {
  it('corte de silêncios (deleteRanges, 300 trechos) num projeto de 1 h com efeito ancorado: < 200 ms', () => {
    const p = hourProject()
    let cut = p
    const t = best(() => { cut = deleteRanges(p, silences) })
    const fxs = cut.tracks[1].items as EffectItem[]
    expect(fxs).toHaveLength(301)
    // cada pedaço ancorado no pedaço do clipe que ele cruza, com a caixa de reserva
    const media = new Set(cut.tracks[0].items.map((i) => i.id))
    expect(fxs.every((f) => f.attach && media.has(f.attach.mediaItemId) && f.attach.fallback)).toBe(true)
    expect(new Set(fxs.map((f) => f.attach!.mediaItemId)).size).toBe(301)
    expect(t).toBeLessThan(200)
  })
  it('301 pedaços ancorados + edição trivial (renomear faixa): < 10 ms', () => {
    const cut = deleteRanges(hourProject(), silences)
    let n = 0
    const t = best(() => { updateTrack(cut, 'tv', { name: `Vídeo ${++n}` }) })
    expect(t).toBeLessThan(10)
    // e a edição trivial não recalcula nem troca nenhum efeito
    const q = updateTrack(cut, 'tv', { name: 'X' })
    expect(q.tracks[1].items.every((it, i) => it === cut.tracks[1].items[i])).toBe(true)
  })
})
