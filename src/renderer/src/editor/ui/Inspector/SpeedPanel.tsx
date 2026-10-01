import { Info } from 'lucide-react'
import { setSpeed } from '@shared/editor/ops'
import { MAX_SPEED, MIN_SPEED, type MediaItem } from '@shared/editor/project'
import { cn } from '@/lib/cn'
import { useEditorStore } from '../../state/editorStore'
import { NumberField } from './NumberField'
import { PanelSection } from './common'

// Velocidade do item (e dos vinculados): presets e campo livre. Mudar a velocidade recalcula a
// duração e empurra o que vem depois (ripple), como em ops.setSpeed.

const PRESETS = [0.25, 0.5, 1, 1.5, 2, 4, 8]
const fmt = (n: number): string => `${String(n).replace('.', ',')}×`

export function SpeedPanel({ item }: { item: MediaItem }): React.JSX.Element {
  const apply = useEditorStore((s) => s.apply)
  return (
    <PanelSection title="Velocidade">
      <div className="grid grid-cols-4 gap-1">
        {PRESETS.map((s) => (
          <button
            key={s}
            className={cn(
              'font-mono tnum h-7 rounded-md border text-[11px] font-medium transition-colors',
              Math.abs(item.speed - s) < 1e-6 ? 'border-accent/60 bg-accent/15 text-accent-2' : 'border-border bg-bg-2 text-fg-2 hover:border-border-strong hover:text-fg'
            )}
            onClick={() => apply((p) => setSpeed(p, item.id, s))}
            aria-pressed={Math.abs(item.speed - s) < 1e-6}
          >
            {fmt(s)}
          </button>
        ))}
      </div>
      <NumberField label="Personalizada" value={item.speed} min={MIN_SPEED} max={MAX_SPEED} precision={2} step={0.01} unit="×" onChange={(v) => apply((p) => setSpeed(p, item.id, v), { transient: true })} />
      {item.speed !== 1 ? (
        <p className="flex items-start gap-1.5 rounded-md bg-info/10 px-2 py-1.5 text-[10.5px] leading-snug text-info">
          <Info className="mt-px h-3 w-3 shrink-0" />O tom da voz preservado na mudança de velocidade chega na próxima versão.
        </p>
      ) : null}
    </PanelSection>
  )
}
