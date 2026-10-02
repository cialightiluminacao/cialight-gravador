import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { findItem, removeTransition, setTransitionDuration } from '@shared/editor/ops'
import type { MediaItem, TextItem } from '@shared/editor/project'
import { MIN_TRANSITION_US, maxTransitionUs } from '@shared/editor/transitions'
import { Select } from '@/components/ui/primitives'
import { useEditorStore } from '../../state/editorStore'
import { addTransitionTo } from '../editorActions'
import { itemLabel } from '../itemLabel'
import { formatTransitionDuration, TRANSITION_KINDS, TRANSITION_LABELS } from '../transitionInfo'
import { NumberField } from './NumberField'
import { FieldRow, PanelSection } from './common'

// Inspetor da transição selecionada (a de entrada do clipe B): tipo, duração (em s, limitada a [0,1 s, metade do clipe
// mais curto]; fora do limite o valor é limitado e um aviso fica sob o campo) e remover.

const TYPE_OPTIONS = TRANSITION_KINDS.map((k) => ({ value: k, label: TRANSITION_LABELS[k] }))
const secOf = (us: number): number => Math.round(us / 10_000) / 100

export function TransitionPanel({ toId }: { toId: string }): React.JSX.Element | null {
  const project = useEditorStore((s) => s.project)
  const apply = useEditorStore((s) => s.apply)
  const [warn, setWarn] = useState<string | null>(null)
  const f = project ? findItem(project, toId) : null
  const b = f?.item as MediaItem | TextItem | undefined
  const tr = b && (b.type === 'media' || b.type === 'text') ? b.transitionIn : undefined
  if (!project || !f || !b || !tr) return null
  const i = f.track.items.findIndex((x) => x.id === toId)
  const a = i > 0 ? f.track.items[i - 1] : undefined
  const max = a ? maxTransitionUs(a, b) : tr.durationUs
  const locked = f.track.locked

  const setDuration = (sec: number): void => {
    const want = Math.round(sec * 1e6)
    if (want < MIN_TRANSITION_US) setWarn(`Duração limitada ao mínimo de ${formatTransitionDuration(MIN_TRANSITION_US)}.`)
    else if (want > max) setWarn(`Duração limitada a ${formatTransitionDuration(max)}: a transição ocupa no máximo metade do clipe mais curto.`)
    else setWarn(null)
    apply((p) => setTransitionDuration(p, toId, want), { transient: true })
  }

  return (
    <>
      <PanelSection title="Transição">
        <p className="text-[10.5px] leading-snug text-muted">
          Entre <span className="text-fg-2">{a ? itemLabel(project, a) : '—'}</span> e <span className="text-fg-2">{itemLabel(project, b)}</span>
        </p>
        <FieldRow label="Tipo">
          <Select triggerClassName="h-7 rounded-md px-2 text-[11px]" value={tr.kind} options={TYPE_OPTIONS} disabled={locked} onValueChange={(k) => addTransitionTo(toId, k as typeof tr.kind)} />
        </FieldRow>
        <NumberField label="Duração" value={secOf(tr.durationUs)} min={0.01} max={600} precision={2} step={0.01} unit="s" disabled={locked} onChange={setDuration} title={`De ${formatTransitionDuration(MIN_TRANSITION_US)} a ${formatTransitionDuration(max)}`} />
        <p className="text-[10.5px] leading-snug text-muted">
          Mínimo {formatTransitionDuration(MIN_TRANSITION_US)}; máximo {formatTransitionDuration(max)} (metade do clipe mais curto).
        </p>
        {warn ? (
          <p role="status" data-transition-warning="" className="rounded-md bg-warn/10 px-2 py-1.5 text-[10.5px] leading-snug text-warn">
            {warn}
          </p>
        ) : null}
        <button
          type="button"
          disabled={locked}
          className="mt-1 flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-danger/40 bg-danger/10 text-[11px] font-medium text-danger hover:bg-danger/20 disabled:opacity-40"
          onClick={() => {
            if (apply((p) => removeTransition(p, toId))) useEditorStore.getState().selectTransition(null)
          }}
        >
          <Trash2 className="h-3 w-3" /> Remover transição
        </button>
        {locked ? <p className="text-[10.5px] text-muted">Faixa bloqueada: desbloqueie para mudar a transição.</p> : null}
      </PanelSection>
    </>
  )
}
