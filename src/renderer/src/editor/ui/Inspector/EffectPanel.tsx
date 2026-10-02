import { useMemo } from 'react'
import { Maximize, ShieldAlert } from 'lucide-react'
import { convertEffects, setAnimValue, setEffectScope, setItemEnabled, type AnimPath } from '@shared/editor/ops'
import { privacyWarnings } from '@shared/editor/privacy'
import type { EffectItem, Project } from '@shared/editor/project'
import { itemEndUs } from '@shared/editor/time'
import { Segmented, Toggle } from '@/components/ui/primitives'
import { useEditorStore } from '../../state/editorStore'
import { usePausedPlayhead } from '../../state/pausedPlayhead'
import { writeRegion } from '../viewerGeometry'
import { KeyframeButton } from './KeyframeButton'
import { NumberField } from './NumberField'
import { ColorInput, FieldRow, PanelSection, animAt, editItem, editItemTransient, localUs } from './common'

// Inspetor do efeito de privacidade: tipo, forma, intensidade (ou cor da tarja), borda suave, inverter,
// escopo e a região (posição, tamanho, rotação). Intensidade e região são animáveis (KeyframeButton);
// editar grava como no visualizador (setAnimValue no playhead: com keys cria/atualiza o key, sem keys
// muda o valor fixo). Avisos de privacidade do trecho do efeito aparecem no topo.

const TYPE_OPTIONS: { value: EffectItem['effect']; label: string }[] = [
  { value: 'blur', label: 'Blur' },
  { value: 'pixelate', label: 'Pixelizar' },
  { value: 'solid', label: 'Tarja' }
]
const SHAPE_OPTIONS: { value: EffectItem['region']['shape']; label: string }[] = [
  { value: 'rect', label: 'Retângulo' },
  { value: 'ellipse', label: 'Elipse' }
]
const SCOPE_OPTIONS: { value: EffectItem['scope']; label: string; title: string }[] = [
  { value: 'below', label: 'Tudo abaixo', title: 'Aplica a todas as faixas abaixo do efeito' },
  { value: 'track', label: 'Só a faixa abaixo', title: 'Aplica só à faixa logo abaixo do efeito' }
]
const FULL_FRAME = { x: 0.5, y: 0.5, w: 1, h: 1, rotation: 0 }

export function EffectPanel({ project, item, locked }: { project: Project; item: EffectItem; locked: boolean }): React.JSX.Element {
  // tocando, o inspetor não acompanha o playhead (evita re-render a cada quadro)
  const playheadUs = usePausedPlayhead()
  const local = localUs(item, playheadUs)
  const tUs = item.startUs + local // fora do item, edita no instante mais próximo dentro dele
  const id = item.id
  const r = item.region
  const apply = useEditorStore((s) => s.apply)
  const setAnim = (path: AnimPath, v: number): boolean => apply((p) => setAnimValue(p, id, path, tUs, v), { transient: true })
  const values = { x: animAt(r.x, local), y: animAt(r.y, local), w: animAt(r.w, local), h: animAt(r.h, local), rotation: animAt(r.rotation, local) }
  const warnings = useMemo(() => privacyWarnings(project, item.startUs, itemEndUs(item)).filter((w) => w.itemId === id), [project, item, id])
  const enabled = item.enabled !== false
  const kf = (path: AnimPath, label: string): React.JSX.Element => <KeyframeButton item={item} path={path} label={label} disabled={locked} />
  // faixa bloqueada: nenhum controle edita
  const lock = <T extends { value: string }>(opts: T[]): (T & { disabled?: boolean })[] => (locked ? opts.map((o) => ({ ...o, disabled: true })) : opts)

  return (
    <>
      {warnings.length ? (
        <div className="space-y-1 border-b border-border px-3 py-2" data-privacy-warnings="">
          {warnings.map((w) => (
            <p key={w.kind} className="flex items-start gap-1.5 rounded-md bg-warn/10 px-2 py-1.5 text-[10.5px] leading-snug text-warn">
              <ShieldAlert className="mt-px h-3 w-3 shrink-0" />
              {w.message}
            </p>
          ))}
        </div>
      ) : null}

      <PanelSection title="Efeito" aside={<Toggle size="sm" checked={enabled} disabled={locked} onCheckedChange={(on) => apply((p) => setItemEnabled(p, [id], on))} aria-label="Ativar efeito" />}>
        <Segmented size="sm" className="flex w-full [&>*]:flex-1" value={item.effect} options={lock(TYPE_OPTIONS)} onValueChange={(v) => apply((p) => convertEffects(p, [id], v))} />
        <FieldRow label="Forma">
          <Segmented size="sm" className="w-full [&>*]:flex-1" value={r.shape} options={lock(SHAPE_OPTIONS)} onValueChange={(shape) => editItem<EffectItem>(id, (d) => { d.region.shape = shape })} />
        </FieldRow>
        {item.effect === 'solid' ? (
          <FieldRow label="Cor">
            <span className="font-mono text-[10.5px] uppercase text-muted">{item.color}</span>
            <ColorInput label="Cor da tarja" disabled={locked} value={item.color} onChange={(hex) => editItemTransient<EffectItem>(id, (d) => { d.color = hex })} />
          </FieldRow>
        ) : (
          <NumberField label="Intensidade" value={animAt(item.strength, local)} min={0} max={100} precision={0} step={0.5} disabled={locked} onChange={(n) => setAnim('strength', n)} title={item.effect === 'blur' ? 'Raio do desfoque' : 'Tamanho dos blocos'} trailing={kf('strength', 'Intensidade')} />
        )}
        <NumberField label="Borda suave" value={item.feather * 100} min={0} max={100} precision={0} step={0.5} unit="%" disabled={locked} onChange={(n) => editItemTransient<EffectItem>(id, (d) => { d.feather = n / 100 })} />
        <div className="flex min-h-7 items-center justify-between gap-2 text-[11px]">
          <span className="text-muted">Borrar tudo menos a região</span>
          <Toggle size="sm" checked={item.invert} disabled={locked} onCheckedChange={(on) => editItem<EffectItem>(id, (d) => { d.invert = on })} aria-label="Borrar tudo menos a região" />
        </div>
        <div className="space-y-1 pt-0.5 text-[11px]">
          <span className="text-muted">Escopo</span>
          <Segmented size="sm" className="flex w-full [&>*]:flex-1" value={item.scope} options={lock(SCOPE_OPTIONS)} onValueChange={(scope) => apply((p) => setEffectScope(p, id, scope))} />
        </div>
      </PanelSection>

      <PanelSection title="Região">
        <NumberField label="Posição X" value={values.x * 100} precision={1} step={0.1} unit="%" disabled={locked} onChange={(n) => setAnim('region.x', n / 100)} title="Centro da região (horizontal)" trailing={kf('region.x', 'Posição X')} />
        <NumberField label="Posição Y" value={values.y * 100} precision={1} step={0.1} unit="%" disabled={locked} onChange={(n) => setAnim('region.y', n / 100)} title="Centro da região (vertical)" trailing={kf('region.y', 'Posição Y')} />
        <NumberField label="Largura" value={values.w * 100} min={1} max={400} precision={1} step={0.1} unit="%" disabled={locked} onChange={(n) => setAnim('region.w', n / 100)} trailing={kf('region.w', 'Largura')} />
        <NumberField label="Altura" value={values.h * 100} min={1} max={400} precision={1} step={0.1} unit="%" disabled={locked} onChange={(n) => setAnim('region.h', n / 100)} trailing={kf('region.h', 'Altura')} />
        <NumberField label="Rotação" value={values.rotation} min={-360} max={360} precision={1} step={0.5} unit="°" disabled={locked} onChange={(n) => setAnim('region.rotation', n)} trailing={kf('region.rotation', 'Rotação')} />
        <button
          type="button"
          disabled={locked}
          className="mt-1 flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-border bg-bg-2 text-[11px] font-medium text-fg-2 hover:border-border-strong hover:text-fg disabled:opacity-40"
          onClick={() => apply((p) => writeRegion(p, id, tUs, values, FULL_FRAME))}
        >
          <Maximize className="h-3 w-3" /> Ajustar ao quadro inteiro
        </button>
      </PanelSection>
    </>
  )
}
