import { RotateCcw } from 'lucide-react'
import { defaultVisual } from '@shared/editor/factory'
import type { Item, VisualProps } from '@shared/editor/project'
import { Tip } from '@/components/ui/primitives'
import { usePausedPlayhead } from '../../state/pausedPlayhead'
import { KeyframeButton } from './KeyframeButton'
import { NumberField } from './NumberField'
import { PanelSection, animAt, editItem, editItemTransient, localUs, withValue } from './common'

// Transformação (posição, escala, rotação, opacidade) de texto e forma: os mesmos campos animáveis da aba Vídeo da
// mídia. Valores no playhead; com keyframes, editar grava no key do playhead.

type VisualItem = Item & { visual: VisualProps }
type TKey = keyof VisualProps['transform']

export function TransformSection({ item, locked }: { item: VisualItem; locked: boolean }): React.JSX.Element {
  const playheadUs = usePausedPlayhead()
  const local = localUs(item, playheadUs)
  const t = item.visual.transform
  const id = item.id
  const set = (key: TKey, value: number): void => editItemTransient<VisualItem>(id, (d) => { d.visual.transform[key] = withValue(d.visual.transform[key], local, value) })
  const kf = (path: 'transform.x' | 'transform.y' | 'transform.scale' | 'transform.rotation' | 'transform.opacity', label: string): React.JSX.Element => <KeyframeButton item={item} path={path} label={label} disabled={locked} />
  return (
    <PanelSection
      title="Transformação"
      aside={
        <Tip content="Voltar posição, tamanho e opacidade ao padrão">
          <button disabled={locked} className="flex h-5 items-center gap-1 rounded px-1.5 text-[10px] font-semibold text-muted hover:bg-white/5 hover:text-fg disabled:opacity-40" onClick={() => editItem<VisualItem>(id, (d) => { d.visual = { ...defaultVisual(), animIn: d.visual.animIn, animOut: d.visual.animOut, fadeInUs: d.visual.fadeInUs, fadeOutUs: d.visual.fadeOutUs } })}>
            <RotateCcw className="h-3 w-3" /> Redefinir
          </button>
        </Tip>
      }
    >
      <NumberField label="Posição X" value={animAt(t.x, local) * 100} precision={1} step={0.1} unit="%" disabled={locked} onChange={(n) => set('x', n / 100)} title="Posição horizontal do centro" trailing={kf('transform.x', 'Posição X')} />
      <NumberField label="Posição Y" value={animAt(t.y, local) * 100} precision={1} step={0.1} unit="%" disabled={locked} onChange={(n) => set('y', n / 100)} title="Posição vertical do centro" trailing={kf('transform.y', 'Posição Y')} />
      <NumberField label="Escala" value={animAt(t.scale, local) * 100} min={1} max={1000} precision={0} step={0.5} unit="%" disabled={locked} onChange={(n) => set('scale', n / 100)} trailing={kf('transform.scale', 'Escala')} />
      <NumberField label="Rotação" value={animAt(t.rotation, local)} min={-360} max={360} precision={1} step={0.5} unit="°" disabled={locked} onChange={(n) => set('rotation', n)} trailing={kf('transform.rotation', 'Rotação')} />
      <NumberField label="Opacidade" value={animAt(t.opacity, local) * 100} min={0} max={100} precision={0} step={0.5} unit="%" disabled={locked} onChange={(n) => set('opacity', n / 100)} trailing={kf('transform.opacity', 'Opacidade')} />
    </PanelSection>
  )
}
