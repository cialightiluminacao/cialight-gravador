import type { Item, Track, TrackKind, Us } from '@shared/editor/project'
import { itemEndUs } from '@shared/editor/time'

// Geometria vertical da linha do tempo (pura): faixas de vídeo em cima — a da frente (maior índice)
// no topo —, um separador e as de áudio na ordem do modelo. Acima da 1ª de vídeo e abaixo da
// última de áudio ficam as áreas onde soltar cria uma faixa nova.

export const HEADER_W = 188
export const RULER_H = 28
export const ROW_H: Record<TrackKind, number> = { video: 60, audio: 48 }
export const TOP_PAD = 24
export const SEP_H = 10
export const BOTTOM_PAD = 56

export interface Row { track: Track; y: number; h: number }
export interface Layout { rows: Row[]; sepY: number | null; height: number }

export type DropZone = { kind: 'track'; trackId: string } | { kind: 'newTrack'; trackKind: TrackKind } | null

export function buildLayout(tracks: Track[]): Layout {
  const video = tracks.filter((t) => t.kind === 'video').reverse()
  const audio = tracks.filter((t) => t.kind === 'audio')
  const rows: Row[] = []
  let y = TOP_PAD
  for (const t of video) {
    rows.push({ track: t, y, h: ROW_H.video })
    y += ROW_H.video
  }
  let sepY: number | null = null
  if (video.length && audio.length) {
    sepY = y
    y += SEP_H
  }
  for (const t of audio) {
    rows.push({ track: t, y, h: ROW_H.audio })
    y += ROW_H.audio
  }
  return { rows, sepY, height: y + BOTTOM_PAD }
}

/** O que está sob a coordenada y (conteúdo da área das faixas, já somado o scrollTop). */
export function zoneAt(L: Layout, y: number): DropZone {
  const first = L.rows[0]
  const last = L.rows[L.rows.length - 1]
  if (!first || !last) return { kind: 'newTrack', trackKind: y < TOP_PAD ? 'video' : 'audio' }
  if (y < first.y) return { kind: 'newTrack', trackKind: 'video' }
  if (y >= last.y + last.h) return { kind: 'newTrack', trackKind: 'audio' }
  const row = L.rows.find((r) => y >= r.y && y < r.y + r.h)
  return row ? { kind: 'track', trackId: row.track.id } : null
}

/** Primeiro índice com fim > fromUs (itens ordenados e sem sobreposição → fins também ordenados). */
function firstEndingAfter(items: Item[], fromUs: Us): number {
  let lo = 0, hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (itemEndUs(items[mid]) > fromUs) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** Virtualização: só os itens que cruzam [fromUs, toUs). */
export function visibleItems(items: Item[], fromUs: Us, toUs: Us): Item[] {
  const out: Item[] = []
  for (let i = firstEndingAfter(items, fromUs); i < items.length && items[i].startUs < toUs; i++) out.push(items[i])
  return out
}

/** Seleção por caixa: itens das faixas cruzadas por [y0,y1] que cruzam [fromUs,toUs]. */
export function itemsInBox(L: Layout, fromUs: Us, toUs: Us, y0: number, y1: number): string[] {
  const top = Math.min(y0, y1), bottom = Math.max(y0, y1)
  const a = Math.min(fromUs, toUs), b = Math.max(fromUs, toUs)
  const out: string[] = []
  for (const r of L.rows) {
    if (r.y + r.h <= top || r.y >= bottom) continue
    for (const it of visibleItems(r.track.items, a, b + 1)) out.push(it.id)
  }
  return out
}

/**
 * Índice no modelo da faixa vizinha do mesmo tipo na direção da tela ("para cima"/"para baixo");
 * null se já está na ponta. Vídeo aparece invertido (maior índice no topo).
 */
export function displayNeighborIndex(tracks: Track[], trackId: string, dir: 'up' | 'down'): number | null {
  const i = tracks.findIndex((t) => t.id === trackId)
  if (i < 0) return null
  const kind = tracks[i].kind
  const step = (kind === 'video') === (dir === 'up') ? 1 : -1
  for (let j = i + step; j >= 0 && j < tracks.length; j += step) if (tracks[j].kind === kind) return j
  return null
}
