import { describe, expect, it } from 'vitest'
import { createEmptyProject, defaultVisual } from '@shared/editor/factory'
import * as ops from '@shared/editor/ops'
import type { Asset, Project, TextItem } from '@shared/editor/project'
import { overlayDropTrack } from './dragMath'
import { cutNear, dragDuration, markGeometry, nearestEligibleCut, transitionDropReason, transitionDropTarget, visibleTransitions, MIN_MARK_W } from './transitionMath'
import { formatTransitionDuration, transitionAria, transitionLabel, TRANSITION_KINDS, TRANSITION_LABELS } from '../transitionInfo'

const S = 1_000_000
const vid = (id: string, dur: number): Asset => ({ id, name: id, kind: 'video', source: { type: 'file', path: `C:/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: dur, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready' })

/** V1: A 0–4 s, B 4–8 s, C 10–14 s (buraco entre B e C). */
function fixture(): { p: Project; a: string; b: string; c: string } {
  let p = ops.addAsset(createEmptyProject('t'), vid('v', 4 * S))
  const ra = ops.addMediaFromAsset(p, 'v', 0)
  const rb = ops.addMediaFromAsset(ra.project, 'v', 4 * S)
  const rc = ops.addMediaFromAsset(rb.project, 'v', 10 * S)
  p = rc.project
  return { p, a: ra.itemIds[0], b: rb.itemIds[0], c: rc.itemIds[0] }
}
const track = (p: Project) => p.tracks.find((t) => t.kind === 'video')!

describe('cutNear / transitionDropTarget', () => {
  it('acha o corte encostado dentro da tolerância e ignora o buraco', () => {
    const { p, b, c } = fixture()
    const t = track(p)
    expect(cutNear(t, 4 * S + 50_000, 100_000)).toBe(b)
    expect(cutNear(t, 4 * S - 99_000, 100_000)).toBe(b)
    expect(cutNear(t, 4 * S + 200_000, 100_000)).toBeNull()
    expect(cutNear(t, 10 * S, 100_000)).toBeNull() // C não encosta em B
    expect(c).toBeTruthy()
  })
  it('sobre o corte: via cut; sobre um item: via item; fora: null', () => {
    const { p, a, b, c } = fixture()
    const t = track(p)
    expect(transitionDropTarget(t, 4 * S + 10_000, 100_000)).toEqual({ toId: b, via: 'cut' })
    expect(transitionDropTarget(t, 2 * S, 100_000)).toEqual({ toId: a, via: 'item' })
    expect(transitionDropTarget(t, 12 * S, 100_000)).toEqual({ toId: c, via: 'item' })
    expect(transitionDropTarget(t, 9 * S, 100_000)).toBeNull()
  })
  it('transitionDropReason: o primeiro item e o que não encosta são recusados; o par válido não', () => {
    const { p, a, b, c } = fixture()
    const id = track(p).id
    expect(transitionDropReason(p, id, a)).toMatch(/encostados/)
    expect(transitionDropReason(p, id, c)).toMatch(/encostados/)
    expect(transitionDropReason(p, id, b)).toBeNull()
  })
})

describe('nearestEligibleCut', () => {
  it('escolhe o corte elegível mais perto do playhead; sem corte elegível, null', () => {
    const { p, b } = fixture()
    expect(nearestEligibleCut(p, null, 9 * S)).toEqual({ trackId: track(p).id, toId: b, cutUs: 4 * S })
    expect(nearestEligibleCut(p, [track(p).id], 0)?.toId).toBe(b)
    expect(nearestEligibleCut(p, ['inexistente'], 0)).toBeNull()
    const solo = ops.deleteItems(p, [b], { ripple: false })
    expect(nearestEligibleCut(solo, null, 0)).toBeNull()
  })
  it('faixa bloqueada e par com clipe desativado não contam', () => {
    const { p, b } = fixture()
    const locked = { ...p, tracks: p.tracks.map((t) => (t.kind === 'video' ? { ...t, locked: true } : t)) }
    expect(nearestEligibleCut(locked, null, 0)).toBeNull()
    const off = ops.setItemEnabled(p, [b], false)
    expect(nearestEligibleCut(off, null, 0)).toBeNull()
  })
  it('texto encostado em mídia é elegível', () => {
    const { p, b } = fixture()
    const r = ops.addTransition(p, b, 'crossfade')
    expect(nearestEligibleCut(r, null, 4 * S)?.toId).toBe(b) // substituir também vale
    const t: TextItem = { id: 'tx', type: 'text', startUs: 8 * S, durationUs: 2 * S, text: 'x', visual: defaultVisual(), style: { font: 'Inter', size: { value: 48 }, weight: 400, color: '#fff', align: 'center', lineHeight: 1.2 } }
    const q = { ...p, tracks: p.tracks.map((x) => (x.kind === 'video' ? { ...x, items: [...x.items.slice(0, 2), t, x.items[2]] } : x)) }
    expect(nearestEligibleCut(q, null, 8 * S)?.toId).toBe('tx')
  })
})

describe('visibleTransitions / markGeometry (ícone)', () => {
  it('só as janelas que tocam o intervalo visível; janela centrada no corte', () => {
    const { p, b } = fixture()
    const q = ops.addTransition(p, b, 'dipBlack', S)
    const t = track(q)
    const all = visibleTransitions(t, 0, 20 * S)
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ toId: b, kind: 'dipBlack', durationUs: S, cutUs: 4 * S, startUs: 3.5 * S })
    expect(visibleTransitions(t, 5 * S, 20 * S)).toHaveLength(0)
    expect(visibleTransitions(t, 3.7 * S, 3.8 * S)).toHaveLength(1) // só a metade de A visível
    expect(visibleTransitions(t, 0, 3.4 * S)).toHaveLength(0)
  })
  it('geometria: largura em escala; janelas curtas ganham largura mínima centrada no corte', () => {
    const w = { startUs: 3.5 * S, durationUs: S, cutUs: 4 * S }
    expect(markGeometry(w, 100, 0)).toEqual({ left: 350, width: 100, cutX: 400 })
    expect(markGeometry(w, 100, S)).toEqual({ left: 250, width: 100, cutX: 300 })
    const short = markGeometry({ startUs: 3.95 * S, durationUs: 0.1 * S, cutUs: 4 * S }, 100, 0)
    expect(short.width).toBe(MIN_MARK_W)
    expect(short.left + short.width / 2).toBeCloseTo(short.cutX)
  })
  it('mil itens: visibleTransitions não varre a faixa inteira (tempo)', () => {
    const base = ops.addMediaFromAsset(ops.addAsset(createEmptyProject('t'), vid('v', S)), 'v', 0)
    const proto = ops.findItem(base.project, base.itemIds[0])!.item
    const items = Array.from({ length: 1000 }, (_, i) => ({ ...proto, id: `i${i}`, startUs: i * S, ...(i > 0 ? { transitionIn: { kind: 'crossfade' as const, durationUs: 400_000 } } : {}) }))
    const p: Project = { ...base.project, tracks: base.project.tracks.map((t) => (t.kind === 'video' ? { ...t, items } : t)) }
    const last = ['x']
    const t0 = performance.now()
    let n = 0
    for (let k = 0; k < 2000; k++) n = visibleTransitions(track(p), 500 * S, 510 * S).length
    expect(n).toBe(11) // 500–510 s: os cortes de 500 a 510 s
    expect(performance.now() - t0).toBeLessThan(200)
    expect(last.length).toBeGreaterThan(0)
  })
})

describe('dragDuration (bordas)', () => {
  it('janela centrada: a borda anda 1 e a duração muda 2; limites do par', () => {
    const { p, a, b } = fixture()
    const A = ops.findItem(p, a)!.item, B = ops.findItem(p, b)!.item
    expect(dragDuration(S, 'end', 100_000, A, B)).toBe(1.2 * S)
    expect(dragDuration(S, 'start', -100_000, A, B)).toBe(1.2 * S)
    expect(dragDuration(S, 'start', 100_000, A, B)).toBe(0.8 * S)
    expect(dragDuration(S, 'end', -10 * S, A, B)).toBe(100_000) // mínimo
    expect(dragDuration(S, 'end', 10 * S, A, B)).toBe(2 * S) // máximo = metade do mais curto (4 s)
  })
})

describe('overlayDropTrack', () => {
  it('faixa de vídeo livre: usa; ocupada, bloqueada ou de efeitos: automático (undefined)', () => {
    const { p } = fixture()
    const id = track(p).id
    expect(overlayDropTrack(p, { kind: 'track', trackId: id }, 20 * S, 3 * S, 'text')).toBe(id)
    expect(overlayDropTrack(p, { kind: 'track', trackId: id }, 2 * S, 3 * S, 'text')).toBeUndefined()
    expect(overlayDropTrack(p, null, 0, S, 'text')).toBeUndefined()
    expect(overlayDropTrack(p, { kind: 'newTrack', trackKind: 'video' }, 0, S, 'shape')).toBeUndefined()
    const locked = { ...p, tracks: p.tracks.map((t) => (t.id === id ? { ...t, locked: true } : t)) }
    expect(overlayDropTrack(locked, { kind: 'track', trackId: id }, 20 * S, S, 'text')).toBeUndefined()
    const audio = p.tracks.find((t) => t.kind === 'audio')
    if (audio) expect(overlayDropTrack(p, { kind: 'track', trackId: audio.id }, 20 * S, S, 'text')).toBeUndefined()
  })
  it('faixa de efeitos nunca; legendas só texto', () => {
    const { p } = fixture()
    const fx = ops.addEffect(p, 'blur', 0)
    const fxTrack = fx.project.tracks.find(ops.isFxTrack)!
    expect(overlayDropTrack(fx.project, { kind: 'track', trackId: fxTrack.id }, 30 * S, S, 'text')).toBeUndefined()
    const cap = ops.addCaption(p, 30 * S, 'oi')
    const capTrack = cap.project.tracks.find(ops.isCaptionsTrack)!
    expect(overlayDropTrack(cap.project, { kind: 'track', trackId: capTrack.id }, 40 * S, S, 'text')).toBe(capTrack.id)
    expect(overlayDropTrack(cap.project, { kind: 'track', trackId: capTrack.id }, 40 * S, S, 'shape')).toBeUndefined()
  })
})

describe('transitionInfo (pt-BR)', () => {
  it('11 tipos, todos com nome; aria-label e duração com vírgula', () => {
    expect(TRANSITION_KINDS).toHaveLength(11)
    expect(new Set(TRANSITION_KINDS.map(transitionLabel)).size).toBe(11)
    expect(TRANSITION_LABELS.dipBlack).toBe('Mergulho no preto')
    expect(TRANSITION_LABELS.slideL).toBe('Deslizar ←')
    expect(formatTransitionDuration(500_000)).toBe('0,5 s')
    expect(formatTransitionDuration(1_250_000)).toBe('1,25 s')
    expect(formatTransitionDuration(2_000_000)).toBe('2 s')
    expect(transitionAria('crossfade', 500_000)).toBe('Transição: Dissolver, 0,5 s')
  })
})
