import { useRef } from 'react'
import { CURSOR_FX_LIMITS, DEFAULT_CURSOR_FX, type CursorFx, type MediaItem } from '@shared/editor/project'
import { Slider, Toggle } from '@/components/ui/primitives'
import { useCursorTrack } from '../../engine/cursorTracks'
import { useEditorStore } from '../../state/editorStore'
import { ColorInput, FieldRow, PanelSection } from './common'
import { updateCursorFx } from './cursorFxEdit'

// "Cursor e cliques" (F6) no inspetor do clipe de tela (só com a trilha do cursor gravada): realce dos cliques (anel
// que pulsa no ponto clicado; botões direito e do meio usam o mesmo anel) e cursor ampliado/suavizado, desenhados pelo
// compositor (preview = exportação). cursorFx ausente: criado do padrão na 1ª mudança (updateCursorFx). Cada gesto de
// slider é um passo de desfazer (begin → mudanças transitórias → commitTx); toggles e o fim do seletor de cor também.

const nf = (n: number, d: number): string => n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d })

type Group = keyof CursorFx
interface SliderSpec<G extends Group> { group: G; key: Exclude<keyof CursorFx[G], 'enabled' | 'color'>; label: string; title: string; step: number; show: (v: number) => string }
const HIGHLIGHT: SliderSpec<'highlight'>[] = [
  { group: 'highlight', key: 'sizePx', label: 'Tamanho', title: 'Raio máximo do anel (px do vídeo gravado)', step: 1, show: (v) => `${Math.round(v)} px` },
  { group: 'highlight', key: 'durationMs', label: 'Duração', title: 'Quanto o anel leva para sumir', step: 10, show: (v) => `${nf(v / 1000, 2)} s` }
]
const CURSOR: SliderSpec<'cursor'>[] = [
  { group: 'cursor', key: 'scale', label: 'Escala', title: 'Tamanho do cursor desenhado por cima do gravado', step: 0.1, show: (v) => `${nf(v, 1)}×` },
  { group: 'cursor', key: 'smoothing', label: 'Suavização', title: 'Filtra o tremor do movimento (nunca se afasta mais de 4 px do cursor gravado)', step: 0.05, show: (v) => `${Math.round(v * 100)} %` }
]

function FxSlider<G extends Group>({ itemId, fx, spec, disabled }: { itemId: string; fx: CursorFx; spec: SliderSpec<G>; disabled: boolean }): React.JSX.Element {
  const sliding = useRef(false)
  const lim = CURSOR_FX_LIMITS[spec.key as keyof typeof CURSOR_FX_LIMITS]
  const value = fx[spec.group][spec.key] as number
  const set = (v: number): void => {
    useEditorStore.getState().apply((p) => updateCursorFx(p, itemId, (d) => { (d[spec.group] as Record<string, unknown>)[spec.key as string] = v }), { transient: true })
  }
  return (
    <div className="space-y-1" title={spec.title}>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted">{spec.label}</span>
        <span className="tabular-nums text-fg-2">{spec.show(value)}</span>
      </div>
      <Slider
        aria-label={spec.label}
        aria-valuetext={spec.show(value)}
        min={lim.min}
        max={lim.max}
        step={spec.step}
        disabled={disabled}
        value={[value]}
        onValueChange={([v]) => {
          if (!sliding.current) {
            sliding.current = true
            useEditorStore.getState().begin()
          }
          set(v)
        }}
        onValueCommit={() => {
          sliding.current = false
          useEditorStore.getState().commitTx()
        }}
      />
    </div>
  )
}

export function CursorFxPanel({ item, locked }: { item: MediaItem; locked?: boolean }): React.JSX.Element {
  const track = useCursorTrack(item.assetId)
  const fx = item.cursorFx ?? DEFAULT_CURSOR_FX
  const id = item.id
  const disabled = !!locked
  const toggle = (group: Group, on: boolean): void => {
    useEditorStore.getState().apply((p) => updateCursorFx(p, id, (d) => { d[group].enabled = on }))
  }
  const clicks = track?.clicks.length ?? null
  return (
    <PanelSection title="Cursor e cliques" aside={clicks !== null ? <span className="text-[10px] tabular-nums text-muted">{clicks === 1 ? '1 clique gravado' : `${clicks} cliques gravados`}</span> : undefined}>
      <div data-cursor-fx="" className="space-y-2">
        <FieldRow label="Realçar cliques">
          <Toggle size="sm" checked={fx.highlight.enabled} disabled={disabled} onCheckedChange={(on) => toggle('highlight', on)} aria-label="Realçar cliques" />
        </FieldRow>
        <FieldRow label="Cor do realce">
          <span className="font-mono text-[10.5px] uppercase text-muted">{fx.highlight.color}</span>
          <ColorInput label="Cor do realce dos cliques" value={fx.highlight.color} disabled={disabled || !fx.highlight.enabled} onChange={(hex) => useEditorStore.getState().apply((p) => updateCursorFx(p, id, (d) => { d.highlight.color = hex }), { transient: true })} />
        </FieldRow>
        {HIGHLIGHT.map((sp) => <FxSlider key={sp.key} itemId={id} fx={fx} spec={sp} disabled={disabled || !fx.highlight.enabled} />)}
        <FieldRow label="Cursor ampliado" className="pt-1">
          <Toggle size="sm" checked={fx.cursor.enabled} disabled={disabled} onCheckedChange={(on) => toggle('cursor', on)} aria-label="Cursor ampliado" />
        </FieldRow>
        {CURSOR.map((sp) => <FxSlider key={sp.key} itemId={id} fx={fx} spec={sp} disabled={disabled || !fx.cursor.enabled} />)}
        {locked ? <p className="text-[11px] leading-snug text-muted" role="status">A faixa deste clipe está bloqueada.</p> : null}
        {!track && (fx.highlight.enabled || fx.cursor.enabled) ? <p className="text-[11px] leading-snug text-muted" role="status">Lendo a trilha do cursor… Se não carregar, os efeitos não aparecem neste clipe.</p> : null}
      </div>
    </PanelSection>
  )
}
