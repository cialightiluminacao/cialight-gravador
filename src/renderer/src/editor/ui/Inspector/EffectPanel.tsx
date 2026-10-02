import { useMemo } from 'react'
import { Maximize, Move, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { attachCandidate, attachEffects, detachEffect } from '@shared/editor/followTransform'
import { convertEffects, findItem, scopeTargetTrack, setAnimValue, setEffectScope, setItemEnabled, type AnimPath } from '@shared/editor/ops'
import { privacyWarnings, type PrivacyWarningKind } from '@shared/editor/privacy'
import type { EffectItem, Project } from '@shared/editor/project'
import { effectRegionAt } from '@shared/editor/resolve'
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
// muda o valor fixo). Avisos de privacidade do trecho do efeito aparecem no topo; o de clipe que se move traz
// "Ancorar ao clipe" (vinculado) ou "Vincular e ancorar" (solto). Ancorado (chave "Ancorado ao clipe: <nome>"): os
// campos da região são relativos à imagem do clipe (fração da fonte; rotação relativa) e o resolve os leva ao quadro.

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
  { value: 'track', label: 'Só a faixa abaixo', title: 'Aplica só à faixa escolhida (a do clipe vinculado)' }
]
const FULL_FRAME = { x: 0.5, y: 0.5, w: 1, h: 1, rotation: 0 }

/** Nome da faixa que o escopo `track` afeta (ops.scopeTargetTrack). */
function scopeTargetName(project: Project, item: EffectItem): string {
  return scopeTargetTrack(project, item.id)?.name ?? 'nenhuma faixa (apagada)'
}

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
  // ancora no clipe que se move (followTransform); solto: entra no grupo do clipe antes
  const followMotion = (kind: PrivacyWarningKind, mediaItemId: string): void => {
    const ok = apply((p) => (kind === 'unlinkedOverMoving' ? attachEffects(p, mediaItemId, [id]) : attachEffects(p, mediaItemId, [id])))
    if (ok) toast.success(kind === 'unlinkedOverMoving' ? 'Vinculado e ancorado ao clipe' : 'Efeito ancorado ao clipe')
  }
  // clipe da âncora (ou o que o efeito pode ancorar: o do grupo de vínculo); âncora perdida = clipe apagado/desativado
  const candidate = useMemo(() => attachCandidate(project, id), [project, id])
  const lost = !!item.attach && !candidate
  const clipName = candidate ? (candidate.name ?? project.assets.find((a) => a.id === candidate.assetId)?.name ?? 'clipe') : ''
  const kf = (path: AnimPath, label: string): React.JSX.Element => <KeyframeButton item={item} path={path} label={label} disabled={locked} />
  // faixa bloqueada: nenhum controle edita
  const lock = <T extends { value: string }>(opts: T[]): (T & { disabled?: boolean })[] => (locked ? opts.map((o) => ({ ...o, disabled: true })) : opts)

  return (
    <>
      {warnings.length ? (
        <div className="space-y-1 border-b border-border px-3 py-2" data-privacy-warnings="">
          {warnings.map((w) => (
            <div key={w.kind} className="rounded-md bg-warn/10 px-2 py-1.5 text-[10.5px] leading-snug text-warn">
              <p className="flex items-start gap-1.5">
                <ShieldAlert className="mt-px h-3 w-3 shrink-0" />
                {w.message}
              </p>
              {w.mediaItemId && (w.kind === 'transformedUnderEffect' || w.kind === 'unlinkedOverMoving') ? (
                <button
                  type="button"
                  disabled={locked}
                  data-follow-motion={w.kind}
                  className="mt-1.5 flex h-6 w-full items-center justify-center gap-1.5 rounded-md border border-warn/40 bg-warn/10 text-[10.5px] font-medium text-warn hover:bg-warn/20 disabled:opacity-40"
                  onClick={() => followMotion(w.kind, w.mediaItemId!)}
                >
                  <Move className="h-3 w-3" />
                  {w.kind === 'transformedUnderEffect' ? 'Ancorar ao clipe' : 'Vincular e ancorar'}
                </button>
              ) : null}
            </div>
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
          {item.scope === 'track' ? <p className="text-[10.5px] text-muted" data-scope-target="">Alvo: {scopeTargetName(project, item)}</p> : null}
        </div>
      </PanelSection>

      <PanelSection title="Região">
        {item.attach || candidate ? (
          <div className="mb-1 space-y-1" data-attach-row="">
            <div className="flex min-h-7 items-center justify-between gap-2 text-[11px]">
              <span className="min-w-0 truncate text-muted" title={clipName}>
                {lost ? 'Ancorado a um clipe apagado ou desativado' : <>{item.attach ? 'Ancorado ao clipe' : 'Ancorar ao clipe'}: <span className="text-fg">{clipName}</span></>}
              </span>
              <Toggle
                size="sm"
                checked={!!item.attach}
                disabled={locked || (!item.attach && !candidate)}
                onCheckedChange={(on) => apply((p) => (on && candidate ? attachEffects(p, candidate.id, [id]) : detachEffect(p, id)))}
                aria-label="Ancorado ao clipe"
              />
            </div>
            {item.attach && !lost ? <p className="text-[10.5px] leading-snug text-muted">Posição e tamanho relativos à imagem do clipe: zoom, pan, corte e rotação dele são acompanhados.</p> : null}
          </div>
        ) : null}
        <NumberField label="Posição X" value={values.x * 100} precision={1} step={0.1} unit="%" disabled={locked} onChange={(n) => setAnim('region.x', n / 100)} title="Centro da região (horizontal)" trailing={kf('region.x', 'Posição X')} />
        <NumberField label="Posição Y" value={values.y * 100} precision={1} step={0.1} unit="%" disabled={locked} onChange={(n) => setAnim('region.y', n / 100)} title="Centro da região (vertical)" trailing={kf('region.y', 'Posição Y')} />
        <NumberField label="Largura" value={values.w * 100} min={1} max={400} precision={1} step={0.1} unit="%" disabled={locked} onChange={(n) => setAnim('region.w', n / 100)} trailing={kf('region.w', 'Largura')} />
        <NumberField label="Altura" value={values.h * 100} min={1} max={400} precision={1} step={0.1} unit="%" disabled={locked} onChange={(n) => setAnim('region.h', n / 100)} trailing={kf('region.h', 'Altura')} />
        <NumberField label="Rotação" value={values.rotation} min={-360} max={360} precision={1} step={0.5} unit="°" disabled={locked} onChange={(n) => setAnim('region.rotation', n)} trailing={kf('region.rotation', 'Rotação')} />
        <button
          type="button"
          disabled={locked}
          className="mt-1 flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-border bg-bg-2 text-[11px] font-medium text-fg-2 hover:border-border-strong hover:text-fg disabled:opacity-40"
          onClick={() => apply((p) => writeRegion(p, id, tUs, effectRegionAt(p, findItem(p, id)!.item as EffectItem, tUs), FULL_FRAME))}
        >
          <Maximize className="h-3 w-3" /> Ajustar ao quadro inteiro
        </button>
      </PanelSection>
    </>
  )
}
