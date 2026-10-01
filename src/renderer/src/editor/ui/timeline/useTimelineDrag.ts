import { useCallback } from 'react'
import { toast } from 'sonner'
import { findItem, linkedIds } from '@shared/editor/ops'
import type { Project, Us } from '@shared/editor/project'
import { snapPoints, type SnapPoint } from '@shared/editor/snap'
import { useEditorStore } from '../../state/editorStore'
import { planMove, planTrim, type MoveInput, type MovePlan } from './dragMath'
import { HEADER_W, itemsInBox, ROW_H, TOP_PAD, zoneAt, type Layout } from './layout'
import { pxToDurUs, pxToUs, usToPx } from './zoom'

// Gestos da linha do tempo com Pointer Events, por delegação (um handler para todos os itens):
//  • corpo do item → mover (com vinculados; Alt ignora o vínculo; outra faixa do mesmo tipo muda a faixa;
//    acima da 1ª de vídeo / abaixo da última de áudio cria faixa nova ao soltar)
//  • borda do item (data-edge) → trim (Ctrl = ripple; Alt ignora o vínculo)
//  • fundo → seleção por caixa (Ctrl/Shift soma); clique simples no fundo limpa a seleção
// Mover/trim: transação aberta ao passar do limiar, cada evento recalcula a partir da base com
// apply transitório, pointerup = commitTx (um passo de desfazer), Esc/pointercancel = cancelTx.
// Ímã: 8 px convertidos em µs pelo zoom, com linha guia no ponto.

export const SNAP_PX = 8
const MOVE_THRESHOLD_PX = 3
const TRIM_THRESHOLD_PX = 2

export interface Ghost { y: number; h: number; startUs: Us; durationUs: Us; tone: 'new' | 'invalid' }
export interface DragOverlay {
  guideUs: Us | null
  ghost: Ghost | null
  /** Caixa de seleção: x em px da área das faixas, y no conteúdo (com scrollTop). */
  box: { x0: number; y0: number; x1: number; y1: number } | null
}
export const NO_OVERLAY: DragOverlay = { guideUs: null, ghost: null, box: null }

interface Opts {
  scrollerRef: React.RefObject<HTMLDivElement | null>
  layoutRef: React.RefObject<Layout>
  setOverlay: (o: DragOverlay) => void
  onItemMenu: (itemId: string, clientX: number, clientY: number) => void
}

const st = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()

/** Cursor do gesto em toda a janela (styles.css: body[data-drag-cursor] * herda o cursor do body). */
function setDragCursor(c: string | null): void {
  document.body.style.cursor = c ?? ''
  if (c) document.body.dataset.dragCursor = ''
  else delete document.body.dataset.dragCursor
}

/** Gesto ativo (um por vez). */
let active: { end: (commit: boolean) => void } | null = null

/** Cancela o gesto em andamento (ex.: a linha do tempo saiu da tela no meio do arraste). */
export function cancelActiveGesture(): void {
  active?.end(false)
}

export function useTimelineDrag({ scrollerRef, layoutRef, setOverlay, onItemMenu }: Opts): {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
  onContextMenu: (e: React.MouseEvent<HTMLElement>) => void
} {
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const scroller = scrollerRef.current
      const target = e.target as HTMLElement
      if (e.button !== 0 || !scroller || active || !st().project) return
      if (target.closest('[data-track-header],button,input')) return
      const rect = scroller.getBoundingClientRect()
      const laneX = (clientX: number): number => clientX - rect.left - HEADER_W
      const contentY = (clientY: number): number => clientY - rect.top + scroller.scrollTop
      if (laneX(e.clientX) < 0) return
      e.preventDefault()

      const x0 = e.clientX, y0 = e.clientY
      const startUs = pxToUs(laneX(x0), st().zoomPxPerSec, st().scrollUs)
      const toleranceUs = (): Us => pxToDurUs(SNAP_PX, st().zoomPxPerSec)
      let started = false
      let onMove: (ev: PointerEvent) => void = () => {}
      let onEnd: (commit: boolean) => void = () => {}

      const itemEl = target.closest<HTMLElement>('[data-item-id]')
      const edge = target.closest<HTMLElement>('[data-edge]')?.dataset.edge as 'start' | 'end' | undefined
      const id = itemEl?.dataset.itemId

      if (id && edge) {
        // ---------------- trim
        if (!st().selection.includes(id)) st().select([id])
        let base: Project | null = null
        let points: SnapPoint[] = []
        let failed: string | null = null
        onMove = (ev) => {
          if (!started) {
            if (Math.abs(ev.clientX - x0) < TRIM_THRESHOLD_PX) return
            started = true
            st().begin()
            base = st().txBase ?? st().project
            points = snapPoints(base!, st().playheadUs, linkedIds(base!, id))
            setDragCursor('ew-resize')
          }
          const { zoomPxPerSec: z, scrollUs: s, snapping } = st()
          const r = planTrim(base!, {
            itemId: id,
            edge,
            deltaUs: pxToUs(laneX(ev.clientX), z, s) - startUs,
            ripple: ev.ctrlKey || ev.metaKey,
            includeLinked: !ev.altKey,
            snap: snapping ? { points, toleranceUs: toleranceUs() } : null
          })
          failed = r.error?.message ?? null
          st().apply(() => r.project ?? base!, { transient: true })
          setOverlay({ guideUs: r.guideUs, ghost: null, box: null })
        }
        onEnd = (commit) => {
          if (!started) return
          if (commit && !failed) st().commitTx()
          else st().cancelTx()
          if (commit && failed) toast.error(failed)
        }
      } else if (id) {
        // ---------------- mover
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
          st().select([id], 'toggle')
          return
        }
        const wasSelected = st().selection.includes(id)
        if (!wasSelected) st().select([id])
        const ids = st().selection
        let base: Project | null = null
        let points: SnapPoint[] = []
        let last: { input: MoveInput; plan: MovePlan } | null = null
        onMove = (ev) => {
          if (!started) {
            if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < MOVE_THRESHOLD_PX) return
            started = true
            st().begin()
            base = st().txBase ?? st().project
            const block = [...new Set(ids.flatMap((x) => linkedIds(base!, x)))]
            points = snapPoints(base!, st().playheadUs, block)
            setDragCursor('grabbing')
          }
          const { zoomPxPerSec: z, scrollUs: s, snapping } = st()
          const input: MoveInput = {
            draggedId: id,
            ids,
            deltaUs: pxToUs(laneX(ev.clientX), z, s) - startUs,
            zone: zoneAt(layoutRef.current, contentY(ev.clientY)),
            includeLinked: !ev.altKey,
            snap: snapping ? { points, toleranceUs: toleranceUs() } : null,
            preview: true
          }
          const plan = planMove(base!, input)
          last = { input, plan }
          st().apply(() => plan.project ?? base!, { transient: true })
          setOverlay({ guideUs: plan.guideUs, ghost: moveGhost(base!, layoutRef.current, id, plan), box: null })
        }
        onEnd = (commit) => {
          if (!started) {
            // clique sem arrastar num item já selecionado: fica só ele
            if (commit && wasSelected) st().select([id])
            return
          }
          if (!commit || !last || last.plan.error) {
            st().cancelTx()
            if (commit && last?.plan.error) toast.error(last.plan.error.message)
            return
          }
          if (last.plan.newTrackKind) {
            const final = planMove(base!, { ...last.input, preview: false })
            if (!final.project) {
              st().cancelTx()
              if (final.error) toast.error(final.error.message)
              return
            }
            st().apply(() => final.project!, { transient: true })
          }
          st().commitTx()
        }
      } else {
        // ---------------- seleção por caixa
        const additive = e.ctrlKey || e.metaKey || e.shiftKey
        const before = st().selection
        const initial = additive ? before : []
        const cy0 = contentY(y0)
        onMove = (ev) => {
          if (!started) {
            if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < MOVE_THRESHOLD_PX) return
            started = true
          }
          const { zoomPxPerSec: z, scrollUs: s } = st()
          const x1 = laneX(ev.clientX), cy1 = contentY(ev.clientY)
          const hits = itemsInBox(layoutRef.current, startUs, pxToUs(x1, z, s), cy0, cy1)
          st().select(additive ? [...initial, ...hits.filter((h) => !initial.includes(h))] : hits)
          setOverlay({ guideUs: null, ghost: null, box: { x0: usToPx(startUs, z, s), y0: cy0, x1, y1: cy1 } })
        }
        onEnd = (commit) => {
          if (!commit) st().select(before)
          else if (!started && !additive) st().select([])
        }
      }

      const move = (ev: PointerEvent): void => onMove(ev)
      const up = (): void => finish(true)
      const cancel = (): void => finish(false)
      const key = (ev: KeyboardEvent): void => {
        if (ev.key !== 'Escape') return
        // Esc é do gesto: não chega ao atalho global (que desmarcaria a seleção)
        ev.preventDefault()
        ev.stopPropagation()
        finish(false)
      }
      const finish = (commit: boolean): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', cancel)
        window.removeEventListener('keydown', key, true)
        setDragCursor(null)
        active = null
        try {
          onEnd(commit)
        } finally {
          setOverlay(NO_OVERLAY)
        }
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', cancel)
      window.addEventListener('keydown', key, true)
      active = { end: finish }
    },
    [scrollerRef, layoutRef, setOverlay]
  )

  const onContextMenu = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const target = e.target as HTMLElement
      if (target.closest('[data-track-header]')) return
      e.preventDefault()
      const id = target.closest<HTMLElement>('[data-item-id]')?.dataset.itemId
      if (!id || active) return
      if (!st().selection.includes(id)) st().select([id])
      onItemMenu(id, e.clientX, e.clientY)
    },
    [onItemMenu]
  )

  return { onPointerDown, onContextMenu }
}

/** Sombra do arraste: vermelha onde o item cairia se a soltura for inválida; tracejada na área de faixa nova. */
function moveGhost(base: Project, L: Layout, draggedId: string, plan: MovePlan): Ghost | null {
  const f = findItem(base, draggedId)
  if (!f) return null
  const startUs = f.item.startUs + plan.deltaUs
  const durationUs = f.item.durationUs
  if (plan.newTrackKind === 'video') return { y: 2, h: TOP_PAD - 4, startUs, durationUs, tone: 'new' }
  if (plan.newTrackKind === 'audio') {
    const last = L.rows[L.rows.length - 1]
    return { y: (last ? last.y + last.h : TOP_PAD) + 4, h: ROW_H.audio - 8, startUs, durationUs, tone: 'new' }
  }
  if (plan.error) {
    const row = L.rows.find((r) => r.track.id === plan.trackId)
    return row ? { y: row.y + 3, h: row.h - 6, startUs, durationUs, tone: 'invalid' } : null
  }
  return null
}
