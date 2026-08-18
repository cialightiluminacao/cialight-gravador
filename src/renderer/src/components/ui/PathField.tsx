import { FolderOpen, FolderInput, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from './Button'
import { Tip } from './primitives'
import { cn } from '@/lib/cn'

// Campo de pasta: mostra o caminho em uso (personalizado ou padrão) com ações
// Trocar (diálogo nativo), Padrão (volta a null) e Abrir (Explorer).

export function PathField({
  value,
  defaultPath,
  onChange,
  className
}: {
  /** Caminho escolhido pelo usuário; `null` = usar o padrão. */
  value: string | null
  /** Caminho padrão do app (mostrado quando `value` é null). */
  defaultPath: string | null
  onChange: (next: string | null) => void
  className?: string
}): React.JSX.Element {
  const effective = value ?? defaultPath ?? ''
  const isDefault = value === null
  const cut = Math.max(effective.lastIndexOf('\\'), effective.lastIndexOf('/'))
  const parent = cut >= 0 ? effective.slice(0, cut + 1) : ''
  const leaf = cut >= 0 ? effective.slice(cut + 1) : effective
  const pick = async (): Promise<void> => {
    const chosen = await window.api.settings.pickFolder(effective || null)
    if (chosen) onChange(chosen)
  }
  const open = async (): Promise<void> => {
    if (!effective) return
    try {
      await window.api.app.openPath(effective)
    } catch {
      toast.error('Não foi possível abrir a pasta')
    }
  }
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl border border-border-strong bg-bg-2 px-3">
        <FolderOpen className="h-4 w-4 shrink-0 text-muted" />
        <span className="font-mono flex min-w-0 flex-1 items-baseline text-[12px]" title={effective}>
          <span className="min-w-[6ch] shrink truncate text-muted">{parent}</span>
          <span className="shrink-0 font-semibold text-fg">{leaf || '—'}</span>
        </span>
        {isDefault ? <span className="shrink-0 rounded-md bg-white/6 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">padrão</span> : null}
      </div>
      <Tip content="Escolher outra pasta">
        <Button size="sm" variant="secondary" onClick={() => void pick()}>
          <FolderInput className="h-3.5 w-3.5" /> Trocar
        </Button>
      </Tip>
      <Tip content="Voltar à pasta padrão do aplicativo">
        <Button size="sm" variant="ghost" className="px-2" disabled={isDefault} onClick={() => onChange(null)} aria-label="Voltar à pasta padrão">
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      </Tip>
      <Tip content="Abrir no Explorador de Arquivos">
        <Button size="sm" variant="ghost" className="px-2" disabled={!effective} onClick={() => void open()} aria-label="Abrir pasta">
          <FolderOpen className="h-3.5 w-3.5" />
        </Button>
      </Tip>
    </div>
  )
}
