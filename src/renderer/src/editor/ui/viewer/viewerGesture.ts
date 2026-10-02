import type { Project } from '@shared/editor/project'
import { useEditorStore } from '../../state/editorStore'
import { setDragCursor } from '../timeline/useTimelineDrag'

// Gestos do visualizador (mesmo contrato da linha do tempo): transação aberta ao passar do limiar;
// cada movimento recalcula a partir da base da transação (lida do store a cada evento) com apply
// transitório; pointerup = commitTx (um passo de desfazer); Esc, pointercancel, perda de foco ou
// transação encerrada por fora = cancela. Durante o gesto o teclado é do gesto: só Esc e os
// modificadores (Shift/Alt mudam o gesto na hora, mesmo sem mover o ponteiro).

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock'])

export interface GesturePoint {
  clientX: number
  clientY: number
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
}

export interface ViewerGesture {
  /** Depois do limiar, a cada movimento (ou mudança de modificador). false = aborta (cancela). */
  move(pt: GesturePoint, base: Project): boolean | void
  /** Fim do gesto, depois do commit/cancelamento; started = passou do limiar. */
  end?(commit: boolean, started: boolean): void
  cursor?: string
  thresholdPx?: number
}

let active: { end: (commit: boolean) => void } | null = null

/** Há gesto do visualizador em andamento (o atalho global de teclado não roda). */
export const viewerGestureActive = (): boolean => active !== null

/** Cancela o gesto em andamento (ex.: o visualizador saiu da tela no meio do arraste). */
export function cancelViewerGesture(): void {
  active?.end(false)
}

export function startViewerGesture(e: { clientX: number; clientY: number }, g: ViewerGesture): void {
  if (active) return
  const st = useEditorStore.getState
  const x0 = e.clientX
  const y0 = e.clientY
  const threshold = g.thresholdPx ?? 2
  let started = false
  let done = false
  let last: GesturePoint | null = null

  const run = (pt: GesturePoint): void => {
    const base = st().txBase
    if (!base) return finish(false)
    if (g.move(pt, base) === false) finish(false)
  }
  const point = (ev: PointerEvent): GesturePoint => ({ clientX: ev.clientX, clientY: ev.clientY, shiftKey: ev.shiftKey, altKey: ev.altKey, ctrlKey: ev.ctrlKey })
  const move = (ev: PointerEvent): void => {
    last = point(ev)
    if (!started) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < threshold) return
      started = true
      st().begin()
      if (g.cursor) setDragCursor(g.cursor)
    }
    run(last)
  }
  const key = (ev: KeyboardEvent): void => {
    if (MODIFIER_KEYS.has(ev.key)) {
      if (started && last) {
        last = { ...last, shiftKey: ev.shiftKey, altKey: ev.altKey, ctrlKey: ev.ctrlKey }
        run(last)
      }
      if (ev.key === 'Alt') ev.preventDefault() // Alt sozinho não pode levar o foco para o menu da janela
      return
    }
    if (ev.type === 'keyup') return
    ev.preventDefault()
    ev.stopPropagation()
    if (ev.key === 'Escape') finish(false)
  }
  const up = (): void => finish(true)
  const cancel = (): void => finish(false)
  function finish(commit: boolean): void {
    if (done) return
    done = true
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('keydown', key, true)
    window.removeEventListener('keyup', key, true)
    window.removeEventListener('blur', cancel)
    setDragCursor(null)
    active = null
    if (started) {
      if (commit) st().commitTx()
      else st().cancelTx()
    }
    g.end?.(commit, started)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', key, true)
  window.addEventListener('keyup', key, true)
  window.addEventListener('blur', cancel)
  active = { end: finish }
}
