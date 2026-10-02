import { useCallback } from 'react'
import { toast } from 'sonner'
import type { AnimPath } from '@shared/editor/animPaths'
import { findItem, projectDurationUs } from '@shared/editor/ops'
import type { Project, Us } from '@shared/editor/project'
import { formatTimecodeUs, itemEndUs } from '@shared/editor/time'
import type { SnapPoint } from '@shared/editor/snap'
import { useEditorStore } from '../../state/editorStore'
import { useCurveEditor } from '../../state/keyframeLanes'
import { concreteRefs, keysInLaneBox, shiftSelKeys, toggleKey, useKeyframeSelection, type SelKey } from '../../state/keyframeSelection'
import { edgeScrollPx, gestureSnapPoints, planFade, planKeyframeDrag, planMove, planTrim, type MoveInput, type MovePlan } from './dragMath'
import { HEADER_W, itemsInBox, laneAt, lanePaths, ROW_H, TOP_PAD, zoneAt, type Layout } from './layout'
import { pxToDurUs, pxToUs, SNAP_PX, usToPx } from '../../state/zoom'

// Gestos da linha do tempo com Pointer Events, por delegação (um handler para todos os itens):
//  • corpo do item → mover (com vinculados; Alt ignora o vínculo; outra faixa do mesmo tipo muda a faixa;
//    acima da 1ª de vídeo / abaixo da última de áudio cria faixa nova ao soltar)
//  • borda do item (data-edge) → trim (Ctrl = ripple; Alt ignora o vínculo)
//  • alça de fade (data-fade) → fade de entrada/saída
//  • losango de keyframe (data-keyframe: combinado; data-lane-key: linha de uma propriedade) → clique leva o
//    playhead ao key e o seleciona (Shift/Ctrl soma/tira); arrastar move o losango — ou todos os selecionados,
//    se ele está entre eles — no quadro, preso ao item (soltar sobre outro key o substitui)
//  • fundo das linhas de keyframes (data-lanes-item) → caixa seleciona os keys (Shift/Ctrl soma)
//  • fundo → seleção por caixa (Ctrl/Shift soma); clique simples no fundo limpa a seleção
// Mover/trim/fade: transação aberta ao passar do limiar; cada evento recalcula a partir da base da
// transação (lida do store a cada evento: patches de ingestão no meio do gesto entram nela) com
// apply transitório; pointerup = commitTx (um passo de desfazer); Esc/pointercancel/perda de foco ou
// transação encerrada por fora = cancela. Durante o gesto o teclado é do gesto (só Esc e
// modificadores). Perto das bordas a vista rola sozinha (rAF) e o gesto se recalcula.

const MOVE_THRESHOLD_PX = 3
const TRIM_THRESHOLD_PX = 2
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock'])

export interface Ghost { y: number; h: number; startUs: Us; durationUs: Us; tone: 'new' | 'invalid' }
export interface DragOverlay {
  guideUs: Us | null
  ghost: Ghost | null
  /** Caixa de seleção: x em px da área das faixas, y no conteúdo (com scrollTop). */
  box: { x0: number; y0: number; x1: number; y1: number } | null
  /** Dica durante o gesto (ex.: duração do fade), no instante `us` e na altura `y` do conteúdo. */
  label: { us: Us; y: number; text: string } | null
}
export const NO_OVERLAY: DragOverlay = { guideUs: null, ghost: null, box: null, label: null }

interface Opts {
  scrollerRef: React.RefObject<HTMLDivElement | null>
  layoutRef: React.RefObject<Layout>
  setOverlay: (o: DragOverlay) => void
  onItemMenu: (itemId: string, clientX: number, clientY: number) => void
  /** Leva o playhead a `us` (clique num losango de keyframe). */
  onSeek: (us: Us) => void
}

const st = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()
const secLabel = (us: Us): string => `${(us / 1e6).toFixed(2).replace('.', ',')} s`

/** Cursor do gesto em toda a janela (styles.css: body[data-drag-cursor] * herda o cursor do body). */
export function setDragCursor(c: string | null): void {
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

/** Há gesto em andamento (o atalho global de teclado não roda). */
export const gestureActive = (): boolean => active !== null

export function useTimelineDrag({ scrollerRef, layoutRef, setOverlay, onItemMenu, onSeek }: Opts): {
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
      const deltaAt = (ev: PointerEvent): Us => pxToUs(laneX(ev.clientX), st().zoomPxPerSec, st().scrollUs) - startUs
      let started = false
      let autoScroll = false // a vista rola sozinha perto das bordas (mover, trim, caixa)
      let onMove: (ev: PointerEvent) => void = () => {}
      let onEnd: (commit: boolean) => void = () => {}
      /** Base da transação, lida do store a cada evento; null = transação encerrada por fora → cancela. */
      const txBase = (): Project | null => {
        const b = st().txBase
        if (!b) finish(false)
        return b
      }
      /** Abre a transação no limiar. */
      const begin = (cursor: string): Project | null => {
        started = true
        st().begin()
        setDragCursor(cursor)
        return st().txBase
      }

      const itemEl = target.closest<HTMLElement>('[data-item-id]')
      const edge = target.closest<HTMLElement>('[data-edge]')?.dataset.edge as 'start' | 'end' | undefined
      const fade = target.closest<HTMLElement>('[data-fade]')?.dataset.fade as 'in' | 'out' | undefined
      const kfAttr = target.closest<HTMLElement>('[data-keyframe]')?.dataset.keyframe
      const lanesEl = target.closest<HTMLElement>('[data-lanes-item]')
      const laneKeyEl = target.closest<HTMLElement>('[data-lane-key]')
      const id = itemEl?.dataset.itemId ?? lanesEl?.dataset.lanesItem
      // losango: o combinado (todas as propriedades no instante) ou o de uma linha
      const kfKey: SelKey | null = laneKeyEl ? { path: laneKeyEl.dataset.path as AnimPath, tUs: Number(laneKeyEl.dataset.laneKey) } : kfAttr !== undefined ? { path: null, tUs: Number(kfAttr) } : null
      // qualquer outro gesto solta os losangos selecionados (Delete volta a apagar o item)
      if (!(id && (kfKey || lanesEl))) useKeyframeSelection.getState().set(null)
      const selectOnly = (itemId: string): void => {
        const sel = st().selection
        if (!(sel.length === 1 && sel[0] === itemId)) st().select([itemId])
      }

      if (id && kfKey) {
        // ---------------- losango de keyframe (combinado ou de uma linha)
        const fromUs = kfKey.tUs
        const setKf = useKeyframeSelection.getState().set
        selectOnly(id) // antes de ler a seleção de losangos: trocar de item a limpa
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          setKf(toggleKey(useKeyframeSelection.getState().sel, id, kfKey))
          return
        }
        // arrastar um losango que já está numa seleção de vários leva o grupo junto
        const prev = useKeyframeSelection.getState().sel
        const inGroup = !!prev && prev.itemId === id && prev.keys.length > 1 && prev.keys.some((k) => k.path === kfKey.path && Math.abs(k.tUs - fromUs) <= 1)
        const group = inGroup ? prev.keys : [kfKey]
        setKf({ itemId: id, keys: group })
        const startItem = findItem(st().project!, id)?.item
        // combinado sozinho: todos os keys do instante (moveKeyframes); senão exatamente os keys escolhidos
        const refs = !startItem || (group.length === 1 && kfKey.path === null) ? undefined : concreteRefs(startItem, group)
        let failed: string | null = null
        let toUs = fromUs
        autoScroll = true
        onMove = (ev) => {
          if (!started) {
            if (Math.abs(ev.clientX - x0) < TRIM_THRESHOLD_PX) return
            if (!begin('ew-resize')) return finish(false)
          }
          const base = txBase()
          if (!base) return
          const r = planKeyframeDrag(base, { itemId: id, fromUs, deltaUs: deltaAt(ev), keys: refs })
          failed = r.error?.message ?? null
          toUs = r.toUs
          st().apply(() => r.project ?? base, { transient: true })
          const f = findItem(base, id)
          const row = f ? layoutRef.current.rows.find((x) => x.track.id === f.track.id) : undefined
          const at = f ? f.item.startUs + toUs : 0
          setOverlay({ ...NO_OVERLAY, label: row ? { us: at, y: row.y, text: `Keyframe: ${formatTimecodeUs(at, base.canvas.fps)}` } : null })
        }
        onEnd = (commit) => {
          const f = findItem(st().txBase ?? st().project!, id)
          if (!started) {
            if (commit && f) onSeek(f.item.startUs + fromUs)
            return
          }
          if (commit && !failed) {
            st().commitTx()
            useKeyframeSelection.getState().set({ itemId: id, keys: shiftSelKeys(group, toUs - fromUs) })
          } else st().cancelTx()
          if (commit && failed) toast.error(failed)
        }
      } else if (id && lanesEl) {
        // ---------------- caixa de seleção no fundo das linhas de keyframes do item
        selectOnly(id)
        const prev = useKeyframeSelection.getState().sel
        const before = prev?.itemId === id ? prev : null
        const additive = e.ctrlKey || e.metaKey || e.shiftKey
        const f = findItem(st().project!, id)
        const row = f ? layoutRef.current.rows.find((r) => r.track.id === f.track.id) : undefined
        if (!f || !row) return
        const item = f.item
        const paths = lanePaths(item)
        const lane = (y: number): number => Math.min(paths.length - 1, laneAt(row, y, true) ?? 0)
        const cy0 = contentY(y0)
        autoScroll = true
        onMove = (ev) => {
          if (!started) {
            if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < MOVE_THRESHOLD_PX) return
            started = true
          }
          const { zoomPxPerSec: z, scrollUs: s } = st()
          const x1 = laneX(ev.clientX), cy1 = contentY(ev.clientY)
          const hits = keysInLaneBox(item, paths, startUs - item.startUs, pxToUs(x1, z, s) - item.startUs, lane(cy0), lane(cy1))
          const keys = additive && before ? [...before.keys, ...hits.filter((h) => !before.keys.some((k) => k.path === h.path && Math.abs(k.tUs - h.tUs) <= 1))] : hits
          useKeyframeSelection.getState().set(keys.length ? { itemId: id, keys } : null)
          setOverlay({ ...NO_OVERLAY, box: { x0: usToPx(startUs, z, s), y0: cy0, x1, y1: cy1 } })
        }
        onEnd = (commit) => {
          if (!commit) useKeyframeSelection.getState().set(before)
          else if (!started && !additive) useKeyframeSelection.getState().set(null)
        }
      } else if (id && fade) {
        // ---------------- fade (alça no canto superior)
        if (!st().selection.includes(id)) st().select([id])
        let failed: string | null = null
        onMove = (ev) => {
          if (!started) {
            if (Math.abs(ev.clientX - x0) < 1) return
            if (!begin('ew-resize')) return finish(false)
          }
          const base = txBase()
          if (!base) return
          const r = planFade(base, { itemId: id, side: fade, deltaUs: deltaAt(ev) })
          failed = r.error?.message ?? null
          st().apply(() => r.project ?? base, { transient: true })
          const f = findItem(base, id)
          const row = f ? layoutRef.current.rows.find((x) => x.track.id === f.track.id) : undefined
          const at = f ? (fade === 'in' ? f.item.startUs + r.fadeUs : itemEndUs(f.item) - r.fadeUs) : 0
          setOverlay({ ...NO_OVERLAY, label: row ? { us: at, y: row.y, text: `${fade === 'in' ? 'Fade de entrada' : 'Fade de saída'}: ${secLabel(r.fadeUs)}` } : null })
        }
        onEnd = (commit) => {
          if (!started) return
          if (commit && !failed) st().commitTx()
          else st().cancelTx()
          if (commit && failed) toast.error(failed)
        }
      } else if (id && edge) {
        // ---------------- trim
        if (!st().selection.includes(id)) st().select([id])
        let points: { linked: SnapPoint[]; alt: SnapPoint[] } | null = null
        let failed: string | null = null
        autoScroll = true
        onMove = (ev) => {
          if (!started) {
            if (Math.abs(ev.clientX - x0) < TRIM_THRESHOLD_PX) return
            const b = begin('ew-resize')
            if (!b) return finish(false)
            points = { linked: gestureSnapPoints(b, st().playheadUs, [id], true), alt: gestureSnapPoints(b, st().playheadUs, [id], false) }
          }
          const base = txBase()
          if (!base || !points) return
          const r = planTrim(base, {
            itemId: id,
            edge,
            deltaUs: deltaAt(ev),
            ripple: ev.ctrlKey || ev.metaKey,
            includeLinked: !ev.altKey,
            snap: st().snapping ? { points: ev.altKey ? points.alt : points.linked, toleranceUs: toleranceUs() } : null
          })
          failed = r.error?.message ?? null
          st().apply(() => r.project ?? base, { transient: true })
          setOverlay({ ...NO_OVERLAY, guideUs: r.guideUs })
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
        let points: { linked: SnapPoint[]; alt: SnapPoint[] } | null = null
        let last: { input: MoveInput; plan: MovePlan } | null = null
        autoScroll = true
        onMove = (ev) => {
          if (!started) {
            if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < MOVE_THRESHOLD_PX) return
            const b = begin('grabbing')
            if (!b) return finish(false)
            points = { linked: gestureSnapPoints(b, st().playheadUs, ids, true), alt: gestureSnapPoints(b, st().playheadUs, ids, false) }
          }
          const base = txBase()
          if (!base || !points) return
          const input: MoveInput = {
            draggedId: id,
            ids,
            deltaUs: deltaAt(ev),
            zone: zoneAt(layoutRef.current, contentY(ev.clientY)),
            includeLinked: !ev.altKey,
            snap: st().snapping ? { points: ev.altKey ? points.alt : points.linked, toleranceUs: toleranceUs() } : null,
            preview: true
          }
          const plan = planMove(base, input)
          last = { input, plan }
          st().apply(() => plan.project ?? base, { transient: true })
          setOverlay({ ...NO_OVERLAY, guideUs: plan.guideUs, ghost: moveGhost(base, layoutRef.current, id, plan) })
        }
        onEnd = (commit) => {
          if (!started) {
            // clique sem arrastar num item já selecionado: fica só ele
            if (commit && wasSelected) st().select([id])
            return
          }
          const base = st().txBase
          if (!commit || !last || last.plan.error || !base) {
            st().cancelTx()
            if (commit && last?.plan.error) toast.error(last.plan.error.message)
            return
          }
          if (last.plan.newTrackKind) {
            const final = planMove(base, { ...last.input, preview: false })
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
        autoScroll = true
        onMove = (ev) => {
          if (!started) {
            if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < MOVE_THRESHOLD_PX) return
            started = true
          }
          const { zoomPxPerSec: z, scrollUs: s } = st()
          const x1 = laneX(ev.clientX), cy1 = contentY(ev.clientY)
          const hits = itemsInBox(layoutRef.current, startUs, pxToUs(x1, z, s), cy0, cy1)
          st().select(additive ? [...initial, ...hits.filter((h) => !initial.includes(h))] : hits)
          setOverlay({ ...NO_OVERLAY, box: { x0: usToPx(startUs, z, s), y0: cy0, x1, y1: cy1 } })
        }
        onEnd = (commit) => {
          if (!commit) st().select(before)
          else if (!started && !additive) st().select([])
        }
      }

      // rolagem automática perto das bordas: rola e recalcula o gesto com o último evento.
      // `done` (deste gesto, não o `active` global): um rAF que sobrou de um gesto encerrado nunca roda
      let lastEv: PointerEvent | null = null
      let raf = 0
      let done = false
      const tick = (): void => {
        raf = 0
        if (done || !lastEv || !started) return
        const viewW = scroller.clientWidth - HEADER_W
        const dpx = edgeScrollPx(laneX(lastEv.clientX), viewW)
        if (dpx === 0) return
        const s = st()
        const spanUs = pxToDurUs(viewW, s.zoomPxPerSec)
        const p = s.txBase ?? s.project
        const limit = Math.max(s.scrollUs, (p ? projectDurationUs(p) : 0) + spanUs / 2)
        const next = Math.min(limit, Math.max(0, s.scrollUs + pxToDurUs(dpx, s.zoomPxPerSec)))
        if (next === s.scrollUs) return
        s.setScroll(next)
        onMove(lastEv)
        // o recálculo pode ter encerrado o gesto (transação fechada por fora)
        if (!done) raf = requestAnimationFrame(tick)
      }

      const move = (ev: PointerEvent): void => {
        lastEv = ev
        onMove(ev)
        if (autoScroll && !done && !raf) raf = requestAnimationFrame(tick)
      }
      const up = (): void => finish(true)
      const cancel = (): void => finish(false)
      const key = (ev: KeyboardEvent): void => {
        if (MODIFIER_KEYS.has(ev.key)) return // Alt/Ctrl mudam o gesto no próximo movimento
        // o teclado é do gesto: nenhum atalho (desfazer, apagar…) roda no meio do arraste
        ev.preventDefault()
        ev.stopPropagation()
        if (ev.key === 'Escape') finish(false)
      }
      function finish(commit: boolean): void {
        if (done) return
        done = true
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', cancel)
        window.removeEventListener('keydown', key, true)
        window.removeEventListener('blur', cancel)
        if (raf) cancelAnimationFrame(raf)
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
      window.addEventListener('blur', cancel)
      active = { end: finish }
    },
    [scrollerRef, layoutRef, setOverlay, onSeek]
  )

  const onContextMenu = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const target = e.target as HTMLElement
      if (target.closest('[data-track-header]')) return
      e.preventDefault()
      const laneKey = target.closest<HTMLElement>('[data-lane-key]')
      const id = target.closest<HTMLElement>('[data-item-id]')?.dataset.itemId ?? target.closest<HTMLElement>('[data-lanes-item]')?.dataset.lanesItem
      if (!id || active) return
      if (laneKey) {
        // botão direito num losango de uma linha: editor de curvas do trecho que começa nele
        if (!st().selection.includes(id)) st().select([id])
        useCurveEditor.getState().open({ itemId: id, path: laneKey.dataset.path as AnimPath, tUs: Number(laneKey.dataset.laneKey), x: e.clientX, y: e.clientY })
        return
      }
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
