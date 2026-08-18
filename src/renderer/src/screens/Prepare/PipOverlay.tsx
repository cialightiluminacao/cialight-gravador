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

export type PipGeom = Omit<PipKeyframe, 'tMs'>

interface DragState {
  mode: 'move' | 'resize'
  pointerId: number
  startX: number
  startY: number
  start: PipGeom
}

const THROTTLE_MS = 60
const RECT_RATIO = 9 / 16

// barra de controles (forma / espelho): dimensões fixas para posicioná-la sem medir
const CTRL_BTN = 26
const CTRL_GAP = 2
const CTRL_PAD = 3
const CTRL_H = CTRL_BTN + CTRL_PAD * 2 + 2
const CTRL_OFFSET = 8
const STAGE_MARGIN = 4

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
  let wpx = Math.max(g.w * W, PIP_MIN_SIZE * W, (PIP_MIN_SIZE * H) / ratio)
  wpx = Math.min(wpx, W, H / ratio)
  const hpx = wpx * ratio
  return clampPip({ ...g, w: wpx / W, h: hpx / H })
}

/** Mesma geometria com outra forma, mantendo a largura e a proporção em pixels no palco W×H. */
export function pipWithShape(g: PipGeom, shape: PipGeom['shape'], W: number, H: number): PipGeom {
  return fit({ ...g, shape, h: heightFor(g.w, shape, W, H) }, W, H)
}

/** Liga o stream ao <video> assim que o elemento existe (callback ref: não depende de efeito). */
function attachStream(v: HTMLVideoElement | null, stream: MediaStream | null): void {
  if (!v) return
  if (v.srcObject !== stream) v.srcObject = stream
  if (stream) void v.play().catch(() => {})
}

type CtrlPlacement = 'below' | 'above' | 'inside'

export function PipOverlay({ pip, onChange, mirrored, onToggleMirror, camStream = null, interactive = true, showControls = true, className }: PipOverlayProps): React.JSX.Element | null {
  const rootRef = useRef<HTMLDivElement>(null)
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

  const videoRef = useCallback((v: HTMLVideoElement | null) => attachStream(v, camStream), [camStream])

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
    const next = pipWithShape(draft, draft.shape === 'circle' ? 'rounded' : 'circle', size.W, size.H)
    setDraft(next)
    emit(next, true)
  }

  if (!draft.visible) return null

  const { W, H } = size
  const px = W > 0 && H > 0 ? pipPixelRect(draft, W, H) : null
  const isCircle = draft.shape === 'circle'

  // controles: abaixo da PiP se couber; senão acima; senão dentro (PiP quase do tamanho do palco).
  // Horizontalmente, centralizados na PiP mas sempre dentro do palco.
  const ctrlCount = onToggleMirror ? 2 : 1
  const ctrlW = ctrlCount * CTRL_BTN + (ctrlCount - 1) * CTRL_GAP + CTRL_PAD * 2 + 2
  let placement: CtrlPlacement = 'below'
  let ctrlLeft = 0
  if (px) {
    if (px.y + px.h + CTRL_OFFSET + CTRL_H > H - STAGE_MARGIN) placement = px.y - CTRL_OFFSET - CTRL_H >= STAGE_MARGIN ? 'above' : 'inside'
    const wanted = px.x + px.w / 2 - ctrlW / 2
    ctrlLeft = Math.min(Math.max(wanted, STAGE_MARGIN), Math.max(STAGE_MARGIN, W - ctrlW - STAGE_MARGIN)) - px.x
  }
  // alça de redimensionar: para fora do canto quando há espaço; encostada quando a PiP toca a borda
  const handleRight = px && px.x + px.w > W - 7 ? 2 : -6
  const handleBottom = px && px.y + px.h > H - 7 ? 2 : -6

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
              <video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-cover" style={{ transform: mirrored ? 'scaleX(-1)' : undefined }} />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-[radial-gradient(circle_at_50%_35%,rgba(255,255,255,0.10),transparent_60%),linear-gradient(180deg,#2a3040,#171b26)] text-fg-2">
                <Camera className="h-[28%] w-[28%] max-h-9 max-w-9 opacity-80" strokeWidth={1.6} />
                {px.w >= 96 ? <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Câmera</span> : null}
              </div>
            )}
          </div>

          {/* controles flutuantes (forma / espelho) — o invólucro cobre o vão até a PiP para o hover não cair */}
          {interactive && showControls ? (
            <div
              className={cn('absolute z-10 transition-opacity', dragging ? 'opacity-0' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100')}
              style={{
                left: ctrlLeft,
                width: ctrlW,
                ...(placement === 'below'
                  ? { top: px.h, paddingTop: CTRL_OFFSET }
                  : placement === 'above'
                    ? { bottom: px.h, paddingBottom: CTRL_OFFSET }
                    : { top: CTRL_OFFSET })
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="flex items-center rounded-lg border border-border-strong bg-surface-3/95 shadow-xl backdrop-blur" style={{ gap: CTRL_GAP, padding: CTRL_PAD }}>
                <Tip content={isCircle ? 'Usar retângulo arredondado' : 'Usar círculo'} side={placement === 'above' ? 'top' : 'bottom'}>
                  <button
                    type="button"
                    className="flex items-center justify-center rounded-md text-fg-2 hover:bg-white/8 hover:text-fg"
                    style={{ width: CTRL_BTN, height: CTRL_BTN }}
                    onClick={toggleShape}
                    aria-label="Alternar forma da câmera"
                  >
                    {isCircle ? <RectangleHorizontal className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
                  </button>
                </Tip>
                {onToggleMirror ? (
                  <Tip content={mirrored ? 'Desativar espelho' : 'Espelhar câmera'} side={placement === 'above' ? 'top' : 'bottom'}>
                    <button
                      type="button"
                      className={cn('flex items-center justify-center rounded-md hover:bg-white/8', mirrored ? 'text-accent-2' : 'text-fg-2 hover:text-fg')}
                      style={{ width: CTRL_BTN, height: CTRL_BTN }}
                      onClick={onToggleMirror}
                      aria-label="Espelhar câmera"
                      aria-pressed={mirrored}
                    >
                      <FlipHorizontal2 className="h-3.5 w-3.5" />
                    </button>
                  </Tip>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* alça de redimensionar (canto inferior-direito) */}
          {interactive ? (
            <div
              className={cn(
                'absolute z-10 h-4 w-4 cursor-nwse-resize rounded-full border-2 border-white bg-accent shadow-md transition-opacity',
                dragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              )}
              style={isCircle ? { right: '9%', bottom: '9%' } : { right: handleRight, bottom: handleBottom }}
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
