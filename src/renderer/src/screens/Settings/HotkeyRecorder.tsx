import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { formatAcceleratorLabel } from '@shared/hotkeys'
import { cn } from '@/lib/cn'
import { activeModifiers, captureFromKey } from './hotkeyCapture'

// Campo que captura uma combinação de teclas. Clique (ou Enter/Espaço) inicia a
// captura e mostra "Pressione a combinação…"; o keydown é traduzido para acelerador
// do Electron e normalizado. Backspace/Delete limpam, Escape sai sem alterar,
// Tab sai e segue a navegação, botão X limpa.

const MODIFIER_LABEL: Record<string, string> = { CommandOrControl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Super: 'Win' }

export function HotkeyRecorder({
  value,
  onChange,
  onCapturingChange,
  invalid = false,
  ariaLabel,
  className
}: {
  value: string | null
  onChange: (next: string | null) => void
  /** Avisa quando a captura começa/termina (para suspender os atalhos globais enquanto isso). */
  onCapturingChange?: (capturing: boolean) => void
  /** Realça em vermelho (ex.: duplicado). */
  invalid?: boolean
  ariaLabel: string
  className?: string
}): React.JSX.Element {
  const [capturing, setCapturing] = useState(false)
  const [pending, setPending] = useState<string[]>([])
  const [rejected, setRejected] = useState(false)
  const notify = useRef(onCapturingChange)
  notify.current = onCapturingChange
  const capturingRef = useRef(false)

  // Ao desmontar no meio de uma captura, libera os atalhos globais.
  useEffect(
    () => () => {
      if (capturingRef.current) notify.current?.(false)
    },
    []
  )

  useEffect(() => {
    if (!rejected) return
    const t = setTimeout(() => setRejected(false), 1400)
    return () => clearTimeout(t)
  }, [rejected])

  const start = (): void => {
    setRejected(false)
    setCapturing(true)
    if (!capturingRef.current) {
      capturingRef.current = true
      notify.current?.(true)
    }
  }
  const stop = (): void => {
    setCapturing(false)
    setPending([])
    if (capturingRef.current) {
      capturingRef.current = false
      notify.current?.(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!capturing) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        start()
      }
      return
    }
    // Tab (com ou sem Shift) sai da captura e deixa o foco seguir normalmente.
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      stop()
      return
    }
    e.preventDefault()
    e.stopPropagation()
    const r = captureFromKey(e.nativeEvent)
    if (r.kind === 'pending') {
      setPending(r.modifiers)
      return
    }
    if (r.kind === 'cancel') {
      stop()
      return
    }
    if (r.kind === 'clear') {
      onChange(null)
      stop()
      return
    }
    if (!r.accelerator) {
      setRejected(true)
      setPending([])
      return
    }
    onChange(r.accelerator)
    stop()
  }

  const onKeyUp = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (capturing) setPending(activeModifiers(e.nativeEvent))
  }

  const label = value ? formatAcceleratorLabel(value) : null
  const pendingLabel = pending.map((m) => MODIFIER_LABEL[m] ?? m).join(' + ')

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <div
        role="button"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        title={capturing ? 'Pressione a combinação. Backspace limpa, Esc cancela.' : 'Clique e pressione a nova combinação'}
        onClick={start}
        onBlur={stop}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        className={cn(
          'flex h-8 min-w-[196px] cursor-pointer select-none items-center rounded-xl border px-3 text-sm outline-none transition-colors',
          capturing ? 'border-accent bg-accent/10 text-fg shadow-[0_0_0_3px_var(--ring)]' : 'border-border-strong bg-bg-2 hover:bg-surface-2 focus-visible:border-border-strong',
          !capturing && invalid && 'border-danger/60 bg-danger/10',
          rejected && 'border-danger bg-danger/15 shadow-none'
        )}
      >
        {capturing ? (
          <span className={cn('font-mono text-[12px]', rejected ? 'text-danger' : pendingLabel ? 'text-fg' : 'text-muted')}>
            {rejected ? 'Combinação não aceita' : pendingLabel ? `${pendingLabel} + …` : 'Pressione a combinação…'}
          </span>
        ) : label ? (
          <span className={cn('font-mono text-[12px] tracking-wide', invalid ? 'text-danger' : 'text-fg')}>{label}</span>
        ) : (
          <span className="text-xs text-muted">Sem atalho</span>
        )}
      </div>
      <button
        type="button"
        aria-label={`Remover atalho de ${ariaLabel}`}
        title="Remover atalho"
        disabled={!value}
        onClick={() => onChange(null)}
        className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-white/6 hover:text-fg disabled:pointer-events-none disabled:opacity-25"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
