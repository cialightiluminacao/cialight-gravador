import { memo } from 'react'
import { CloudUpload, Gem, Layers, MessageCircle, Scissors, type LucideIcon } from 'lucide-react'
import type { ExportPresetId } from '@shared/types'
import { PRESETS, PRESET_ORDER } from '@shared/presets/presets'
import { estimateOutputMB } from '@shared/presets/sizeEstimate'
import { cn } from '@/lib/cn'
import { formatMB } from '@/lib/format'

// Cards de preset (spec §7.2): título/subtítulo do PRESETS, descrição curta e tamanho estimado
// para o trecho selecionado (kbps medido da gravação para os presets que copiam o vídeo).

const PRESET_UI: Record<ExportPresetId, { icon: LucideIcon; description: string }> = {
  small: { icon: MessageCircle, description: 'Até 720p, cabe em 64 MB' },
  high: { icon: CloudUpload, description: 'Nativa, H.264 High' },
  max: { icon: Gem, description: 'Nativa, qualidade máxima' },
  separate: { icon: Layers, description: 'Faixas para edição' },
  cutOnly: { icon: Scissors, description: 'Sem recodificar, corte ≈ 1 s' }
}

interface Props {
  selected: ExportPresetId
  onSelect: (id: ExportPresetId) => void
  /** Duração efetiva do trecho (ms). */
  durationMs: number
  srcHeight: number
  srcFps: number
  /** Bitrate médio medido da gravação bruta (kbps) ou null. */
  measuredKbps: number | null
}

export const PresetCards = memo(function PresetCards({ selected, onSelect, durationMs, srcHeight, srcFps, measuredKbps }: Props): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2" role="radiogroup" aria-label="Preset de exportação">
      {PRESET_ORDER.map((id) => {
        const p = PRESETS[id]
        const ui = PRESET_UI[id]
        const Icon = ui.icon
        const est = estimateOutputMB(p, durationMs, srcHeight, srcFps, measuredKbps)
        const on = id === selected
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onSelect(id)}
            className={cn(
              'group flex w-full items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-all duration-150',
              on ? 'border-accent/60 bg-accent/10 shadow-[inset_0_0_0_1px_rgba(255,77,79,0.35)]' : 'border-border bg-surface-2/60 hover:border-border-strong hover:bg-surface-2'
            )}
          >
            <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border', on ? 'border-accent/40 bg-accent/15 text-accent-2' : 'border-border-strong bg-bg-2 text-muted group-hover:text-fg-2')}>
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-fg">{p.title}</span>
              <span className="mt-0.5 flex items-center gap-1.5 text-[11px] leading-snug text-muted">
                <span className={cn('shrink-0 rounded px-1 py-px text-[9.5px] font-bold uppercase tracking-wide', on ? 'bg-accent/20 text-accent-2' : 'bg-white/6 text-fg-2')}>{p.subtitle}</span>
                <span className="min-w-0 truncate" title={ui.description}>
                  {ui.description}
                </span>
              </span>
            </span>
            <span className="shrink-0 text-right">
              <span className={cn('font-mono tnum block text-[12px] font-semibold', on ? 'text-fg' : 'text-fg-2')}>≈ {formatMB(est)}</span>
              <span className="block text-[10px] uppercase tracking-wide text-muted">{p.container === 'multi' ? 'vários' : 'mp4'}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
})
