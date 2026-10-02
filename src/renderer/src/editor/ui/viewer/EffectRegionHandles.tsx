import { addEffect, findItem } from '@shared/editor/ops'
import { attachedMedia } from '@shared/editor/resolve'
import type { Project, Us } from '@shared/editor/project'
import { frameDurUs } from '@shared/editor/time'
import { cn } from '@/lib/cn'
import { useEditorStore } from '../../state/editorStore'
import { useViewerTool } from '../../state/viewerTool'
import { dragToRegion, keyframeAt, MIN_REGION, regionBoxOf, resizeRegion, rotateAngle, snapRegion, snapResize, writeRegion, type Guides, type RegionBox, type RegionHandle, type RegionValues } from '../viewerGeometry'
import type { GestureCtx } from './ItemTransformHandles'
import { startViewerGesture } from './viewerGesture'

// Regiões dos efeitos de privacidade no visualizador: a ferramenta "Desenhar região" cria o efeito
// arrastando (Shift: elipse; Alt: a partir do centro); o efeito selecionado mostra a região com alças
// (cantos/bordas redimensionam — Shift mantém a proporção, Alt a partir do centro —, alça de cima
// gira — Shift: 15° —, arrastar o interior move), guias de centro/bordas do quadro com snap de 1 %.
// Propriedade animada ganha key no playhead; senão muda o valor fixo. Cada gesto = um passo de desfazer. Efeito
// ancorado: a caixa é a da tela (como o resolve desenha) e o arraste é gravado relativo ao conteúdo (writeRegion).

export type RegionGesture = { kind: 'move' } | { kind: 'resize'; handle: RegionHandle } | { kind: 'rotate' }

const NO_GUIDES: Guides = { v: [], h: [] }
const HANDLES: RegionHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const RESIZE_CURSORS = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'] // 0°, 45°, 90°, 135°
const HANDLE_ANGLE: Record<RegionHandle, number> = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 }

/** Cursor de redimensionar que acompanha a rotação da região. */
function resizeCursor(h: RegionHandle, rotation: number): string {
  const a = ((HANDLE_ANGLE[h] + rotation) % 180 + 180) % 180
  return RESIZE_CURSORS[Math.round(a / 45) % 4]
}

/**
 * Efeito selecionado com a região no playhead (null se não é efeito ou o playhead está fora do item).
 * inactive: desativado ou em faixa oculta (não aparece no quadro) — só contorno cinza, sem alças.
 */
export function selectedRegion(p: Project, itemId: string, tUs: Us): { box: RegionBox; locked: boolean; inactive: boolean; keyed: boolean } | null {
  const f = findItem(p, itemId)
  if (!f || f.item.type !== 'effect') return null
  const local = tUs - f.item.startUs
  if (local < 0 || local >= f.item.durationUs) return null
  return {
    box: regionBoxOf(p, f.item, tUs),
    locked: f.track.locked,
    // âncora perdida (clipe apagado/desativado): a caixa de reserva não se edita
    inactive: f.item.enabled === false || f.track.hidden || (!!f.item.attach && !attachedMedia(p, f.item)),
    keyed: keyframeAt(f.item, local, frameDurUs(p.canvas.fps) / 2)
  }
}

export function startRegionGesture(e: React.PointerEvent, itemId: string, g: RegionGesture, ctx: GestureCtx): void {
  const st = useEditorStore.getState()
  const p = st.project
  const f = p && findItem(p, itemId)
  if (!p || !f || f.item.type !== 'effect' || f.track.locked || f.item.enabled === false || f.track.hidden || (f.item.attach && !attachedMedia(p, f.item))) return
  const tUs = st.playheadUs
  const local = tUs - f.item.startUs
  if (local < 0 || local >= f.item.durationUs) return
  e.stopPropagation()
  e.preventDefault()
  const W = p.canvas.width
  const H = p.canvas.height
  const b0 = regionBoxOf(p, f.item, tUs)
  const v0: RegionValues = { x: b0.cx / W, y: b0.cy / H, w: b0.w / W, h: b0.h / H, rotation: b0.rotation }
  const from = ctx.toCanvas(e)

  startViewerGesture(e, {
    cursor: g.kind === 'move' ? 'move' : g.kind === 'rotate' ? 'grabbing' : resizeCursor(g.handle, b0.rotation),
    move: (ev, base) => {
      const now = ctx.toCanvas(ev)
      let next: Partial<RegionValues>
      let guides = NO_GUIDES
      if (g.kind === 'move') {
        const s = snapRegion({ ...v0, x: v0.x + (now.x - from.x) / W, y: v0.y + (now.y - from.y) / H })
        next = { x: s.x, y: s.y }
        guides = s.guides
      } else if (g.kind === 'resize') {
        let b = resizeRegion(b0, g.handle, now, { keepAspect: ev.shiftKey, fromCenter: ev.altKey, minW: MIN_REGION * W, minH: MIN_REGION * H })
        if (!ev.shiftKey) {
          const s = snapResize(b, g.handle, ev.altKey, W, H)
          b = s.box
          guides = s.guides
        }
        next = { x: b.cx / W, y: b.cy / H, w: b.w / W, h: b.h / H }
      } else {
        next = { rotation: rotateAngle({ x: b0.cx, y: b0.cy }, from, now, b0.rotation, ev.shiftKey) }
      }
      ctx.setGuides(guides)
      return useEditorStore.getState().apply(() => writeRegion(base, itemId, tUs, v0, next), { transient: true })
    },
    end: () => ctx.setGuides(NO_GUIDES)
  })
}

/** Ferramenta "Desenhar região": o arraste cria o efeito no playhead (um passo de desfazer) e o seleciona. */
export function startRegionDraw(e: React.PointerEvent, ctx: GestureCtx): void {
  const st = useEditorStore.getState()
  const p = st.project
  if (!p) return
  e.preventDefault()
  const tool = useViewerTool.getState()
  const tUs = st.playheadUs
  const before = st.selection
  const from = ctx.toCanvas(e)
  const W = p.canvas.width
  const H = p.canvas.height
  startViewerGesture(e, {
    cursor: 'crosshair',
    move: (ev, base) => {
      const region = dragToRegion(from, ctx.toCanvas(ev), W, H, { alt: ev.altKey, shift: ev.shiftKey, shape: tool.shape })
      let id = ''
      const ok = useEditorStore.getState().apply(
        () => {
          const r = addEffect(base, tool.effect, tUs, { region })
          id = r.itemId
          return r.project
        },
        { transient: true }
      )
      if (ok) useEditorStore.getState().select([id])
      return ok
    },
    end: (commit, started) => {
      if (started && !commit) useEditorStore.getState().select(before)
    }
  })
}

/** Posição/rotação da caixa da região em px de tela. */
function boxStyle(b: RegionBox, k: number): React.CSSProperties {
  return { left: b.cx * k - (b.w * k) / 2, top: b.cy * k - (b.h * k) / 2, width: b.w * k, height: b.h * k, transform: `rotate(${b.rotation}deg)` }
}

/** Contorno discreto das regiões não selecionadas (o efeito pode ser invisível, ex.: blur numa área lisa). */
export function RegionOutline({ box, k }: { box: RegionBox; k: number }): React.JSX.Element {
  return <div data-region-outline={box.itemId} className={cn('pointer-events-none absolute border border-dashed border-white/35', box.shape === 'ellipse' && 'rounded-[50%]')} style={boxStyle(box, k)} />
}

/** Efeito selecionado que não aparece no quadro (desativado/faixa oculta): contorno cinza, etiqueta, sem alças. */
function InactiveRegion({ box, k }: { box: RegionBox; k: number }): React.JSX.Element {
  return (
    <div data-region-inactive={box.itemId} className="pointer-events-none absolute" style={boxStyle(box, k)}>
      <div className={cn('absolute inset-0 border-[1.5px] border-dashed border-muted', box.shape === 'ellipse' && 'rounded-[50%]')} />
      <span className="absolute left-0 top-0 -translate-y-[calc(100%+4px)] whitespace-nowrap rounded bg-surface-3/90 px-1.5 py-0.5 text-[10px] font-medium text-fg-2 shadow">Desativado</span>
    </div>
  )
}

export function EffectRegionHandles({ box, k, locked, inactive, keyed, drawing, onGesture }: { box: RegionBox; k: number; locked: boolean; inactive: boolean; keyed: boolean; drawing: boolean; onGesture: (e: React.PointerEvent, g: RegionGesture) => void }): React.JSX.Element {
  if (inactive) return <InactiveRegion box={box} k={k} />
  const wPx = box.w * k
  const hPx = box.h * k
  const inside = box.cy * k - hPx / 2 < 24
  const handles = locked ? [] : HANDLES.filter((h) => (h === 'n' || h === 's' ? wPx >= 36 : h === 'e' || h === 'w' ? hPx >= 36 : true))
  // desenhando: o interior deixa o arraste passar para criar outra região; as alças continuam ativas
  return (
    <div
      data-region-handles={box.itemId}
      className={cn('absolute', !locked && !drawing ? 'cursor-move' : 'pointer-events-none')}
      style={boxStyle(box, k)}
      onPointerDown={(e) => {
        if (e.button === 0 && !e.ctrlKey && !e.shiftKey) onGesture(e, { kind: 'move' })
      }}
    >
      <div className="pointer-events-none absolute inset-0 border-[1.5px] border-dashed border-accent shadow-[0_0_0_1px_rgba(0,0,0,0.35)]" />
      {box.shape === 'ellipse' ? <div className="pointer-events-none absolute inset-0 rounded-[50%] border-2 border-dashed border-accent" /> : null}
      {keyed ? (
        <div
          data-keyframe-indicator
          role="img"
          aria-label="Keyframe no playhead"
          title="Keyframe no playhead"
          className="pointer-events-none absolute -left-[18px] -top-[18px] h-2.5 w-2.5 rotate-45 border border-black/50 bg-warn shadow"
        />
      ) : null}
      {locked ? null : (
        <>
          <div className={cn('pointer-events-none absolute left-1/2 top-0 h-5 w-px -translate-x-1/2 bg-accent/80', !inside && '-translate-y-full')} />
          <button
            type="button"
            data-region-handle="rotate"
            aria-label="Girar região (Shift: passos de 15°)"
            title="Girar região (Shift: passos de 15°)"
            className={cn('pointer-events-auto absolute left-1/2 top-0 h-3.5 w-3.5 -translate-x-1/2 cursor-grab rounded-full border-2 border-accent bg-fg shadow', inside ? 'translate-y-5' : '-translate-y-[calc(100%+20px)]')}
            onPointerDown={(e) => onGesture(e, { kind: 'rotate' })}
          />
        </>
      )}
      {handles.map((h) => {
        const [sx, sy] = [h.includes('w') ? -1 : h.includes('e') ? 1 : 0, h.includes('n') ? -1 : h.includes('s') ? 1 : 0]
        const edge = sx === 0 || sy === 0
        return (
          <button
            key={h}
            type="button"
            data-region-handle={h}
            aria-label="Redimensionar região (Shift: mantém a proporção; Alt: a partir do centro)"
            title="Redimensionar região (Shift: mantém a proporção; Alt: a partir do centro)"
            className={cn('pointer-events-auto absolute border-2 border-accent bg-fg shadow', edge ? 'rounded-full' : 'h-3 w-3 rounded-[3px]', edge && (sx === 0 ? 'h-1.5 w-4' : 'h-4 w-1.5'))}
            style={{
              cursor: resizeCursor(h, box.rotation),
              left: sx === 0 ? '50%' : sx < 0 ? 0 : '100%',
              top: sy === 0 ? '50%' : sy < 0 ? 0 : '100%',
              transform: 'translate(-50%, -50%)'
            }}
            onPointerDown={(e) => onGesture(e, { kind: 'resize', handle: h })}
          />
        )
      })}
    </div>
  )
}
