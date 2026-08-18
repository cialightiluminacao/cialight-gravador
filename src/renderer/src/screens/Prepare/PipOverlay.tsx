import { useEffect, useRef, useState } from 'react'
import { Circle, FlipHorizontal2, RectangleHorizontal } from 'lucide-react'
import type { PipKeyframe } from '@shared/types'
import { clampPip } from '@shared/compositor'
import { cn } from '@/lib/cn'

// PiP da webcam sobre o preview: arrastável, redimensionável (alça inferior-direita),
// círculo (1:1 em pixels) ou retangular 16:9. Coordenadas normalizadas (0–1) —
// h é fração da ALTURA do palco; o palco é 16:9, então círculo ⇒ h = w * 16/9.

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

const ASPECT = 16 / 9

export function PipOverlay({ pip, onChange, mirrored, onToggleMirror, camStream, interactive = true, showControls = true, className }: PipOverlayProps): React.JSX.Element | null {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ kind: 'move' | 'resize'; startX: number; startY: number; base: PipKeyframe } | null>(null)
  const [hover, setHover] = useState(false)
  const lastEmit = useRef(0)

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = camStream ?? null
  }, [camStream])

  if (!pip.visible) return null
  const circle = pip.shape === 'circle'
  // dimensões em % do palco
  const w = pip.w
  // círculo: lado = w·W px → h = w·(W/H) = w·16/9; retangular 16:9: altura = w·W·9/16 px → h = w
  const hFrac = Math.min(1, circle ? w * ASPECT : w)

  const emit = (k: PipKeyframe, force = false): void => {
    const now = performance.now()
    if (!force && now - lastEmit.current < 60) return
    lastEmit.current = now
    const c = clampPip({ x: k.x, y: k.y, w: k.w, h: k.h, shape: k.shape, visible: k.visible })
    onChange({ x: c.x, y: c.y, w: c.w, h: c.h, shape: c.shape, visible: c.visible })
  }

  const onPointerDown = (e: React.PointerEvent, kind: 'move' | 'resize'): void => {
    if (!interactive) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setDrag({ kind, startX: e.clientX, startY: e.clientY, base: { ...pip, h: hFrac } })
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    if (!drag || !hostRef.current) return
    const rect = hostRef.current.getBoundingClientRect()
    const dx = (e.clientX - drag.startX) / rect.width
    const dy = (e.clientY - drag.startY) / rect.height
    let next: PipKeyframe
    if (drag.kind === 'move') {
      next = { ...drag.base, x: drag.base.x + dx, y: drag.base.y + dy }
    } else {
      const nw = Math.max(0.08, Math.min(0.6, drag.base.w + dx))
      next = { ...drag.base, w: nw, h: circle ? nw * ASPECT : nw }
    }
    next = { ...next, ...clampPip({ x: next.x, y: next.y, w: next.w, h: next.h, shape: next.shape, visible: next.visible }) }
    emit(next)
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    if (!drag) return
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ok */
    }
    const rect = hostRef.current?.getBoundingClientRect()
    if (rect) {
      const dx = (e.clientX - drag.startX) / rect.width
      const dy = (e.clientY - drag.startY) / rect.height
      const next = drag.kind === 'move' ? { ...drag.base, x: drag.base.x + dx, y: drag.base.y + dy } : (() => {
        const nw = Math.max(0.08, Math.min(0.6, drag.base.w + dx))
        return { ...drag.base, w: nw, h: circle ? nw * ASPECT : nw }
      })()
      emit(next, true)
    }
    setDrag(null)
  }
  const toggleShape = (): void => {
    const shape = circle ? 'rounded' : 'circle'
    emit({ ...pip, shape, h: shape === 'circle' ? pip.w * ASPECT : pip.w }, true)
  }

  return (
    <div ref={hostRef} className={cn('pointer-events-none absolute inset-0', className)}>
      <div
        className={cn('pointer-events-auto absolute select-none', interactive ? (drag?.kind === 'move' ? 'cursor-grabbing' : 'cursor-grab') : '')}
        style={{ left: `${pip.x * 100}%`, top: `${pip.y * 100}%`, width: `${w * 100}%`, height: `${hFrac * 100}%` }}
        onPointerDown={(e) => onPointerDown(e, 'move')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
      >
        <div
          className={cn('h-full w-full overflow-hidden bg-surface-3 shadow-[0_8px_28px_rgba(0,0,0,0.5)] ring-2 ring-white/85', circle ? 'rounded-full' : 'rounded-[8%]')}
          style={{ aspectRatio: circle ? '1 / 1' : '16 / 9' }}
        >
          {camStream ? (
            <video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-cover" style={{ transform: mirrored ? 'scaleX(-1)' : undefined }} />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-surface-2 to-surface-3 text-[10px] font-semibold uppercase tracking-widest text-muted">webcam</div>
          )}
        </div>
        {interactive && showControls && (hover || drag) ? (
          <>
            <div className="absolute -top-9 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border-strong bg-bg/90 p-1 shadow-lg backdrop-blur" onPointerDown={(e) => e.stopPropagation()}>
              <button className="flex h-6 w-6 items-center justify-center rounded-md text-fg-2 hover:bg-white/10 hover:text-fg" title={circle ? 'Retangular' : 'Redonda'} onClick={toggleShape}>
                {circle ? <RectangleHorizontal className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
              </button>
              {onToggleMirror ? (
                <button className={cn('flex h-6 w-6 items-center justify-center rounded-md hover:bg-white/10', mirrored ? 'text-accent-2' : 'text-fg-2 hover:text-fg')} title="Espelhar" onClick={onToggleMirror}>
                  <FlipHorizontal2 className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            <div
              className="absolute -bottom-1 -right-1 h-4 w-4 cursor-nwse-resize rounded-full border-2 border-white bg-accent shadow"
              onPointerDown={(e) => onPointerDown(e, 'resize')}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          </>
        ) : null}
      </div>
    </div>
  )
}
