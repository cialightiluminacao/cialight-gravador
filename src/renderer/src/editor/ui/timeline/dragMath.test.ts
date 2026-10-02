import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '@shared/editor/factory'
import * as ops from '@shared/editor/ops'
import type { Asset, EffectItem, MediaItem, Project } from '@shared/editor/project'
import { snapPoints } from '@shared/editor/snap'
import { canChangeTrack, dropTarget, effectDropTrack, edgeScrollPx, EDGE_SCROLL_MAX, fadeHandleLefts, gestureSnapPoints, keyframeMarkLefts, planFade, planKeyframeDrag, planMove, planTrim } from './dragMath'

import { concreteRefs, dragGroup } from '../../state/keyframeSelection'

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

describe('gesto e transições', () => {
  // useTimelineDrag recalcula cada evento a partir de txBase (o projeto do início do gesto): afastar e voltar no mesmo
  // gesto não perde a transição (só o estado final do gesto conta)
  function encostados(): { base: Project; v0: string; v1: string } {
    const { p, v0, v1 } = fixture()
    const base = ops.addTransition(ops.moveItems(p, [v1], -2 * S), v1, 'crossfade', S)
    return { base, v0, v1 }
  }
  const trIn = (p: Project, id: string) => (at(p, id).item as MediaItem).transitionIn
  it('mover B para longe e de volta no mesmo gesto mantém a transição', () => {
    const { base, v1 } = encostados()
    const away = planMove(base, { draggedId: v1, ids: [v1], deltaUs: 2 * S, zone: null, includeLinked: true, snap: noSnap, preview: true })
    expect(trIn(away.project!, v1)).toBeUndefined()
    const back = planMove(base, { draggedId: v1, ids: [v1], deltaUs: 0, zone: null, includeLinked: true, snap: noSnap, preview: true })
    expect(trIn(back.project ?? base, v1)).toEqual({ kind: 'crossfade', durationUs: S })
  })
  it('encolher A e voltar no mesmo gesto de trim mantém a transição', () => {
    const { base, v0, v1 } = encostados()
    const shrink = planTrim(base, { itemId: v0, edge: 'end', deltaUs: -S, ripple: false, includeLinked: true, snap: noSnap })
    expect(trIn(shrink.project!, v1)).toBeUndefined()
    const back = planTrim(base, { itemId: v0, edge: 'end', deltaUs: 0, ripple: false, includeLinked: true, snap: noSnap })
    expect(trIn(back.project ?? base, v1)).toEqual({ kind: 'crossfade', durationUs: S })
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

describe('gestureSnapPoints', () => {
  it('com vínculo exclui os vinculados; com Alt as bordas do vinculado viram pontos', () => {
    let { p, v1, a1 } = fixture()
    // desloca o áudio vinculado para ter bordas próprias (6,5 s)
    p = ops.moveItems(p, [a1], S / 2, { includeLinked: false })
    const linked = gestureSnapPoints(p, 0, [v1], true).map((x) => x.us)
    const alt = gestureSnapPoints(p, 0, [v1], false).map((x) => x.us)
    expect(linked).not.toContain(6.5 * S)
    expect(alt).toContain(6.5 * S)
    expect(alt).not.toContain(6 * S + 4 * S) // fim do próprio v1 (10 s) não entra
  })
})

describe('planFade', () => {
  it('fade de entrada do vídeo (visual) e de saída do áudio (audio), limitado à duração', () => {
    const { p, v0, a0 } = fixture()
    const r = planFade(p, { itemId: v0, side: 'in', deltaUs: S })
    const v = at(r.project!, v0).item as MediaItem
    expect(v.visual!.fadeInUs).toBe(S)
    const r2 = planFade(r.project!, { itemId: v0, side: 'out', deltaUs: -10 * S })
    expect((at(r2.project!, v0).item as MediaItem).visual!.fadeOutUs).toBe(3 * S) // 4 s − 1 s de entrada
    const r3 = planFade(p, { itemId: a0, side: 'out', deltaUs: -1.5 * S })
    expect((at(r3.project!, a0).item as MediaItem).audio.fadeOutUs).toBe(1.5 * S)
    expect(planFade(p, { itemId: v0, side: 'in', deltaUs: -S }).project).toBe(p)
  })
  it('faixa bloqueada → erro', () => {
    const { p, v0 } = fixture()
    const locked = ops.updateTrack(p, at(p, v0).track.id, { locked: true })
    expect(planFade(locked, { itemId: v0, side: 'in', deltaUs: S }).error?.code).toBe('locked')
  })
})

describe('dropTarget', () => {
  it('nunca solta mídia numa faixa "Efeitos" (cai na escolha automática); mover para ela é recusado', () => {
    const { p, v0 } = fixture()
    const e = ops.addEffect(p, 'blur', 0)
    const fxTrack = ops.findItem(e.project, e.itemId)!.track.id
    expect(dropTarget(e.project, 'a', { kind: 'track', trackId: fxTrack })).toBeUndefined()
    const r = planMove(e.project, { draggedId: v0, ids: [v0], deltaUs: 20 * S, zone: { kind: 'track', trackId: fxTrack }, includeLinked: false, snap: noSnap, preview: false })
    expect(r.project).toBeNull()
    expect(r.error?.code).toBe('invalid')
  })
  const audioAsset = (): Asset => ({ id: 'm', name: 'm', kind: 'audio', source: { type: 'file', path: 'C:/m.m4a', size: 1, mtimeMs: 1 }, durationUs: S, audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready' })
  it('só passa a faixa quando o tipo bate com o que a mídia gera', () => {
    const p = ops.addAsset(fixture().p, audioAsset())
    const vTrack = p.tracks.find((t) => t.kind === 'video')!.id
    const aTrack = p.tracks.find((t) => t.kind === 'audio')!.id
    expect(dropTarget(p, 'm', { kind: 'track', trackId: vTrack })).toBeUndefined()
    expect(dropTarget(p, 'm', { kind: 'track', trackId: aTrack })).toEqual({ trackId: aTrack })
    expect(dropTarget(p, 'm', { kind: 'newTrack', trackKind: 'video' })).toBeUndefined()
    expect(dropTarget(p, 'm', { kind: 'newTrack', trackKind: 'audio' })).toEqual({ newTrack: 'audio' })
    expect(dropTarget(p, 'a', { kind: 'track', trackId: vTrack })).toEqual({ trackId: vTrack })
    expect(dropTarget(p, 'a', { kind: 'newTrack', trackKind: 'audio' })).toEqual({ newTrack: 'audio' })
    expect(dropTarget(p, 'a', null)).toBeUndefined()
  })
})

describe('effectDropTrack (soltar efeito da biblioteca na linha do tempo)', () => {
  it('faixa de vídeo sob o ponteiro livre no intervalo do efeito → ela', () => {
    const r = ops.addEffect(fixture().p, 'blur', 0, { durationUs: 2 * S })
    const fx = ops.findItem(r.project, r.itemId)!.track.id
    expect(effectDropTrack(r.project, { kind: 'track', trackId: fx }, 3 * S)).toBe(fx)
  })
  it('faixa ocupada no intervalo, de áudio, bloqueada, nova faixa ou fora → undefined (faixa "Efeitos" automática)', () => {
    const { p } = fixture()
    const v = p.tracks.find((t) => t.kind === 'video')!.id
    const a = p.tracks.find((t) => t.kind === 'audio')!.id
    expect(effectDropTrack(p, { kind: 'track', trackId: v }, S)).toBeUndefined() // sobre o clipe: não sobrescreve a mídia
    expect(effectDropTrack(p, { kind: 'track', trackId: v }, 4.5 * S)).toBeUndefined() // 5 s padrão invadem o clipe de 6 s
    expect(effectDropTrack(p, { kind: 'track', trackId: a }, 20 * S)).toBeUndefined()
    expect(effectDropTrack(p, { kind: 'newTrack', trackKind: 'video' }, 0)).toBeUndefined()
    expect(effectDropTrack(p, null, 0)).toBeUndefined()
    expect(effectDropTrack(p, { kind: 'track', trackId: v }, 20 * S)).toBe(v)
    const locked = ops.updateTrack(p, v, { locked: true })
    expect(effectDropTrack(locked, { kind: 'track', trackId: v }, 20 * S)).toBeUndefined()
  })
  it('nunca numa faixa oculta nem numa faixa abaixo de mídia visível no intervalo (a mídia ficaria por cima)', () => {
    const { p } = fixture()
    const low = p.tracks[0].id
    // trecho livre da faixa de baixo (4–6 s) sob um clipe de uma faixa mais alta
    const up = ops.addTrack(p, 'video')
    const q = ops.addMediaFromAsset(up.project, 'a', 4 * S, { videoTrackId: up.trackId }).project
    expect(effectDropTrack(q, { kind: 'track', trackId: low }, 4 * S)).toBeUndefined()
    expect(effectDropTrack(ops.updateTrack(q, up.trackId, { hidden: true }), { kind: 'track', trackId: low }, 4 * S)).toBeUndefined() // 5 s invadem v1
    const free = ops.addTrack(q, 'video', 0) // faixa vazia no fundo, abaixo de tudo
    expect(effectDropTrack(free.project, { kind: 'track', trackId: free.trackId }, 20 * S)).toBe(free.trackId)
    expect(effectDropTrack(free.project, { kind: 'track', trackId: free.trackId }, 0)).toBeUndefined() // v0 por cima
    expect(effectDropTrack(ops.updateTrack(free.project, free.trackId, { hidden: true }), { kind: 'track', trackId: free.trackId }, 20 * S)).toBeUndefined()
  })
})

describe('edgeScrollPx', () => {
  it('zero no meio; cresce perto das bordas; negativo à esquerda', () => {
    expect(edgeScrollPx(500, 1000)).toBe(0)
    expect(edgeScrollPx(990, 1000)).toBeGreaterThan(edgeScrollPx(970, 1000))
    expect(edgeScrollPx(970, 1000)).toBeGreaterThan(0)
    expect(edgeScrollPx(5, 1000)).toBeLessThan(0)
    expect(edgeScrollPx(-50, 1000)).toBe(-EDGE_SCROLL_MAX)
    expect(edgeScrollPx(2000, 1000)).toBe(EDGE_SCROLL_MAX)
  })
})

describe('fadeHandleLefts', () => {
  const H = 10
  const overlap = (a: number, b: number): boolean => Math.abs(a - b) < H
  it('alças nos cantos com fades curtos', () => {
    expect(fadeHandleLefts(0, 0, 0, 200, H)).toEqual({ in: 0, out: 190 })
    expect(fadeHandleLefts(50, 30, 0, 200, H)).toEqual({ in: 45, out: 165 })
  })
  it('fadeIn = duração: as duas alças continuam separadas (as duas podem ser agarradas)', () => {
    const r = fadeHandleLefts(200, 0, 0, 200, H)
    expect(overlap(r.in, r.out)).toBe(false)
    expect(r.in).toBeGreaterThanOrEqual(0)
    expect(r.out + H).toBeLessThanOrEqual(200)
  })
  it('fadeOut = duração e fades que se encontram no meio também não se sobrepõem', () => {
    for (const [fin, fout] of [[0, 200], [100, 100], [120, 80]]) {
      const r = fadeHandleLefts(fin, fout, -40, 160, H)
      expect(overlap(r.in, r.out)).toBe(false)
      expect(r.in).toBeLessThan(r.out)
    }
  })
})

describe('keyframeMarkLefts (losangos na timeline)', () => {
  it('posição escala com o zoom e desconta o recorte; centrada no instante', () => {
    expect(keyframeMarkLefts([0, S, 2 * S], 100, 0, 1000, 10)).toEqual([{ tUs: 0, left: -5 }, { tUs: S, left: 95 }, { tUs: 2 * S, left: 195 }])
    expect(keyframeMarkLefts([S], 400, 0, 1000, 10)).toEqual([{ tUs: S, left: 395 }])
    expect(keyframeMarkLefts([S], 100, 50, 1000, 10)).toEqual([{ tUs: S, left: 45 }])
  })
  it('só os visíveis no recorte', () => {
    expect(keyframeMarkLefts([0, S, 3 * S, 5 * S], 100, 200, 250, 10).map((m) => m.tUs)).toEqual([3 * S])
    expect(keyframeMarkLefts([2 * S + 40_000], 100, 200, 250, 10).map((m) => m.tUs)).toEqual([2 * S + 40_000]) // meio losango ainda aparece
  })
})

describe('planKeyframeDrag', () => {
  /** Efeito em 1–5 s com keys de intensidade nos locais 1 s (10) e 3 s (90). */
  function fx(): { p: Project; id: string } {
    const r = ops.addEffect(createEmptyProject('t'), 'blur', S, { durationUs: 4 * S })
    let p = ops.toggleKeyframe(r.project, r.itemId, 'strength', 2 * S)
    p = ops.setAnimValue(p, r.itemId, 'strength', 2 * S, 10)
    p = ops.toggleKeyframe(p, r.itemId, 'strength', 4 * S)
    p = ops.setAnimValue(p, r.itemId, 'strength', 4 * S, 90)
    return { p, id: r.itemId }
  }
  const keys = (p: Project, id: string) => (ops.findItem(p, id)!.item as EffectItem).strength.keys!.map((k) => [k.tUs, k.value])
  it('move o key pelo delta, no quadro mais próximo', () => {
    const { p, id } = fx()
    const r = planKeyframeDrag(p, { itemId: id, fromUs: S, deltaUs: 530_000 })
    expect(r.toUs).toBe(1_533_333) // 2,53 s absoluto → quadro 76 @30 = 2 533 333 → local 1 533 333
    expect(keys(r.project!, id)).toEqual([[r.toUs, 10], [3 * S, 90]])
  })
  it('limitado ao item', () => {
    const { p, id } = fx()
    expect(planKeyframeDrag(p, { itemId: id, fromUs: S, deltaUs: -5 * S }).toUs).toBe(0)
    expect(planKeyframeDrag(p, { itemId: id, fromUs: 3 * S, deltaUs: 9 * S }).toUs).toBe(4 * S)
  })
  it('soltar sobre outro key o substitui (sem dois keys no mesmo quadro)', () => {
    const { p, id } = fx()
    const r = planKeyframeDrag(p, { itemId: id, fromUs: S, deltaUs: 2 * S + 5_000 })
    expect(keys(r.project!, id)).toEqual([[3 * S, 10]])
  })
  it('keys escolhidos (linhas): só eles andam, no quadro, e o grupo fica preso ao item', () => {
    const { p, id } = fx()
    const one = planKeyframeDrag(p, { itemId: id, fromUs: S, deltaUs: 530_000, keys: [{ path: 'strength', tUs: S }] })
    expect(one.toUs).toBe(1_533_333)
    expect(keys(one.project!, id)).toEqual([[1_533_333, 10], [3 * S, 90]])
    // grupo [1 s, 3 s] num item de 4 s: no máximo +1 s
    const g = planKeyframeDrag(p, { itemId: id, fromUs: S, deltaUs: 2 * S, keys: [{ path: 'strength', tUs: S }, { path: 'strength', tUs: 3 * S }] })
    expect(g.toUs).toBe(2 * S)
    expect(keys(g.project!, id)).toEqual([[2 * S, 10], [4 * S, 90]])
    // a região (sem keys aqui) não muda
    expect((ops.findItem(g.project!, id)!.item as EffectItem).region.x.keys).toBeUndefined()
  })
  it('seleção mista (combinado em 1 s + intensidade em 3 s): arrastar a linha da região em 1 s move tudo junto', () => {
    const { p, id } = fx()
    let q = ops.toggleKeyframe(p, id, 'region.x', 2 * S) // região com key em 1 s (local), junto da intensidade
    const item = ops.findItem(q, id)!.item
    const refs = concreteRefs(item, dragGroup({ itemId: id, keys: [{ path: null, tUs: S }, { path: 'strength', tUs: 3 * S }] }, id, { path: 'region.x', tUs: S }))
    const r = planKeyframeDrag(q, { itemId: id, fromUs: S, deltaUs: 0.5 * S, keys: refs })
    q = r.project!
    expect(r.toUs).toBe(1.5 * S)
    expect(keys(q, id)).toEqual([[1.5 * S, 10], [3.5 * S, 90]])
    expect((ops.findItem(q, id)!.item as EffectItem).region.x.keys!.map((k) => k.tUs)).toEqual([1.5 * S])
  })
  it('keys escolhidos em faixa bloqueada: erro, sem mudar nada', () => {
    const { p, id } = fx()
    const locked = ops.updateTrack(p, ops.findItem(p, id)!.track.id, { locked: true })
    const r = planKeyframeDrag(locked, { itemId: id, fromUs: S, deltaUs: S, keys: [{ path: 'strength', tUs: S }] })
    expect(r.project).toBeNull()
    expect(r.error?.code).toBe('locked')
  })
  it('faixa bloqueada: erro, projeto null', () => {
    const { p, id } = fx()
    const locked = ops.updateTrack(p, ops.findItem(p, id)!.track.id, { locked: true })
    const r = planKeyframeDrag(locked, { itemId: id, fromUs: S, deltaUs: S })
    expect(r.project).toBeNull()
    expect(r.error?.code).toBe('locked')
  })
})
