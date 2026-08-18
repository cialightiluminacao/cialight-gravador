import { memo, useCallback, useRef, useState } from 'react'
import type { Session } from '@shared/types'
import { cn } from '@/lib/cn'
import { formatTimecode } from '@/lib/format'
import { Kbd } from '@/components/ui/primitives'

// Linha do tempo da revisão: tira de miniaturas + forma de onda + playhead + alças de corte
// (arrastáveis e por teclado: setas ±1 s, Shift ±5 s, Home/End; I/O no ReviewScreen) +
// marcadores da sessão.

/** Menor trecho exportável (ms) entre as alças. */
export const MIN_TRIM_GAP_MS = 500
/** Passo das alças pelo teclado (ms); com Shift, 5×. */
const KEY_STEP_MS = 1000

interface Props {
  durationMs: number
  currentMs: number
  trimStartMs: number
  trimEndMs: number
  thumbs: string[]
  waveformUrl: string | null
  markers: Session['markers']
  onSeek: (ms: number) => void
  onTrimChange: (startMs: number, endMs: number) => void
  className?: string
}

type DragKind = 'seek' | 'start' | 'end'

export const Timeline = memo(function Timeline({ durationMs, currentMs, trimStartMs, trimEndMs, thumbs, waveformUrl, markers, onSeek, onTrimChange, className }: Props): React.JSX.Element {
  const stripRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragKind | null>(null)
  const dur = Math.max(1, durationMs)
  const pct = (ms: number): number => Math.max(0, Math.min(100, (ms / dur) * 100))

  const msAt = useCallback(
    (clientX: number): number => {
      const el = stripRef.current
      if (!el) return 0
      const r = el.getBoundingClientRect()
      const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
      return Math.round(p * dur)
    },
    [dur]
  )

  const begin = (kind: DragKind) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag(kind)
    move(kind, e.clientX)
  }

  const move = (kind: DragKind, clientX: number): void => {
    const ms = msAt(clientX)
    if (kind === 'seek') onSeek(ms)
    else if (kind === 'start') onTrimChange(Math.min(ms, trimEndMs - MIN_TRIM_GAP_MS), trimEndMs)
    else onTrimChange(trimStartMs, Math.max(ms, trimStartMs + MIN_TRIM_GAP_MS))
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (drag) move(drag, e.clientX)
  }
  const onPointerUp = (): void => setDrag(null)

  const onHandleKey = (side: 'start' | 'end') => (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = KEY_STEP_MS * (e.shiftKey ? 5 : 1)
    let next: number | null = null
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = (side === 'start' ? trimStartMs : trimEndMs) - step
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = (side === 'start' ? trimStartMs : trimEndMs) + step
    else if (e.key === 'Home') next = side === 'start' ? 0 : trimStartMs + MIN_TRIM_GAP_MS
    else if (e.key === 'End') next = side === 'start' ? trimEndMs - MIN_TRIM_GAP_MS : durationMs
    if (next === null) return
    e.preventDefault()
    e.stopPropagation() // não deixa o atalho global de seek (setas) do ReviewScreen disparar junto
    if (side === 'start') onTrimChange(Math.max(0, Math.min(next, trimEndMs - MIN_TRIM_GAP_MS)), trimEndMs)
    else onTrimChange(trimStartMs, Math.min(durationMs, Math.max(next, trimStartMs + MIN_TRIM_GAP_MS)))
  }
  // Sem duração conhecida (sessão recuperada antes do metadata) as alças ficariam sobrepostas em 0 %.
  const handlesReady = durationMs > 0

  return (
    <div className={cn('select-none', className)}>
      <div
        ref={stripRef}
        className={cn('relative h-[76px] overflow-hidden rounded-xl border border-border-strong bg-bg-2', drag === 'seek' ? 'cursor-grabbing' : 'cursor-crosshair')}
        onPointerDown={begin('seek')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* miniaturas: as carregadas dividem a largura por igual; as que falham saem do fluxo (sem buraco no fim). */}
        <div className="absolute inset-0 flex">
          {thumbs.map((src) => (
            <img
              key={src}
              src={src}
              alt=""
              draggable={false}
              className="h-full min-w-0 flex-1 basis-0 object-cover opacity-90"
              onError={(e) => {
                e.currentTarget.style.display = 'none'
              }}
            />
          ))}
        </div>
        {/* forma de onda */}
        {waveformUrl ? <img src={waveformUrl} alt="" draggable={false} className="pointer-events-none absolute inset-x-0 bottom-0 h-[34px] w-full opacity-80 mix-blend-screen" /> : null}
        {/* fora do corte */}
        <div className="pointer-events-none absolute inset-y-0 left-0 bg-black/65 backdrop-saturate-50" style={{ width: `${pct(trimStartMs)}%` }} />
        <div className="pointer-events-none absolute inset-y-0 right-0 bg-black/65 backdrop-saturate-50" style={{ width: `${100 - pct(trimEndMs)}%` }} />
        {/* bordas do trecho */}
        <div className="pointer-events-none absolute inset-y-0 border-y-2 border-accent/80" style={{ left: `${pct(trimStartMs)}%`, right: `${100 - pct(trimEndMs)}%` }} />
        {/* marcadores */}
        {markers.map((m, i) => (
          <div key={`${m.tMs}-${i}`} className="pointer-events-none absolute top-0 h-2.5 w-2.5 -translate-x-1/2 rotate-45 rounded-[2px] bg-warn shadow" style={{ left: `${pct(m.tMs)}%` }} title={m.label ?? formatTimecode(m.tMs)} />
        ))}
        {/* alças */}
        {handlesReady ? (
          <>
            <TrimHandle side="start" left={pct(trimStartMs)} valueMs={trimStartMs} maxMs={durationMs} active={drag === 'start'} onPointerDown={begin('start')} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onKeyDown={onHandleKey('start')} />
            <TrimHandle side="end" left={pct(trimEndMs)} valueMs={trimEndMs} maxMs={durationMs} active={drag === 'end'} onPointerDown={begin('end')} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onKeyDown={onHandleKey('end')} />
          </>
        ) : null}
        {/* playhead */}
        <div className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]" style={{ left: `${pct(currentMs)}%` }}>
          <span className="absolute -top-px left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-white shadow" />
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          <Kbd>I</Kbd> início <span className="font-mono tnum text-fg-2">{formatTimecode(trimStartMs)}</span>
        </span>
        <span className="font-mono tnum">
          trecho <span className="text-fg-2">{formatTimecode(Math.max(0, trimEndMs - trimStartMs))}</span> de {formatTimecode(durationMs)}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="font-mono tnum text-fg-2">{formatTimecode(trimEndMs)}</span> fim <Kbd>O</Kbd>
        </span>
      </div>
    </div>
  )
})

function TrimHandle({
  side,
  left,
  valueMs,
  maxMs,
  active,
  ...handlers
}: {
  side: 'start' | 'end'
  left: number
  valueMs: number
  maxMs: number
  active: boolean
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void
  onPointerUp: () => void
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void
}): React.JSX.Element {
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={side === 'start' ? 'Início do corte' : 'Fim do corte'}
      aria-valuemin={0}
      aria-valuemax={Math.round(maxMs)}
      aria-valuenow={Math.round(valueMs)}
      aria-valuetext={formatTimecode(valueMs)}
      className={cn(
        'absolute inset-y-0 z-10 flex w-3.5 cursor-ew-resize items-center justify-center bg-accent text-white outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/70',
        side === 'start' ? 'rounded-l-lg' : '-translate-x-full rounded-r-lg',
        active ? 'bg-accent-2' : 'hover:bg-accent-2'
      )}
      style={{ left: `${left}%` }}
      {...handlers}
      onPointerCancel={handlers.onPointerUp}
    >
      <span className="h-5 w-0.5 rounded bg-white/85" />
    </div>
  )
}
