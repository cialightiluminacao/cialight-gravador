import { addTrack, EditError, findItem, linkedIds, moveItems, trimItem, updateItem } from '@shared/editor/ops'
import type { MediaItem, Project, TrackKind, Us } from '@shared/editor/project'
import { snapDelta, snapPoints, type SnapPoint } from '@shared/editor/snap'
import { itemEndUs } from '@shared/editor/time'
import type { DropZone } from './layout'
import { assetProduces } from './assetKinds'

// Matemática pura dos gestos da linha do tempo. Cada evento recalcula o resultado a partir do
// projeto do início do gesto (base da transação) com o deslocamento total: nada se acumula.

export interface SnapOpts { points: SnapPoint[]; toleranceUs: Us }

export interface MoveInput {
  draggedId: string
  /** Seleção (contém draggedId). */
  ids: string[]
  deltaUs: Us
  zone: DropZone
  includeLinked: boolean
  snap: SnapOpts | null
  /**
   * Durante o arraste (true), soltar numa área de faixa nova não cria a faixa: o projeto fica na base
   * e `newTrackKind` diz onde desenhar a sombra (a geometria das faixas não muda no meio do gesto).
   */
  preview: boolean
}

export interface GestureResult {
  /** null = inválido (ex.: faixa bloqueada): a UI volta à base e mostra a sombra vermelha. */
  project: Project | null
  error: EditError | null
  guideUs: Us | null
}

export interface MovePlan extends GestureResult {
  deltaUs: Us
  /** Faixa onde o item arrastado fica (para a sombra). */
  trackId: string
  /** Prévia de faixa nova (só com preview). */
  newTrackKind: TrackKind | null
}

/** Ids movidos pelo gesto: a seleção e (com vínculo) os vinculados. */
function blockIds(p: Project, ids: string[], includeLinked: boolean): string[] {
  const out = new Set<string>()
  for (const id of ids) for (const x of includeLinked ? linkedIds(p, id) : [id]) out.add(x)
  return [...out].filter((id) => findItem(p, id))
}

/**
 * Mudar de faixa só quando a seleção está toda na faixa do item arrastado (ou é vinculada, com vínculo
 * ativo, a algo dela): moveItems aplica uma única faixa de destino aos itens dados.
 */
export function canChangeTrack(p: Project, ids: string[], draggedId: string, includeLinked: boolean): boolean {
  const src = findItem(p, draggedId)?.track
  if (!src) return false
  const linksOnSrc = new Set(ids.map((id) => src.items.find((i) => i.id === id)?.linkId).filter(Boolean))
  return ids.every((id) => {
    const f = findItem(p, id)
    if (!f) return true
    if (f.track.id === src.id) return true
    return includeLinked && !!f.item.linkId && linksOnSrc.has(f.item.linkId)
  })
}

export function planMove(base: Project, input: MoveInput): MovePlan {
  const { draggedId, ids, zone, includeLinked } = input
  const dragged = findItem(base, draggedId)
  if (!dragged) return { project: base, error: null, guideUs: null, deltaUs: 0, trackId: '', newTrackKind: null }
  const block = blockIds(base, ids, includeLinked).map((id) => findItem(base, id)!.item)
  const minStart = Math.min(...block.map((i) => i.startUs))
  let delta = Math.max(Math.round(input.deltaUs), -minStart)
  let guideUs: Us | null = null
  if (input.snap) {
    const cands = block.flatMap((i) => [i.startUs + delta, itemEndUs(i) + delta])
    const s = snapDelta(cands, input.snap.points, input.snap.toleranceUs)
    if (s.point && minStart + delta + s.deltaUs >= 0) {
      delta += s.deltaUs
      guideUs = s.point.us
    }
  }

  // faixa de destino: outra do mesmo tipo, ou uma nova acima/abaixo
  const kind = dragged.track.kind
  let p = base
  let toTrackId: string | undefined
  if (zone && canChangeTrack(base, ids, draggedId, includeLinked)) {
    if (zone.kind === 'track' && zone.trackId !== dragged.track.id && base.tracks.find((t) => t.id === zone.trackId)?.kind === kind) {
      toTrackId = zone.trackId
    } else if (zone.kind === 'newTrack' && zone.trackKind === kind) {
      if (input.preview) return { project: base, error: null, guideUs, deltaUs: delta, trackId: dragged.track.id, newTrackKind: kind }
      const nt = addTrack(base, kind)
      p = nt.project
      toTrackId = nt.trackId
    }
  }
  const primary = toTrackId ? ids.filter((id) => findItem(base, id)?.track.id === dragged.track.id) : ids
  const trackId = toTrackId ?? dragged.track.id
  if (delta === 0 && !toTrackId) return { project: base, error: null, guideUs, deltaUs: 0, trackId, newTrackKind: null }
  try {
    const project = moveItems(p, primary, delta, { toTrackId, includeLinked, mode: 'overwrite' })
    return { project, error: null, guideUs, deltaUs: delta, trackId, newTrackKind: null }
  } catch (e) {
    if (e instanceof EditError) return { project: null, error: e, guideUs: null, deltaUs: delta, trackId, newTrackKind: null }
    throw e
  }
}

export interface TrimInput {
  itemId: string
  edge: 'start' | 'end'
  deltaUs: Us
  ripple: boolean
  includeLinked: boolean
  snap: SnapOpts | null
}

export function planTrim(base: Project, input: TrimInput): GestureResult {
  const f = findItem(base, input.itemId)
  if (!f) return { project: base, error: null, guideUs: null }
  const edge0 = input.edge === 'start' ? f.item.startUs : itemEndUs(f.item)
  let toUs = edge0 + Math.round(input.deltaUs)
  let snapped: Us | null = null
  if (input.snap) {
    const s = snapDelta([toUs], input.snap.points, input.snap.toleranceUs)
    if (s.point) {
      toUs += s.deltaUs
      snapped = s.point.us
    }
  }
  try {
    const project = trimItem(base, input.itemId, input.edge, toUs, { ripple: input.ripple, includeLinked: input.includeLinked })
    // a guia só vale se a borda parou mesmo no ponto (o trim limita pela fonte e pelos vizinhos)
    const after = findItem(project, input.itemId)?.item
    const edgeNow = after ? (input.edge === 'start' ? (input.ripple ? null : after.startUs) : itemEndUs(after)) : null
    const guideUs = snapped !== null && (edgeNow === snapped || (edgeNow === null && project !== base)) ? snapped : null
    return { project, error: null, guideUs }
  } catch (e) {
    if (e instanceof EditError) return { project: null, error: e, guideUs: null }
    throw e
  }
}

/**
 * Pontos do ímã para um gesto sobre `ids`: com vínculo ativo os vinculados se movem junto e saem da
 * lista; com Alt (sem vínculo) eles ficam parados e as bordas deles também atraem.
 */
export function gestureSnapPoints(base: Project, playheadUs: Us, ids: string[], includeLinked: boolean): SnapPoint[] {
  const exclude = includeLinked ? [...new Set(ids.flatMap((id) => linkedIds(base, id)))] : ids
  return snapPoints(base, playheadUs, exclude)
}

export interface FadeInput { itemId: string; side: 'in' | 'out'; deltaUs: Us }

/**
 * Alça de fade no canto do item: entrada cresce para a direita, saída para a esquerda. Item de faixa de
 * vídeo usa visual.fade*, de faixa de áudio usa audio.fade*. Limite: entrada + saída ≤ duração.
 */
export function planFade(base: Project, input: FadeInput): GestureResult & { fadeUs: Us } {
  const f = findItem(base, input.itemId)
  if (!f || f.item.type !== 'media') return { project: base, error: null, guideUs: null, fadeUs: 0 }
  const it = f.item
  const useVisual = f.track.kind === 'video' && !!it.visual
  const cur = useVisual ? { in: it.visual!.fadeInUs, out: it.visual!.fadeOutUs } : { in: it.audio.fadeInUs, out: it.audio.fadeOutUs }
  const other = input.side === 'in' ? cur.out : cur.in
  const raw = input.side === 'in' ? cur.in + input.deltaUs : cur.out - input.deltaUs
  const fadeUs = Math.max(0, Math.min(it.durationUs - other, Math.round(raw)))
  if (fadeUs === cur[input.side]) return { project: base, error: null, guideUs: null, fadeUs }
  const key = input.side === 'in' ? 'fadeInUs' : 'fadeOutUs'
  try {
    const project = updateItem<MediaItem>(base, it.id, (d) => {
      if (useVisual && d.visual) d.visual[key] = fadeUs
      else d.audio[key] = fadeUs
    })
    return { project, error: null, guideUs: null, fadeUs }
  } catch (e) {
    if (e instanceof EditError) return { project: null, error: e, guideUs: null, fadeUs: cur[input.side] }
    throw e
  }
}

/**
 * Mídia solta da biblioteca: a faixa sob o ponteiro só vale se for do tipo que a mídia gera (vídeo/imagem
 * → vídeo; com áudio → áudio). Nunca cria faixa vazia do tipo errado.
 */
export function dropTarget(p: Project, assetId: string, zone: DropZone): { trackId: string } | { newTrack: TrackKind } | undefined {
  const asset = p.assets.find((a) => a.id === assetId)
  if (!asset || !zone) return undefined
  const kinds = assetProduces(asset)
  if (zone.kind === 'newTrack') return kinds.includes(zone.trackKind) ? { newTrack: zone.trackKind } : undefined
  const t = p.tracks.find((x) => x.id === zone.trackId)
  return t && kinds.includes(t.kind) ? { trackId: t.id } : undefined
}

export const EDGE_SCROLL_ZONE = 48
export const EDGE_SCROLL_MAX = 24

/** Rolagem automática perto das bordas durante um gesto: px por quadro (negativo = para a esquerda), mais rápido quanto mais perto. */
export function edgeScrollPx(x: number, viewW: number): number {
  if (x < EDGE_SCROLL_ZONE) return -Math.round(EDGE_SCROLL_MAX * Math.min(1, (EDGE_SCROLL_ZONE - x) / EDGE_SCROLL_ZONE))
  if (x > viewW - EDGE_SCROLL_ZONE) return Math.round(EDGE_SCROLL_MAX * Math.min(1, (x - (viewW - EDGE_SCROLL_ZONE)) / EDGE_SCROLL_ZONE))
  return 0
}
