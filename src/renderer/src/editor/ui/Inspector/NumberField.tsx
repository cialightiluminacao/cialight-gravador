import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { useEditorStore } from '../../state/editorStore'

// Campo numérico de editor profissional: arrastar o rótulo (ou o campo) na horizontal altera o valor
// (Shift ×10, Alt ×0,1), roda do mouse com o campo em foco, digitação confirmada com Enter; Esc
// cancela. Cada gesto é UMA transação do store (begin → apply transient → commitTx).

export interface NumberFieldProps {
  label: string
  value: number
  /** Aplica o valor (chamado dentro da transação; use apply(fn, { transient: true })). */
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  /** Casas decimais exibidas. */
  precision?: number
  unit?: string
  disabled?: boolean
  title?: string
  className?: string
  /** Rótulo estreito (campos em duas colunas). */
  compact?: boolean
}

const DRAG_THRESHOLD_PX = 3
const WHEEL_COMMIT_MS = 450

export function NumberField({ label, value, onChange, min = -Infinity, max = Infinity, step = 1, precision = 0, unit, disabled, title, className, compact }: NumberFieldProps): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clamp = (v: number): number => Math.min(max, Math.max(min, v))
  const round = (v: number): number => Number(v.toFixed(precision))
  const shown = draft ?? value.toFixed(precision).replace('.', ',')

  useEffect(
    () => () => {
      if (wheelTimer.current) {
        clearTimeout(wheelTimer.current)
        useEditorStore.getState().commitTx()
      }
    },
    []
  )

  const store = useEditorStore.getState

  const commitTyped = (): void => {
    if (draft === null) return
    const parsed = Number(draft.replace(',', '.').trim())
    setDraft(null)
    if (!Number.isFinite(parsed)) return
    const v = clamp(round(parsed))
    if (v === value) return
    store().begin()
    onChange(v)
    store().commitTx()
  }

  const onPointerDown = (e: React.PointerEvent<HTMLElement>): void => {
    if (disabled || e.button !== 0 || draft !== null) return
    const target = e.currentTarget
    const startX = e.clientX
    const start = value
    let dragging = false
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - startX
      if (!dragging) {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX) return
        dragging = true
        store().begin()
        document.body.style.cursor = 'ew-resize'
      }
      const k = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1
      onChange(clamp(round(start + dx * step * k)))
    }
    const end = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('keydown', esc, true)
      document.body.style.cursor = ''
      if (dragging) {
        if (ev.type === 'pointercancel') store().cancelTx()
        else store().commitTx()
      } else if (target !== inputRef.current) inputRef.current?.focus()
    }
    const esc = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape' || !dragging) return
      ev.stopPropagation()
      dragging = false
      store().cancelTx()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    window.addEventListener('keydown', esc, true)
    if (target !== inputRef.current) e.preventDefault()
  }

  const onWheel = (e: WheelEvent): void => {
    if (disabled || document.activeElement !== inputRef.current) return
    e.preventDefault() // não rola o painel enquanto ajusta o valor
    const k = e.shiftKey ? 10 : e.altKey ? 0.1 : 1
    const v = clamp(round(value + (e.deltaY < 0 ? 1 : -1) * step * k))
    if (!wheelTimer.current) store().begin()
    else clearTimeout(wheelTimer.current)
    onChange(v)
    wheelTimer.current = setTimeout(() => {
      wheelTimer.current = null
      store().commitTx()
    }, WHEEL_COMMIT_MS)
  }

  // listener nativo não passivo (o onWheel do React é passivo e não impede a rolagem)
  const wheelRef = useRef(onWheel)
  wheelRef.current = onWheel
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const h = (e: WheelEvent): void => wheelRef.current(e)
    el.addEventListener('wheel', h, { passive: false })
    return () => el.removeEventListener('wheel', h)
  }, [])

  return (
    <div className={cn('group flex h-7 min-w-0 items-center gap-2 text-[11px]', disabled && 'opacity-40', className)} title={title}>
      <span className={cn('shrink-0 cursor-ew-resize', compact ? 'w-[50px]' : 'w-[74px]')} onPointerDown={onPointerDown}>
        <span className="block truncate text-muted group-hover:text-fg-2">{label}</span>
      </span>
      <span className="relative flex h-7 min-w-0 flex-1 items-center rounded-md border border-border bg-bg-2 focus-within:border-accent/60 hover:border-border-strong">
        <input
          ref={inputRef}
          className="font-mono tnum h-full w-full min-w-0 cursor-ew-resize bg-transparent px-2 text-right text-[11px] text-fg outline-none focus:cursor-text"
          value={shown}
          disabled={disabled}
          inputMode="decimal"
          aria-label={label}
          onPointerDown={(e) => {
            if (document.activeElement !== inputRef.current) onPointerDown(e)
          }}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitTyped}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitTyped()
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              e.stopPropagation()
              setDraft(null)
              e.currentTarget.blur()
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault()
              const v = clamp(round(value + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)))
              store().begin()
              onChange(v)
              store().commitTx()
            }
          }}
        />
        {unit ? <span className="pointer-events-none pr-2 text-[10px] text-muted-2">{unit}</span> : null}
      </span>
    </div>
  )
}
