import { Eye, MousePointerClick, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { applyAutoZoom, AUTO_ZOOM_LIMITS, DEFAULT_AUTO_ZOOM, itemClicks, type AutoZoomOpts } from '@shared/editor/autoZoom'
import { cursorTimeMap } from '@shared/editor/cursorTime'
import type { MediaItem } from '@shared/editor/project'
import { Button } from '@/components/ui/Button'
import { Slider, Tip } from '@/components/ui/primitives'
import { useCursorTrack } from '../../engine/cursorTracks'
import { useEditorStore } from '../../state/editorStore'
import { warnLinkedEffects } from '../viewer/ZoomTool'
import { PanelSection } from './common'

// "Zoom automático nos cliques" (F6) no inspetor do clipe de tela (só com a trilha do cursor gravada): gera os keys
// de zoom/pan a partir dos cliques (shared/editor/autoZoom). "Pré-visualizar" abre uma transação e aplica como
// transitório (nada no histórico; mexer nos controles refaz a prévia a partir do projeto de antes); "Aplicar" grava
// um passo de desfazer (fechando a prévia, se aberta); "Cancelar" descarta. Depois de aplicar: toast com os zooms e
// os keyframes trocados, e a oferta do F4 de ancorar os efeitos de privacidade sem âncora (warnLinkedEffects).

const nf = (n: number, d: number): string => n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d })

interface SliderSpec { key: keyof AutoZoomOpts; label: string; title: string; step: number; show: (v: number) => string }
const SLIDERS: SliderSpec[] = [
  { key: 'scale', label: 'Intensidade', title: 'Quanto o zoom aproxima', step: 0.05, show: (v) => `${nf(v, 2)}×` },
  { key: 'holdMs', label: 'Duração', title: 'Quanto o zoom fica depois do último clique', step: 100, show: (v) => `${nf(v / 1000, 1)} s` },
  { key: 'transitionMs', label: 'Transição', title: 'Duração da aproximação e da volta', step: 50, show: (v) => `${nf(v / 1000, 2)} s` },
  { key: 'smoothing', label: 'Suavidade', title: 'Quão suave o enquadramento segue o cursor durante o zoom', step: 0.05, show: (v) => `${Math.round(v * 100)} %` }
]

export function AutoZoomPanel({ item, locked }: { item: MediaItem; locked?: boolean }): React.JSX.Element {
  const track = useCursorTrack(item.assetId)
  const project = useEditorStore((s) => s.project)
  const txOpen = useEditorStore((s) => s.txBase !== null)
  const [opts, setOpts] = useState<AutoZoomOpts>(DEFAULT_AUTO_ZOOM)
  const [previewing, setPreviewing] = useState(false)
  const previewRef = useRef(false)
  previewRef.current = previewing

  const clicks = useMemo(() => {
    if (!track || !project) return 0
    const map = cursorTimeMap(project, item)
    return map ? itemClicks(track, map).length : 0
  }, [track, project, item])

  // a prévia foi encerrada por fora (desfazer, outra edição): o painel volta ao normal
  useEffect(() => {
    if (previewing && !txOpen) setPreviewing(false)
  }, [previewing, txOpen])
  // sair do painel (outra seleção) com a prévia aberta: descarta
  useEffect(() => () => {
    if (previewRef.current) useEditorStore.getState().cancelTx()
  }, [])

  const blocked = locked
    ? 'A faixa deste clipe está bloqueada'
    : item.reverse || item.freeze
      ? 'O zoom automático não funciona em clipes invertidos ou congelados'
      : !track
        ? 'Lendo a trilha do cursor… (se não carregar, a gravação não tem cliques utilizáveis)'
        : clicks === 0
          ? 'Nenhum clique gravado no trecho usado deste clipe'
          : null

  /** Gera os zooms a partir do projeto de antes da prévia; transitório = dentro da transação aberta. */
  const run = (o: AutoZoomOpts, transient: boolean): { segments: number; replaced: number } | null => {
    const st = useEditorStore.getState()
    const base = st.txBase ?? st.project
    if (!base || !track) return null
    let out: { segments: number; replaced: number } | null = null
    const ok = st.apply(() => {
      const r = applyAutoZoom(base, item.id, track, o)
      out = { segments: r.segments, replaced: r.replaced }
      return r.project
    }, transient ? { transient: true } : undefined)
    return ok ? out : null
  }

  const preview = (): void => {
    const st = useEditorStore.getState()
    st.begin()
    if (run(opts, true)) setPreviewing(true)
    else st.cancelTx()
  }
  const cancel = (): void => {
    useEditorStore.getState().cancelTx()
    setPreviewing(false)
  }
  const apply = (): void => {
    const r = run(opts, false)
    setPreviewing(false)
    if (!r) return
    toast.success(r.segments === 1 ? '1 zoom automático aplicado' : `${r.segments} zooms automáticos aplicados`, {
      description: `${r.replaced > 0 ? (r.replaced === 1 ? '1 keyframe existente foi substituído. ' : `${r.replaced} keyframes existentes foram substituídos. `) : ''}Ctrl+Z desfaz.`
    })
    warnLinkedEffects(item.id, 'o zoom automático')
  }
  const commitSlider = (o: AutoZoomOpts): void => {
    if (previewRef.current) run(o, true)
  }

  const disabled = !!blocked
  return (
    <PanelSection title="Zoom automático nos cliques" aside={track ? <span className="text-[10px] tabular-nums text-muted">{clicks === 1 ? '1 clique' : `${clicks} cliques`}</span> : undefined}>
      <div data-auto-zoom="" className="space-y-2">
        {SLIDERS.map((sp) => {
          const lim = AUTO_ZOOM_LIMITS[sp.key]
          return (
            <div key={sp.key} className="space-y-1" title={sp.title}>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-muted">{sp.label}</span>
                <span className="tabular-nums text-fg-2">{sp.show(opts[sp.key])}</span>
              </div>
              <Slider
                aria-label={sp.label}
                aria-valuetext={sp.show(opts[sp.key])}
                min={lim.min}
                max={lim.max}
                step={sp.step}
                disabled={disabled}
                value={[opts[sp.key]]}
                onValueChange={([v]) => setOpts((o) => ({ ...o, [sp.key]: v }))}
                onValueCommit={([v]) => commitSlider({ ...opts, [sp.key]: v })}
              />
            </div>
          )
        })}
        <div className="flex gap-1.5 pt-1">
          {previewing ? (
            <Button size="sm" variant="ghost" className="flex-1" onClick={cancel}>
              <X className="h-3.5 w-3.5" /> Cancelar
            </Button>
          ) : (
            <Tip content={blocked ?? 'Mostra os zooms sem gravar no histórico'}>
              <span className="flex flex-1">
                <Button size="sm" variant="secondary" className="flex-1" disabled={disabled} onClick={preview}>
                  <Eye className="h-3.5 w-3.5" /> Pré-visualizar
                </Button>
              </span>
            </Tip>
          )}
          <Tip content={blocked ?? 'Grava os zooms (um passo de desfazer)'}>
            <span className="flex flex-1">
              <Button size="sm" variant="primary" className="flex-1" disabled={disabled} onClick={apply}>
                <MousePointerClick className="h-3.5 w-3.5" /> Aplicar
              </Button>
            </span>
          </Tip>
        </div>
        {previewing ? <p className="text-[11px] leading-snug text-fg-2" role="status">Pré-visualização: toque o trecho para conferir. Ajustes nos controles refazem os zooms.</p> : null}
        {blocked && track ? <p className="text-[11px] leading-snug text-muted">{blocked}</p> : null}
      </div>
    </PanelSection>
  )
}
