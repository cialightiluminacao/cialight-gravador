import { ArrowDownLeft, ArrowDownRight, ArrowUpLeft, ArrowUpRight, RotateCcw } from 'lucide-react'
import { defaultVisual } from '@shared/editor/factory'
import type { MediaItem, VisualProps } from '@shared/editor/project'
import { applyKenBurns, type ZoomCorner } from '@shared/editor/zoom'
import { Segmented, Tip, Toggle } from '@/components/ui/primitives'
import { useEditorStore } from '../../state/editorStore'
import { usePausedPlayhead } from '../../state/pausedPlayhead'
import { warnLinkedEffects } from '../viewer/ZoomTool'
import { KeyframeButton } from './KeyframeButton'
import { NumberField } from './NumberField'
import { ColorInput, FieldRow, PanelSection, animAt, editItem, editItemTransient, localUs, sec2ToUs, usToSec2, withValue } from './common'

// Inspetor de vídeo do item de mídia: transformação (animável: ◇ liga o keyframe no playhead; com keys,
// editar grava no key do playhead; corte e raio também são animáveis — editados no playhead), Ken Burns (preset de
// zoom lento 1 → 1,15 com pan diagonal ao longo do clipe; substitui a animação de posição/escala), corte, ajuste,
// forma/borda (PiP), espelhar e fades.

type TKey = keyof VisualProps['transform']
type V = MediaItem & { visual: VisualProps }

const FIT_OPTIONS: { value: VisualProps['fit']; label: string; title: string }[] = [
  { value: 'contain', label: 'Conter', title: 'Mostra a imagem inteira (pode sobrar borda)' },
  { value: 'cover', label: 'Cobrir', title: 'Preenche o quadro cortando o excesso' },
  { value: 'fill', label: 'Esticar', title: 'Estica para o tamanho do quadro' }
]
const KEN_BURNS: { corner: ZoomCorner; label: string; icon: React.ReactNode }[] = [
  { corner: 'tl', label: 'Aproximar indo para cima e à esquerda', icon: <ArrowUpLeft className="h-3.5 w-3.5" /> },
  { corner: 'tr', label: 'Aproximar indo para cima e à direita', icon: <ArrowUpRight className="h-3.5 w-3.5" /> },
  { corner: 'bl', label: 'Aproximar indo para baixo e à esquerda', icon: <ArrowDownLeft className="h-3.5 w-3.5" /> },
  { corner: 'br', label: 'Aproximar indo para baixo e à direita', icon: <ArrowDownRight className="h-3.5 w-3.5" /> }
]

function kenBurns(itemId: string, corner: ZoomCorner): void {
  if (useEditorStore.getState().apply((p) => applyKenBurns(p, itemId, corner))) warnLinkedEffects(itemId)
}

const SHAPE_OPTIONS: { value: NonNullable<VisualProps['shape']>; label: string }[] = [
  { value: 'rect', label: 'Retângulo' },
  { value: 'rounded', label: 'Arredondado' },
  { value: 'circle', label: 'Círculo' }
]

export function VideoPanel({ item }: { item: V }): React.JSX.Element {
  // tocando, o inspetor não acompanha o playhead (evita re-render a cada quadro)
  const playheadUs = usePausedPlayhead()
  const local = localUs(item, playheadUs)
  const v = item.visual
  const t = v.transform
  const id = item.id

  const setT = (key: TKey, value: number): void => editItemTransient<V>(id, (d) => { d.visual.transform[key] = withValue(d.visual.transform[key], local, value) })
  const setCrop = (side: keyof VisualProps['crop'], pct: number): void => editItemTransient<V>(id, (d) => { d.visual.crop[side] = withValue(d.visual.crop[side], local, pct / 100) })
  const halfSec = usToSec2(item.durationUs / 2)
  const shape = v.shape ?? 'rect'

  return (
    <>
      <PanelSection
        title="Transformação"
        aside={
          <Tip content="Voltar posição, tamanho, corte e aparência ao padrão">
            <button className="flex h-5 items-center gap-1 rounded px-1.5 text-[10px] font-semibold text-muted hover:bg-white/5 hover:text-fg" onClick={() => editItem<V>(id, (d) => { d.visual = { ...defaultVisual(), fadeInUs: d.visual.fadeInUs, fadeOutUs: d.visual.fadeOutUs } })}>
              <RotateCcw className="h-3 w-3" /> Redefinir
            </button>
          </Tip>
        }
      >
        <NumberField label="Posição X" value={animAt(t.x, local) * 100} precision={1} step={0.1} unit="%" onChange={(n) => setT('x', n / 100)} title="Posição horizontal do centro" trailing={<KeyframeButton item={item} path="transform.x" label="Posição X" />} />
        <NumberField label="Posição Y" value={animAt(t.y, local) * 100} precision={1} step={0.1} unit="%" onChange={(n) => setT('y', n / 100)} title="Posição vertical do centro" trailing={<KeyframeButton item={item} path="transform.y" label="Posição Y" />} />
        <NumberField label="Escala" value={animAt(t.scale, local) * 100} min={1} max={1000} precision={0} step={0.5} unit="%" onChange={(n) => setT('scale', n / 100)} trailing={<KeyframeButton item={item} path="transform.scale" label="Escala" />} />
        <NumberField label="Rotação" value={animAt(t.rotation, local)} min={-360} max={360} precision={1} step={0.5} unit="°" onChange={(n) => setT('rotation', n)} trailing={<KeyframeButton item={item} path="transform.rotation" label="Rotação" />} />
        <NumberField label="Opacidade" value={animAt(t.opacity, local) * 100} min={0} max={100} precision={0} step={0.5} unit="%" onChange={(n) => setT('opacity', n / 100)} trailing={<KeyframeButton item={item} path="transform.opacity" label="Opacidade" />} />
      </PanelSection>

      <PanelSection title="Ken Burns">
        <FieldRow label="Direção">
          <div className="flex gap-1" role="group" aria-label="Ken Burns">
            {KEN_BURNS.map((o) => (
              <Tip key={o.corner} content={`${o.label} (zoom lento 100 → 115 % ao longo do clipe; substitui a animação de posição e escala)`}>
                <button type="button" aria-label={`Ken Burns: ${o.label}`} onClick={() => kenBurns(id, o.corner)} className="flex h-7 w-8 items-center justify-center rounded-md border border-border-strong bg-surface-2 text-fg-2 hover:bg-surface-3 hover:text-fg">
                  {o.icon}
                </button>
              </Tip>
            ))}
          </div>
        </FieldRow>
      </PanelSection>

      <PanelSection title="Corte">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <NumberField compact label="Esquerda" value={animAt(v.crop.l, local) * 100} min={0} max={95} precision={1} step={0.2} unit="%" onChange={(n) => setCrop('l', n)} />
          <NumberField compact label="Direita" value={animAt(v.crop.r, local) * 100} min={0} max={95} precision={1} step={0.2} unit="%" onChange={(n) => setCrop('r', n)} />
          <NumberField compact label="Topo" value={animAt(v.crop.t, local) * 100} min={0} max={95} precision={1} step={0.2} unit="%" onChange={(n) => setCrop('t', n)} />
          <NumberField compact label="Base" value={animAt(v.crop.b, local) * 100} min={0} max={95} precision={1} step={0.2} unit="%" onChange={(n) => setCrop('b', n)} />
        </div>
        <FieldRow label="Ajuste">
          <Segmented size="sm" className="w-full [&>*]:flex-1" value={v.fit} options={FIT_OPTIONS} onValueChange={(fit) => editItem<V>(id, (d) => { d.visual.fit = fit })} />
        </FieldRow>
      </PanelSection>

      <PanelSection title="Forma e borda">
        <Segmented size="sm" className="flex w-full [&>*]:flex-1" value={shape} options={SHAPE_OPTIONS} onValueChange={(sh) => editItem<V>(id, (d) => { d.visual.shape = sh })} />
        {shape === 'rounded' ? <NumberField label="Raio" value={v.radius ? animAt(v.radius, local) : 0} min={0} max={1000} step={0.5} unit="px" onChange={(n) => editItemTransient<V>(id, (d) => { d.visual.radius = withValue(d.visual.radius ?? { value: 0 }, local, n) })} title="0 = arredondamento automático" /> : null}
        <NumberField label="Borda" value={v.border?.width ?? 0} min={0} max={100} step={0.2} unit="px" onChange={(n) => editItemTransient<V>(id, (d) => { d.visual.border = n > 0 ? { width: n, color: d.visual.border?.color ?? '#ffffff' } : undefined })} />
        {v.border ? (
          <FieldRow label="Cor da borda">
            <ColorInput label="Cor da borda" value={v.border.color} onChange={(hex) => editItemTransient<V>(id, (d) => { if (d.visual.border) d.visual.border.color = hex })} />
          </FieldRow>
        ) : null}
        <FieldRow label="Espelhar">
          <Toggle size="sm" checked={!!v.mirror} onCheckedChange={(on) => editItem<V>(id, (d) => { d.visual.mirror = on })} aria-label="Espelhar horizontalmente" />
        </FieldRow>
      </PanelSection>

      <PanelSection title="Fade de vídeo">
        <div className="grid grid-cols-2 gap-x-3">
          <NumberField compact label="Entrada" value={usToSec2(v.fadeInUs)} min={0} max={halfSec} precision={2} step={0.01} unit="s" onChange={(n) => editItemTransient<V>(id, (d) => { d.visual.fadeInUs = sec2ToUs(n) })} />
          <NumberField compact label="Saída" value={usToSec2(v.fadeOutUs)} min={0} max={halfSec} precision={2} step={0.01} unit="s" onChange={(n) => editItemTransient<V>(id, (d) => { d.visual.fadeOutUs = sec2ToUs(n) })} />
        </div>
      </PanelSection>
    </>
  )
}
