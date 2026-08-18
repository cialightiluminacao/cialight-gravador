import { useEffect, useRef } from 'react'
import { AppWindow, Monitor } from 'lucide-react'
import type { CaptureSource } from '@shared/types'
import { cn } from '@/lib/cn'
import { Badge } from '@/components/ui/primitives'

// Cartão de uma fonte de captura (monitor ou janela): miniatura 16:9, nome,
// ícone do app e selo "principal". Selecionado = anel no acento.

export interface SourceCardProps {
  source: CaptureSource
  selected: boolean
  primary?: boolean
  /** Título exibido (padrão: nome da fonte). */
  title?: string
  subtitle?: string
  onSelect: (s: CaptureSource) => void
}

export function SourceCard({ source, selected, primary = false, title, subtitle, onSelect }: SourceCardProps): React.JSX.Element {
  const KindIcon = source.kind === 'screen' ? Monitor : AppWindow
  const ref = useRef<HTMLButtonElement>(null)
  // mantém o cartão selecionado visível (ex.: fonte restaurada ao abrir)
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onSelect(source)}
      aria-pressed={selected}
      title={title ?? source.name}
      className={cn(
        'group flex w-full flex-col gap-2 rounded-xl border p-2 text-left transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
        selected ? 'border-accent/60 bg-accent/8 shadow-[0_0_0_1px_rgba(255,77,79,0.35),0_8px_24px_rgba(0,0,0,0.35)]' : 'border-border bg-surface-2/60 hover:border-border-strong hover:bg-surface-2'
      )}
    >
      <div className={cn('relative aspect-video w-full overflow-hidden rounded-lg bg-bg-2 ring-1', selected ? 'ring-accent/50' : 'ring-white/6')}>
        {source.thumbnailDataUrl ? (
          <img src={source.thumbnailDataUrl} alt="" draggable={false} className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-2">
            <KindIcon className="h-6 w-6" strokeWidth={1.5} />
          </div>
        )}
        {primary ? (
          <Badge tone="accent" className="absolute left-1.5 top-1.5 h-5 px-1.5 text-[9px] backdrop-blur">
            principal
          </Badge>
        ) : null}
        {selected ? <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-accent shadow-[0_0_0_3px_rgba(255,77,79,0.25)]" /> : null}
      </div>
      <div className="flex min-w-0 items-center gap-2 px-0.5">
        {source.appIconDataUrl ? (
          <img src={source.appIconDataUrl} alt="" draggable={false} className="h-4 w-4 shrink-0 rounded-sm" />
        ) : (
          <KindIcon className={cn('h-4 w-4 shrink-0', selected ? 'text-accent-2' : 'text-muted')} />
        )}
        <div className="min-w-0 flex-1">
          <div className={cn('truncate text-[12.5px] font-semibold leading-tight', selected ? 'text-fg' : 'text-fg-2')}>{title ?? source.name}</div>
          {subtitle ? <div className="truncate text-[11px] leading-tight text-muted">{subtitle}</div> : null}
        </div>
      </div>
    </button>
  )
}
