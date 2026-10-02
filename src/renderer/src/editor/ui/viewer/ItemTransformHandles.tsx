import { evalAnim, setValue } from '@shared/editor/anim'
import { findItem, updateItem } from '@shared/editor/ops'
import type { MediaItem, Project, VisualProps } from '@shared/editor/project'
import { cn } from '@/lib/cn'
import { useEditorStore } from '../../state/editorStore'
import { cornerScale, rotateAngle, snapCenter, type Corner, type Guides, type ItemBox, type Pt } from '../viewerGeometry'
import { startViewerGesture } from './viewerGesture'

// Manipulação direta de mídia no visualizador (F1): arrastar move, cantos escalam (Shift mantém o
// centro), alça de cima gira (Shift: 15°). Cada gesto é uma transação. Guias de centro com snap a
// 0,5 ± 1 %. O contorno do selecionado é desenhado pelo render worker.

type V = MediaItem & { visual: VisualProps }
export type ItemGesture = { kind: 'move' } | { kind: 'scale'; corner: Corner } | { kind: 'rotate' }

export interface GestureCtx {
  toCanvas: (e: { clientX: number; clientY: number }) => Pt
  /** px de tela por px do canvas do projeto */
  scale: number
  setGuides: (g: Guides) => void
}

const NO_GUIDES: Guides = { v: [], h: [] }
const CORNERS: Corner[] = ['tl', 'tr', 'bl', 'br']
const CORNER_CURSOR: Record<Corner, string> = { tl: 'nwse-resize', br: 'nwse-resize', tr: 'nesw-resize', bl: 'nesw-resize' }

/** Item editável por manipulação: mídia em faixa de vídeo desbloqueada. */
export function editableMedia(p: Project, itemId: string): V | null {
  const f = findItem(p, itemId)
  if (!f || f.track.locked || f.track.kind !== 'video' || f.item.type !== 'media' || !f.item.visual) return null
  return f.item as V
}

export function startItemTransform(e: React.PointerEvent, box: ItemBox, g: ItemGesture, ctx: GestureCtx): void {
  const st = useEditorStore.getState()
  const p = st.project
  const item = p && editableMedia(p, box.itemId)
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
  const from = ctx.toCanvas(e)
  const center = { x: box.cx, y: box.cy }

  const write = (base: Project, patch: { x?: number; y?: number; scale?: number; rotation?: number }): boolean =>
    useEditorStore.getState().apply(
      () =>
        updateItem<V>(base, item.id, (d) => {
          const tr = d.visual.transform
          for (const k of ['x', 'y', 'scale', 'rotation'] as const) {
            const v = patch[k]
            if (v !== undefined) tr[k] = setValue(tr[k], local, v)
          }
        }),
      { transient: true }
    )

  startViewerGesture(e, {
    move: (ev, base) => {
      const now = ctx.toCanvas(ev)
      if (g.kind === 'move') {
        const sx = snapCenter(x0 + offX + (now.x - from.x) / W)
        const sy = snapCenter(y0 + offY + (now.y - from.y) / H)
        ctx.setGuides({ v: sx.snapped ? [0.5] : [], h: sy.snapped ? [0.5] : [] })
        return write(base, { x: sx.value - offX, y: sy.value - offY })
      }
      if (g.kind === 'scale') {
        const r = cornerScale(box, g.corner, now, ev.shiftKey)
        return write(base, { scale: Math.max(0.01, s0 * r.factor), ...(ev.shiftKey ? {} : { x: r.cx / W - offX, y: r.cy / H - offY }) })
      }
      return write(base, { rotation: rotateAngle(center, from, now, r0, ev.shiftKey) })
    },
    end: () => ctx.setGuides(NO_GUIDES)
  })
}

/** Alças do item selecionado. A de rotação fica acima da caixa, ou por dentro se a borda de cima estiver rente ao palco. */
// O corpo não recebe cliques (pointer-events-none): o clique no interior vai para o fundo do
// visualizador, que testa as regiões de efeito primeiro e só então move a mídia sob o ponteiro.
export function ItemTransformHandles({ box, k, onGesture }: { box: ItemBox; k: number; onGesture: (e: React.PointerEvent, box: ItemBox, g: ItemGesture) => void }): React.JSX.Element {
  const inside = box.cy * k - (box.h * k) / 2 < 24
  return (
    <div
      data-media-handles={box.itemId}
      className="pointer-events-none absolute"
      style={{ left: box.cx * k - (box.w * k) / 2, top: box.cy * k - (box.h * k) / 2, width: box.w * k, height: box.h * k, transform: `rotate(${box.rotation}deg)` }}
    >
      <div className={cn('pointer-events-none absolute left-1/2 top-0 h-5 w-px -translate-x-1/2 bg-accent/80', !inside && '-translate-y-full')} />
      <button
        type="button"
        aria-label="Girar (Shift: passos de 15°)"
        title="Girar (Shift: passos de 15°)"
        className={cn('pointer-events-auto absolute left-1/2 top-0 h-3.5 w-3.5 -translate-x-1/2 cursor-grab rounded-full border-2 border-accent bg-fg shadow', inside ? 'translate-y-5' : '-translate-y-[calc(100%+20px)]')}
        onPointerDown={(e) => onGesture(e, box, { kind: 'rotate' })}
      />
      {CORNERS.map((c) => (
        <button
          key={c}
          type="button"
          aria-label="Redimensionar (Shift: a partir do centro)"
          title="Redimensionar (Shift: a partir do centro)"
          className="pointer-events-auto absolute h-3 w-3 rounded-[3px] border-2 border-accent bg-fg shadow"
          style={{
            cursor: CORNER_CURSOR[c],
            left: c.endsWith('l') ? -6 : undefined,
            right: c.endsWith('r') ? -6 : undefined,
            top: c.startsWith('t') ? -6 : undefined,
            bottom: c.startsWith('b') ? -6 : undefined
          }}
          onPointerDown={(e) => onGesture(e, box, { kind: 'scale', corner: c })}
        />
      ))}
    </div>
  )
}
