import { hasKeys } from '@shared/editor/anim'
import { itemAnimEntries, type AnimPath } from '@shared/editor/animPaths'
import type { Item, Track, TrackKind, Us } from '@shared/editor/project'
import { itemEndUs } from '@shared/editor/time'

// Geometria vertical da linha do tempo (pura): faixas de vídeo em cima — a da frente (maior índice)
// no topo —, um separador e as de áudio na ordem do modelo. Acima da 1ª de vídeo e abaixo da
// última de áudio ficam as áreas onde soltar cria uma faixa nova. Item expandido (seta no item):
// abaixo da caixa dos itens a faixa ganha uma linha por propriedade animada (keyframes por propriedade).

export const HEADER_W = 188
export const RULER_H = 28
export const ROW_H: Record<TrackKind, number> = { video: 60, audio: 48 }
export const TOP_PAD = 24
export const SEP_H = 10
export const BOTTOM_PAD = 56
/** Altura de cada linha de keyframes de uma propriedade. */
export const LANE_H = 22
/** Folga abaixo das linhas de keyframes. */
export const LANES_PAD = 4

/**
 * h = altura total; itemH = altura da área dos itens (a de sempre); lanes = linhas de keyframes abaixo
 * dela (a maior quantidade entre os itens expandidos da faixa; 0 = nenhum expandido).
 */
export interface Row { track: Track; y: number; h: number; itemH: number; lanes: number }
export interface Layout { rows: Row[]; sepY: number | null; height: number }

export type DropZone = { kind: 'track'; trackId: string } | { kind: 'newTrack'; trackKind: TrackKind } | null

const NONE: ReadonlySet<string> = new Set()

/** Propriedades com keyframes do item, na ordem de ANIM_PATHS: uma linha cada quando o item é expandido. */
export function lanePaths(item: Item): AnimPath[] {
  return itemAnimEntries(item).filter(([, a]) => hasKeys(a)).map(([pt]) => pt)
}

/** Linhas da faixa: a maior quantidade entre os itens expandidos (item sem keys expandido = 1 linha, com a dica). */
function trackLanes(t: Track, expanded: ReadonlySet<string>): number {
  if (expanded.size === 0) return 0
  let n = 0
  for (const it of t.items) if (expanded.has(it.id)) n = Math.max(n, lanePaths(it).length, 1)
  return n
}

export function buildLayout(tracks: Track[], expanded: ReadonlySet<string> = NONE): Layout {
  const video = tracks.filter((t) => t.kind === 'video').reverse()
  const audio = tracks.filter((t) => t.kind === 'audio')
  const rows: Row[] = []
  let y = TOP_PAD
  const push = (t: Track): void => {
    const lanes = trackLanes(t, expanded)
    const itemH = ROW_H[t.kind]
    const h = itemH + (lanes ? lanes * LANE_H + LANES_PAD : 0)
    rows.push({ track: t, y, h, itemH, lanes })
    y += h
  }
  for (const t of video) push(t)
  let sepY: number | null = null
  if (video.length && audio.length) {
    sepY = y
    y += SEP_H
  }
  for (const t of audio) push(t)
  return { rows, sepY, height: y + BOTTOM_PAD }
}

/**
 * Índice da linha de keyframes sob y (conteúdo, com scrollTop) na faixa; null fora das linhas. clamp: presa à
 * primeira/última linha (caixa de seleção que passa da borda).
 */
export function laneAt(row: Row, y: number, clamp = false): number | null {
  if (row.lanes === 0) return null
  const i = Math.floor((y - row.y - row.itemH) / LANE_H)
  if (clamp) return Math.max(0, Math.min(row.lanes - 1, i))
  return i >= 0 && i < row.lanes ? i : null
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
