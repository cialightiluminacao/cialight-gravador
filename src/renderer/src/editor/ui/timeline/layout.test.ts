import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '@shared/editor/factory'
import * as ops from '@shared/editor/ops'
import type { Item, Project } from '@shared/editor/project'
import { buildLayout, displayNeighborIndex, itemsInBox, laneAt, LANE_H, lanePaths, LANES_PAD, ROW_H, SEP_H, TOP_PAD, visibleItems, zoneAt } from './layout'

const S = 1_000_000

function threeTracks(): Project {
  // tracks (ordem do modelo): V1, V2, A1, A2 — na tela: V2, V1 | A1, A2
  let p = createEmptyProject('t')
  p = ops.addTrack(p, 'video').project
  p = ops.addTrack(p, 'audio').project
  return p
}

describe('buildLayout', () => {
  it('vídeo de cima para baixo (frente → fundo), separador, áudio na ordem', () => {
    const p = threeTracks()
    const L = buildLayout(p.tracks)
    expect(L.rows.map((r) => r.track.name)).toEqual(['Vídeo 2', 'Vídeo 1', 'Áudio 1', 'Áudio 2'])
    expect(L.rows[0].y).toBe(TOP_PAD)
    expect(L.rows[1].y).toBe(TOP_PAD + ROW_H.video)
    expect(L.sepY).toBe(TOP_PAD + 2 * ROW_H.video)
    expect(L.rows[2].y).toBe(TOP_PAD + 2 * ROW_H.video + SEP_H)
    expect(L.height).toBeGreaterThan(L.rows[3].y + ROW_H.audio)
  })
})

describe('zoneAt', () => {
  it('faixa sob o ponteiro; acima da 1ª de vídeo / abaixo da última de áudio = faixa nova', () => {
    const p = threeTracks()
    const L = buildLayout(p.tracks)
    expect(zoneAt(L, 2)).toEqual({ kind: 'newTrack', trackKind: 'video' })
    expect(zoneAt(L, TOP_PAD + 5)).toEqual({ kind: 'track', trackId: L.rows[0].track.id })
    expect(zoneAt(L, L.sepY! + 2)).toBeNull()
    expect(zoneAt(L, L.rows[3].y + 3)).toEqual({ kind: 'track', trackId: L.rows[3].track.id })
    expect(zoneAt(L, L.rows[3].y + ROW_H.audio + 4)).toEqual({ kind: 'newTrack', trackKind: 'audio' })
  })
})

describe('visibleItems', () => {
  it('só os itens que cruzam a janela (busca binária)', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `i${i}`, startUs: i * S, durationUs: S })) as Item[]
    expect(visibleItems(items, 10.5 * S, 13 * S).map((i) => i.id)).toEqual(['i10', 'i11', 'i12'])
    expect(visibleItems(items, 200 * S, 300 * S)).toEqual([])
    expect(visibleItems(items, 0, 1).map((i) => i.id)).toEqual(['i0'])
  })
})

describe('itemsInBox', () => {
  it('itens das faixas cruzadas pela caixa e dentro do intervalo de tempo', () => {
    let p = ops.addAsset(threeTracks(), { id: 'a1', name: 'a', kind: 'video', source: { type: 'file', path: 'C:/a.mp4', size: 1, mtimeMs: 1 }, durationUs: 4 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready' })
    const r1 = ops.addMediaFromAsset(p, 'a1', 0)
    p = r1.project
    const r2 = ops.addMediaFromAsset(p, 'a1', 10 * S)
    p = r2.project
    const L = buildLayout(p.tracks)
    const v1Row = L.rows.find((r) => r.track.name === 'Vídeo 1')!
    // só a faixa Vídeo 1, de 1 s a 5 s → só o 1º vídeo
    expect(itemsInBox(L, 1 * S, 5 * S, v1Row.y + 4, v1Row.y + 10)).toEqual([r1.itemIds[0]])
    // todas as faixas, de 3 s a 11 s → os quatro itens
    expect(itemsInBox(L, 3 * S, 11 * S, 0, L.height).sort()).toEqual([...r1.itemIds, ...r2.itemIds].sort())
  })
})

describe('displayNeighborIndex', () => {
  it('“para cima” na tela: vídeo → índice maior; áudio → índice menor; sem vizinho → null', () => {
    const p = threeTracks() // V1, V2, A1, A2
    const [v1, v2, a1, a2] = p.tracks.map((t) => t.id)
    expect(displayNeighborIndex(p.tracks, v1, 'up')).toBe(1)
    expect(displayNeighborIndex(p.tracks, v2, 'up')).toBeNull()
    expect(displayNeighborIndex(p.tracks, v2, 'down')).toBe(0)
    expect(displayNeighborIndex(p.tracks, a2, 'up')).toBe(2)
    expect(displayNeighborIndex(p.tracks, a1, 'up')).toBeNull()
    expect(displayNeighborIndex(p.tracks, a1, 'down')).toBe(3)
  })
})

describe('linhas de keyframes (item expandido)', () => {
  /** Vídeo 1 com um clipe animado em X e opacidade (2 linhas) e outro sem keys. */
  function animated(): { p: Project; a: string; b: string } {
    let p = ops.addAsset(threeTracks(), { id: 'a1', name: 'a', kind: 'video', source: { type: 'file', path: 'C:/a.mp4', size: 1, mtimeMs: 1 }, durationUs: 4 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready' })
    const r1 = ops.addMediaFromAsset(p, 'a1', 0)
    const r2 = ops.addMediaFromAsset(r1.project, 'a1', 10 * S)
    p = ops.toggleKeyframe(r2.project, r1.itemIds[0], 'transform.x', S)
    p = ops.toggleKeyframe(p, r1.itemIds[0], 'transform.opacity', 2 * S)
    return { p, a: r1.itemIds[0], b: r2.itemIds[0] }
  }
  it('lanePaths: uma linha por propriedade com keys, na ordem de ANIM_PATHS', () => {
    const { p, a, b } = animated()
    expect(lanePaths(ops.findItem(p, a)!.item)).toEqual(['transform.x', 'transform.opacity'])
    expect(lanePaths(ops.findItem(p, b)!.item)).toEqual([])
  })
  it('sem item expandido a geometria não muda', () => {
    const { p } = animated()
    expect(buildLayout(p.tracks, new Set())).toEqual(buildLayout(p.tracks))
    expect(buildLayout(p.tracks).rows.every((r) => r.lanes === 0 && r.itemH === r.h)).toBe(true)
  })
  it('item expandido: a faixa ganha uma altura por linha (mínimo 1) e as de baixo descem', () => {
    const { p, a, b } = animated()
    const base = buildLayout(p.tracks)
    const L = buildLayout(p.tracks, new Set([a]))
    const i = L.rows.findIndex((r) => r.track.name === 'Vídeo 1')
    expect(L.rows[i].lanes).toBe(2)
    expect(L.rows[i].itemH).toBe(ROW_H.video)
    expect(L.rows[i].h).toBe(ROW_H.video + 2 * LANE_H + LANES_PAD)
    expect(L.rows[i + 1].y - base.rows[i + 1].y).toBe(2 * LANE_H + LANES_PAD)
    expect(L.height - base.height).toBe(2 * LANE_H + LANES_PAD)
    // item sem keys expandido: uma linha (vazia, com a dica)
    expect(buildLayout(p.tracks, new Set([b])).rows[i].lanes).toBe(1)
    // dois expandidos na mesma faixa: a maior quantidade de linhas
    expect(buildLayout(p.tracks, new Set([a, b])).rows[i].lanes).toBe(2)
  })
  it('laneAt: índice da linha sob y (null fora das linhas)', () => {
    const { p, a } = animated()
    const L = buildLayout(p.tracks, new Set([a]))
    const row = L.rows.find((r) => r.track.name === 'Vídeo 1')!
    const top = row.y + row.itemH
    expect(laneAt(row, top - 1)).toBeNull()
    expect(laneAt(row, top)).toBe(0)
    expect(laneAt(row, top + LANE_H + 1)).toBe(1)
    expect(laneAt(row, top + 2 * LANE_H + 1)).toBeNull()
    // presa às linhas existentes (caixa que passa da borda)
    expect(laneAt(row, top - 50, true)).toBe(0)
    expect(laneAt(row, top + 500, true)).toBe(1)
  })
  it('zoneAt: as linhas fazem parte da faixa', () => {
    const { p, a } = animated()
    const L = buildLayout(p.tracks, new Set([a]))
    const row = L.rows.find((r) => r.track.name === 'Vídeo 1')!
    expect(zoneAt(L, row.y + row.itemH + 3)).toEqual({ kind: 'track', trackId: row.track.id })
  })
})
