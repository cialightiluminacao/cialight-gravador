import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Camera, Circle, FlipHorizontal2, RectangleHorizontal } from 'lucide-react'
import type { PipKeyframe } from '@shared/types'
import { clampPip, pipPixelRect, PIP_MIN_SIZE } from '@shared/compositor'
import { cn } from '@/lib/cn'
import { Tip } from '@/components/ui/primitives'

// Camada da PiP (webcam) sobre um pai posicionado: arrastável, redimensionável pela
// alça inferior-direita (círculo 1:1 e retângulo 16:9 em pixels), com botões de
// forma e espelho. Usada no Preparar (sobre a miniatura) e no Gravando (sobre o
// vídeo ao vivo). Coordenadas normalizadas 0–1; a conversão para pixels segue
// pipPixelRect, garantindo paridade visual com a exportação.

export interface PipOverlayProps {
  pip: PipKeyframe
  onChange: (k: Omit<PipKeyframe, 'tMs'>) => void
  mirrored: boolean
  onToggleMirror?: () => void
  camStream?: MediaStream | null
  interactive?: boolean
  showControls?: boolean
  className?: string
}

type PipGeom = Omit<PipKeyframe, 'tMs'>

interface DragState {
  mode: 'move' | 'resize'
  pointerId: number
  startX: number
  startY: number
  start: PipGeom
}

const THROTTLE_MS = 60
const RECT_RATIO = 9 / 16

const stripT = (k: PipKeyframe): PipGeom => ({ x: k.x, y: k.y, w: k.w, h: k.h, shape: k.shape, visible: k.visible })

/** Altura normalizada para que a PiP tenha a proporção certa em pixels no palco W×H. */
function heightFor(w: number, shape: PipGeom['shape'], W: number, H: number): number {
  const wpx = w * W
  const hpx = shape === 'circle' ? wpx : wpx * RECT_RATIO
  return hpx / H
}

/** Ajusta a geometria mantendo proporção em pixels e dentro de 0..1. */
function fit(g: PipGeom, W: number, H: number): PipGeom {
  if (W <= 0 || H <= 0) return clampPip(g)
  const ratio = g.shape === 'circle' ? 1 : RECT_RATIO
  // maior largura possível para caber com a proporção pedida (em px)
  let wpx = Math.max(g.w * W, PIP_MIN_SIZE * W, PIP_MIN_SIZE * H / ratio)
  wpx = Math.min(wpx, W, H / ratio)
  const hpx = wpx * ratio
  return clampPip({ ...g, w: wpx / W, h: hpx / H })
}

export function PipOverlay({ pip, onChange, mirrored, onToggleMirror, camStream = null, interactive = true, showControls = true, className }: PipOverlayProps): React.JSX.Element | null {
  const rootRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [size, setSize] = useState({ W: 0, H: 0 })
  const [draft, setDraftState] = useState<PipGeom>(() => stripT(pip))
  const draftRef = useRef(draft)
  const setDraft = useCallback((g: PipGeom) => {
    draftRef.current = g
    setDraftState(g)
  }, [])
  const dragRef = useRef<DragState | null>(null)
  const lastEmitRef = useRef(0)
  const [dragging, setDragging] = useState(false)

  // tamanho do palco (o root ocupa inset 0 do pai)
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const update = (): void => setSize({ W: el.clientWidth, H: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // sincroniza com o keyframe externo quando não estamos arrastando
  useEffect(() => {
    if (!dragRef.current) setDraft(stripT(pip))
  }, [pip, setDraft])

  // stream da câmera no <video>
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (v.srcObject !== camStream) v.srcObject = camStream
    if (camStream) void v.play().catch(() => {})
  }, [camStream, draft.visible])

  const emit = useCallback(
    (g: PipGeom, force: boolean) => {
      const now = performance.now()
      if (!force && now - lastEmitRef.current < THROTTLE_MS) return
      lastEmitRef.current = now
      onChange(g)
    },
    [onChange]
  )

  const beginDrag = (mode: DragState['mode']) => (e: React.PointerEvent<HTMLElement>) => {
    if (!interactive || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { mode, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, start: draft }
    setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLElement>): void => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    const { W, H } = size
    if (W <= 0 || H <= 0) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    let next: PipGeom
    if (d.mode === 'move') {
      next = clampPip({ ...d.start, x: d.start.x + dx / W, y: d.start.y + dy / H })
    } else {
      const ratio = d.start.shape === 'circle' ? 1 : RECT_RATIO
      // cresce pelo maior deslocamento diagonal, limitado ao espaço restante à direita/abaixo
      const startWpx = d.start.w * W
      const growth = Math.max(dx, dy / ratio)
      const maxWpx = Math.min(W - d.start.x * W, (H - d.start.y * H) / ratio)
      const wpx = Math.min(Math.max(startWpx + growth, Math.max(PIP_MIN_SIZE * W, (PIP_MIN_SIZE * H) / ratio)), maxWpx)
      next = clampPip({ ...d.start, w: wpx / W, h: (wpx * ratio) / H })
    }
    setDraft(next)
    emit(next, false)
  }

  const endDrag = (e: React.PointerEvent<HTMLElement>): void => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    dragRef.current = null
    setDragging(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    emit(draftRef.current, true)
  }

  const toggleShape = (): void => {
    const shape = draft.shape === 'circle' ? 'rounded' : 'circle'
    const { W, H } = size
    const next = fit({ ...draft, shape, h: heightFor(draft.w, shape, W, H) }, W, H)
    setDraft(next)
    emit(next, true)
  }

  if (!draft.visible) return null

  const { W, H } = size
  const px = W > 0 && H > 0 ? pipPixelRect(draft, W, H) : null
  const isCircle = draft.shape === 'circle'

  return (
    <div ref={rootRef} className={cn('pointer-events-none absolute inset-0 select-none overflow-hidden', className)} aria-hidden={!interactive}>
      {px ? (
        <div
          className={cn('group pointer-events-auto absolute', interactive ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default')}
          style={{ left: px.x, top: px.y, width: px.w, height: px.h }}
          onPointerDown={beginDrag('move')}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          role={interactive ? 'button' : undefined}
          aria-label="Câmera (arraste para posicionar)"
        >
          {/* moldura da PiP */}
          <div
            className={cn(
              'relative h-full w-full overflow-hidden bg-surface-2 shadow-[0_8px_28px_rgba(0,0,0,0.55)] ring-2 ring-white/85 transition-shadow',
              interactive && 'group-hover:ring-accent-2',
              dragging && 'ring-accent'
            )}
            style={{ borderRadius: px.radius }}
          >
            {camStream ? (
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="h-full w-full object-cover"
                style={{ transform: mirrored ? 'scaleX(-1)' : undefined }}
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-[radial-gradient(circle_at_50%_35%,rgba(255,255,255,0.10),transparent_60%),linear-gradient(180deg,#2a3040,#171b26)] text-fg-2">
                <Camera className="h-[28%] w-[28%] max-h-9 max-w-9 opacity-80" strokeWidth={1.6} />
                {px.w >= 96 ? <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Câmera</span> : null}
              </div>
            )}
          </div>

          {/* controles flutuantes (forma / espelho) */}
          {interactive && showControls ? (
            <div
              className={cn(
                'absolute left-1/2 top-full z-10 mt-2 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-border-strong bg-surface-3/95 p-0.5 shadow-xl backdrop-blur transition-opacity',
                dragging ? 'opacity-0' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
              )}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <Tip content={isCircle ? 'Usar retângulo arredondado' : 'Usar círculo'} side="bottom">
                <button type="button" className="flex h-6 w-6 items-center justify-center rounded-md text-fg-2 hover:bg-white/8 hover:text-fg" onClick={toggleShape} aria-label="Alternar forma da câmera">
                  {isCircle ? <RectangleHorizontal className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
                </button>
              </Tip>
              {onToggleMirror ? (
                <Tip content={mirrored ? 'Desativar espelho' : 'Espelhar câmera'} side="bottom">
                  <button
                    type="button"
                    className={cn('flex h-6 w-6 items-center justify-center rounded-md hover:bg-white/8', mirrored ? 'text-accent-2' : 'text-fg-2 hover:text-fg')}
                    onClick={onToggleMirror}
                    aria-label="Espelhar câmera"
                    aria-pressed={mirrored}
                  >
                    <FlipHorizontal2 className="h-3.5 w-3.5" />
                  </button>
                </Tip>
              ) : null}
            </div>
          ) : null}

          {/* alça de redimensionar (canto inferior-direito) */}
          {interactive ? (
            <div
              className={cn(
                'absolute z-10 h-4 w-4 cursor-nwse-resize rounded-full border-2 border-white bg-accent shadow-md transition-opacity',
                dragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              )}
              style={isCircle ? { right: '9%', bottom: '9%' } : { right: -6, bottom: -6 }}
              onPointerDown={beginDrag('resize')}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              aria-label="Redimensionar câmera"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
