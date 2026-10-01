import { useMemo, useRef, useState } from 'react'
import { evalAnim, setValue } from '@shared/editor/anim'
import { findItem, updateItem } from '@shared/editor/ops'
import type { MediaItem, Project, VisualProps } from '@shared/editor/project'
import { cn } from '@/lib/cn'
import { useEditorStore } from '../state/editorStore'
import { cornerScale, hitTest, itemBoxes, rotateAngle, snapCenter, type Corner, type ItemBox, type Pt } from './viewerGeometry'

// Manipulação direta no visualizador: clique seleciona (Ctrl/Shift alterna), arrastar move, cantos
// escalam (Shift mantém o centro), alça de cima gira (Shift: 15°). Cada gesto é uma transação.
// Guias de centro com snap a 0,5 ± 1 %. O contorno do selecionado é desenhado pelo render worker.

type V = MediaItem & { visual: VisualProps }
type Gesture = { kind: 'move' } | { kind: 'scale'; corner: Corner } | { kind: 'rotate' }

const CORNERS: Corner[] = ['tl', 'tr', 'bl', 'br']
const CORNER_CURSOR: Record<Corner, string> = {
  tl: 'nwse-resize',
  br: 'nwse-resize',
  tr: 'nesw-resize',
  bl: 'nesw-resize'
}

/** Item editável por manipulação: mídia em faixa de vídeo desbloqueada. */
function editable(p: Project, itemId: string): V | null {
  const f = findItem(p, itemId)
  if (!f || f.track.locked || f.track.kind !== 'video' || f.item.type !== 'media' || !f.item.visual) return null
  return f.item as V
}

export function ViewerOverlay({ width, height, scale }: { width: number; height: number; scale: number }): React.JSX.Element | null {
  const project = useEditorStore((s) => s.project)
  const playheadUs = useEditorStore((s) => s.playheadUs)
  const selection = useEditorStore((s) => s.selection)
  const playing = useEditorStore((s) => s.playing)
  const [guides, setGuides] = useState({ x: false, y: false })
  const rootRef = useRef<HTMLDivElement>(null)
  const boxes = useMemo(() => (project ? itemBoxes(project, playheadUs) : []), [project, playheadUs])
  if (!project) return null
  const selected = selection.length === 1 && !playing ? boxes.find((b) => b.itemId === selection[0] && editable(project, b.itemId)) : undefined

  const toCanvas = (e: { clientX: number; clientY: number }): Pt => {
    const r = rootRef.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }
  }

  const startGesture = (e: React.PointerEvent, box: ItemBox, g: Gesture): void => {
    const st = useEditorStore.getState()
    const p = st.project
    const item = p && editable(p, box.itemId)
    if (!p || !item) return
    e.stopPropagation()
    e.preventDefault()
    const W = p.canvas.width
    const H = p.canvas.height
    const local = Math.min(Math.max(0, st.playheadUs - item.startUs), item.durationUs)
    const t = item.visual.transform
    const x0 = evalAnim(t.x, local)
    const y0 = evalAnim(t.y, local)
    const s0 = evalAnim(t.scale, local)
    const r0 = evalAnim(t.rotation, local)
    // deslocamento de animações de entrada/saída entre o valor base e o centro desenhado
    const offX = box.cx / W - x0
    const offY = box.cy / H - y0
    const from = toCanvas(e)
    const center = { x: box.cx, y: box.cy }
    let started = false

    const write = (patch: { x?: number; y?: number; scale?: number; rotation?: number }): void => {
      useEditorStore.getState().apply(
        (q) =>
          updateItem<V>(q, item.id, (d) => {
            const tr = d.visual.transform
            for (const k of ['x', 'y', 'scale', 'rotation'] as const) {
              const v = patch[k]
              if (v !== undefined) tr[k] = setValue(tr[k], local, v)
            }
          }),
        { transient: true }
      )
    }
    const move = (ev: PointerEvent): void => {
      const now = toCanvas(ev)
      if (!started) {
        if (Math.hypot(now.x - from.x, now.y - from.y) * scale < 2) return
        started = true
        useEditorStore.getState().begin()
      }
      if (g.kind === 'move') {
        const sx = snapCenter(x0 + offX + (now.x - from.x) / W)
        const sy = snapCenter(y0 + offY + (now.y - from.y) / H)
        setGuides({ x: sx.snapped, y: sy.snapped })
        write({ x: sx.value - offX, y: sy.value - offY })
      } else if (g.kind === 'scale') {
        const r = cornerScale(box, g.corner, now, ev.shiftKey)
        write({
          scale: Math.max(0.01, s0 * r.factor),
          ...(ev.shiftKey ? {} : { x: r.cx / W - offX, y: r.cy / H - offY })
        })
      } else {
        write({ rotation: rotateAngle(center, from, now, r0, ev.shiftKey) })
      }
    }
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', esc, true)
      setGuides({ x: false, y: false })
      if (!started) return
      if (commit) useEditorStore.getState().commitTx()
      else useEditorStore.getState().cancelTx()
    }
    const up = (): void => finish(true)
    const cancel = (): void => finish(false)
    const esc = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return
      ev.stopPropagation()
      finish(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', esc, true)
  }

  const onBackgroundDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const pt = toCanvas(e)
    const hit = hitTest(boxes, pt.x, pt.y)
    const st = useEditorStore.getState()
    if (!hit) {
      if (!e.ctrlKey && !e.shiftKey) st.select([])
      return
    }
    if (e.ctrlKey || e.shiftKey) {
      st.select([hit], 'toggle')
      return
    }
    st.select([hit])
    const box = boxes.find((b) => b.itemId === hit)
    if (box && !playing) startGesture(e, box, { kind: 'move' })
  }

  const k = scale
  return (
    <div ref={rootRef} className="absolute inset-0" style={{ width, height }} onPointerDown={onBackgroundDown}>
      {guides.x ? <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-accent/80" /> : null}
      {guides.y ? <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-accent/80" /> : null}
      {selected ? <SelectionHandles box={selected} k={k} onGesture={startGesture} /> : null}
    </div>
  )
}

/** Alças do item selecionado. A de rotação fica acima da caixa, ou por dentro se a borda de cima estiver rente ao palco. */
function SelectionHandles({ box: selected, k, onGesture: startGesture }: { box: ItemBox; k: number; onGesture: (e: React.PointerEvent, box: ItemBox, g: Gesture) => void }): React.JSX.Element {
  const inside = selected.cy * k - (selected.h * k) / 2 < 24
  return (
    <div
      className="absolute cursor-move"
      style={{
        left: selected.cx * k - (selected.w * k) / 2,
        top: selected.cy * k - (selected.h * k) / 2,
        width: selected.w * k,
        height: selected.h * k,
        transform: `rotate(${selected.rotation}deg)`
      }}
      onPointerDown={(e) => {
        if (e.button === 0 && !e.ctrlKey && !e.shiftKey) startGesture(e, selected, { kind: 'move' })
      }}
    >
      <div className={cn('pointer-events-none absolute left-1/2 top-0 h-5 w-px -translate-x-1/2 bg-accent/80', !inside && '-translate-y-full')} />
      <button
        type="button"
        aria-label="Girar (Shift: passos de 15°)"
        title="Girar (Shift: passos de 15°)"
        className={cn('absolute left-1/2 top-0 h-3.5 w-3.5 -translate-x-1/2 cursor-grab rounded-full border-2 border-accent bg-fg shadow', inside ? 'translate-y-5' : '-translate-y-[calc(100%+20px)]')}
        onPointerDown={(e) => startGesture(e, selected, { kind: 'rotate' })}
      />
      {CORNERS.map((c) => (
        <button
          key={c}
          type="button"
          aria-label="Redimensionar (Shift: a partir do centro)"
          title="Redimensionar (Shift: a partir do centro)"
          className="absolute h-3 w-3 rounded-[3px] border-2 border-accent bg-fg shadow"
          style={{
            cursor: CORNER_CURSOR[c],
            left: c.endsWith('l') ? -6 : undefined,
            right: c.endsWith('r') ? -6 : undefined,
            top: c.startsWith('t') ? -6 : undefined,
            bottom: c.startsWith('b') ? -6 : undefined
          }}
          onPointerDown={(e) => startGesture(e, selected, { kind: 'scale', corner: c })}
        />
      ))}
    </div>
  )
}
