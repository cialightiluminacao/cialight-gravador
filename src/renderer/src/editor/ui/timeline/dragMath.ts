import { addTrack, EditError, findItem, linkedIds, moveItems, trimItem } from '@shared/editor/ops'
import type { Project, TrackKind, Us } from '@shared/editor/project'
import { snapDelta, type SnapPoint } from '@shared/editor/snap'
import { itemEndUs } from '@shared/editor/time'
import type { DropZone } from './layout'

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
