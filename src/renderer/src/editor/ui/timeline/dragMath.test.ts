import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '@shared/editor/factory'
import * as ops from '@shared/editor/ops'
import type { Asset, Project } from '@shared/editor/project'
import { snapPoints } from '@shared/editor/snap'
import { canChangeTrack, planMove, planTrim } from './dragMath'

const S = 1_000_000
const vid = (id: string, dur = 10 * S): Asset => ({ id, name: id, kind: 'video', source: { type: 'file', path: `C:/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: dur, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready' })

/** V1: [v0 0–4 s][v1 6–10 s] com áudio vinculado em A1. */
function fixture(): { p: Project; v0: string; a0: string; v1: string; a1: string } {
  let p = ops.addAsset(createEmptyProject('t'), vid('a', 4 * S))
  const r0 = ops.addMediaFromAsset(p, 'a', 0)
  const r1 = ops.addMediaFromAsset(r0.project, 'a', 6 * S)
  p = r1.project
  return { p, v0: r0.itemIds[0], a0: r0.itemIds[1], v1: r1.itemIds[0], a1: r1.itemIds[1] }
}
const at = (p: Project, id: string) => ops.findItem(p, id)!
const noSnap = null

describe('planMove', () => {
  it('move o item com o vinculado (mesmo delta) e mantém a faixa', () => {
    const { p, v1, a1 } = fixture()
    const r = planMove(p, { draggedId: v1, ids: [v1], deltaUs: 1 * S, zone: null, includeLinked: true, snap: noSnap, preview: true })
    expect(r.error).toBeNull()
    expect(at(r.project!, v1).item.startUs).toBe(7 * S)
    expect(at(r.project!, a1).item.startUs).toBe(7 * S)
  })
  it('Alt (sem vínculo) move só o item', () => {
    const { p, v1, a1 } = fixture()
    const r = planMove(p, { draggedId: v1, ids: [v1], deltaUs: 1 * S, zone: null, includeLinked: false, snap: noSnap, preview: true })
    expect(at(r.project!, v1).item.startUs).toBe(7 * S)
    expect(at(r.project!, a1).item.startUs).toBe(6 * S)
  })
  it('snap encaixa a borda mais próxima dentro da tolerância e devolve a guia', () => {
    const { p, v1 } = fixture()
    // v1 começa em 6 s; −1,9 s → 4,1 s, a 0,1 s do fim de v0 (4 s): encaixa em 4 s
    const snap = { points: snapPoints(p, 9 * S, [v1]), toleranceUs: 200_000 }
    const r = planMove(p, { draggedId: v1, ids: [v1], deltaUs: -1_900_000, zone: null, includeLinked: true, snap, preview: true })
    expect(r.deltaUs).toBe(-2 * S)
    expect(r.guideUs).toBe(4 * S)
    expect(at(r.project!, v1).item.startUs).toBe(4 * S)
  })
  it('fora da tolerância não encaixa', () => {
    const { p, v1 } = fixture()
    const snap = { points: snapPoints(p, 9 * S, [v1]), toleranceUs: 50_000 }
    const r = planMove(p, { draggedId: v1, ids: [v1], deltaUs: -1_900_000, zone: null, includeLinked: true, snap, preview: true })
    expect(r.guideUs).toBeNull()
    expect(at(r.project!, v1).item.startUs).toBe(4_100_000)
  })
  it('sobreposição ao soltar → overwrite (recorta o vizinho)', () => {
    const { p, v0, v1 } = fixture()
    const r = planMove(p, { draggedId: v1, ids: [v1], deltaUs: -3 * S, zone: null, includeLinked: true, snap: noSnap, preview: true })
    expect(r.error).toBeNull()
    expect(at(r.project!, v1).item.startUs).toBe(3 * S)
    expect(at(r.project!, v0).item.durationUs).toBe(3 * S)
  })
  it('não começa antes de 0', () => {
    const { p, v0 } = fixture()
    const r = planMove(p, { draggedId: v0, ids: [v0], deltaUs: -5 * S, zone: null, includeLinked: true, snap: noSnap, preview: true })
    expect(r.deltaUs).toBe(0)
    expect(at(r.project!, v0).item.startUs).toBe(0)
  })
  it('arrastar para outra faixa do mesmo tipo muda a faixa (vinculado fica na dele)', () => {
    let { p, v1, a1 } = fixture()
    const r0 = ops.addTrack(p, 'video')
    p = r0.project
    const r = planMove(p, { draggedId: v1, ids: [v1], deltaUs: 0, zone: { kind: 'track', trackId: r0.trackId }, includeLinked: true, snap: noSnap, preview: true })
    expect(at(r.project!, v1).track.id).toBe(r0.trackId)
    expect(at(r.project!, a1).track.kind).toBe('audio')
    expect(r.trackId).toBe(r0.trackId)
  })
  it('faixa de outro tipo é ignorada (fica na de origem)', () => {
    const { p, v1 } = fixture()
    const audioTrack = p.tracks.find((t) => t.kind === 'audio')!.id
    const r = planMove(p, { draggedId: v1, ids: [v1], deltaUs: 0, zone: { kind: 'track', trackId: audioTrack }, includeLinked: true, snap: noSnap, preview: true })
    expect(r.project).toBe(p)
  })
  it('acima da 1ª faixa de vídeo: prévia sem mexer no projeto; ao soltar cria a faixa no topo', () => {
    const { p, v1 } = fixture()
    const zone = { kind: 'newTrack', trackKind: 'video' } as const
    const prev = planMove(p, { draggedId: v1, ids: [v1], deltaUs: S, zone, includeLinked: true, snap: noSnap, preview: true })
    expect(prev.project).toBe(p)
    expect(prev.newTrackKind).toBe('video')
    expect(prev.deltaUs).toBe(S)
    const drop = planMove(p, { draggedId: v1, ids: [v1], deltaUs: S, zone, includeLinked: true, snap: noSnap, preview: false })
    const videos = drop.project!.tracks.filter((t) => t.kind === 'video')
    expect(videos).toHaveLength(2)
    // a nova faixa fica no topo (maior índice entre as de vídeo)
    expect(videos[videos.length - 1].id).toBe(drop.trackId)
    expect(at(drop.project!, v1).track.id).toBe(drop.trackId)
    expect(at(drop.project!, v1).item.startUs).toBe(7 * S)
  })
  it('áudio arrastado para baixo da última faixa de áudio cria faixa de áudio', () => {
    const { p, a1 } = fixture()
    const drop = planMove(p, { draggedId: a1, ids: [a1], deltaUs: 0, zone: { kind: 'newTrack', trackKind: 'audio' }, includeLinked: true, snap: noSnap, preview: false })
    expect(drop.project!.tracks.filter((t) => t.kind === 'audio')).toHaveLength(2)
    expect(at(drop.project!, a1).track.id).toBe(drop.trackId)
  })
  it('faixa bloqueada → erro (sombra vermelha), sem projeto', () => {
    const { p, v1 } = fixture()
    const locked = ops.updateTrack(p, at(p, v1).track.id, { locked: true })
    const r = planMove(locked, { draggedId: v1, ids: [v1], deltaUs: S, zone: null, includeLinked: true, snap: noSnap, preview: true })
    expect(r.project).toBeNull()
    expect(r.error?.code).toBe('locked')
  })
})

describe('canChangeTrack', () => {
  it('só quando a seleção está na faixa do arrastado (ou vinculada a ele)', () => {
    const { p, v0, a0, v1, a1 } = fixture()
    expect(canChangeTrack(p, [v0], v0, true)).toBe(true)
    expect(canChangeTrack(p, [v0, v1], v0, true)).toBe(true)
    expect(canChangeTrack(p, [v0, a0], v0, true)).toBe(true)
    expect(canChangeTrack(p, [v0, a0], v0, false)).toBe(false)
    expect(canChangeTrack(p, [v0, a1], v0, true)).toBe(false)
  })
})

describe('planTrim', () => {
  it('trim do fim com snap no playhead', () => {
    const { p, v0 } = fixture()
    const snap = { points: snapPoints(p, 3 * S, [v0]), toleranceUs: 100_000 }
    const r = planTrim(p, { itemId: v0, edge: 'end', deltaUs: -950_000, ripple: false, includeLinked: true, snap })
    expect(at(r.project!, v0).item.durationUs).toBe(3 * S)
    expect(r.guideUs).toBe(3 * S)
  })
  it('trim do início move o vinculado junto; Alt só o item', () => {
    const { p, v1, a1 } = fixture()
    const r = planTrim(p, { itemId: v1, edge: 'start', deltaUs: S, ripple: false, includeLinked: true, snap: noSnap })
    expect(at(r.project!, v1).item.startUs).toBe(7 * S)
    expect(at(r.project!, a1).item.startUs).toBe(7 * S)
    const alt = planTrim(p, { itemId: v1, edge: 'start', deltaUs: S, ripple: false, includeLinked: false, snap: noSnap })
    expect(at(alt.project!, a1).item.startUs).toBe(6 * S)
  })
  it('ripple (Ctrl) puxa os posteriores', () => {
    const { p, v0, v1 } = fixture()
    const r = planTrim(p, { itemId: v0, edge: 'end', deltaUs: -S, ripple: true, includeLinked: true, snap: noSnap })
    expect(at(r.project!, v0).item.durationUs).toBe(3 * S)
    expect(at(r.project!, v1).item.startUs).toBe(5 * S)
  })
  it('guia só aparece se a borda realmente parou no ponto (o trim limita pela fonte)', () => {
    const { p, v0 } = fixture()
    // estender o fim de v0 além da fonte (4 s): o trim limita em 4 s, o ponto 5 s não vale
    const snap = { points: [{ us: 5 * S, kind: 'marker' as const }], toleranceUs: 200_000 }
    const r = planTrim(p, { itemId: v0, edge: 'end', deltaUs: 900_000, ripple: false, includeLinked: true, snap })
    expect(r.project).toBe(p)
    expect(r.guideUs).toBeNull()
  })
})
