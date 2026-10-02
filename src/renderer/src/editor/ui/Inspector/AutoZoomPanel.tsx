import { Eye, MousePointerClick, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { applyAutoZoom, AUTO_ZOOM_LIMITS, DEFAULT_AUTO_ZOOM, itemClicks, type AutoZoomOpts } from '@shared/editor/autoZoom'
import { cursorTimeMap } from '@shared/editor/cursorTime'
import { EditError } from '@shared/editor/ops'
import type { MediaItem, Project } from '@shared/editor/project'
import { Button } from '@/components/ui/Button'
import { Slider, Tip } from '@/components/ui/primitives'
import { useCursorTrack } from '../../engine/cursorTracks'
import { useEditorStore } from '../../state/editorStore'
import { warnLinkedEffects } from '../viewer/ZoomTool'
import { PanelSection } from './common'

// "Zoom automático nos cliques" (F6) no inspetor do clipe de tela (só com a trilha do cursor gravada): gera os keys
// de zoom/pan a partir dos cliques (shared/editor/autoZoom). "Pré-visualizar" põe o resultado como prévia FORA do
// histórico (store.preview: só o visualizador a desenha; nenhuma transação aberta, então nenhuma outra edição pode
// gravá-la — qualquer mudança do projeto a descarta, com aviso); mexer nos controles refaz a prévia. "Aplicar" é uma
// edição normal sobre o projeto atual (um passo de desfazer); "Cancelar" descarta a prévia. Depois de aplicar: toast
// com os zooms e os keyframes trocados, e a oferta do F4 de ancorar os efeitos de privacidade sem âncora.

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
  const shownPreview = useEditorStore((s) => s.preview)
  const [opts, setOpts] = useState<AutoZoomOpts>(DEFAULT_AUTO_ZOOM)
  const optsRef = useRef(opts)
  optsRef.current = opts
  /** A prévia que este painel pôs no store (null = nenhuma). */
  const mine = useRef<Project | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [appliedOnce, setAppliedOnce] = useState(false)

  const clicks = useMemo(() => {
    if (!track || !project) return 0
    const map = cursorTimeMap(project, item)
    return map ? itemClicks(track, map).length : 0
  }, [track, project, item])

  // a prévia sumiu por fora (o projeto foi editado, desfeito…): nada foi gravado; o painel avisa e volta ao normal
  useEffect(() => {
    if (!previewing || shownPreview === mine.current) return
    mine.current = null
    setPreviewing(false)
    toast.info('Pré-visualização do zoom automático descartada', { description: 'O projeto mudou. Nada foi gravado; pré-visualize de novo se quiser.' })
  }, [previewing, shownPreview])
  // sair do painel (outra seleção) com a prévia aberta: descarta
  useEffect(() => () => {
    const st = useEditorStore.getState()
    if (mine.current && st.preview === mine.current) st.setPreview(null)
  }, [])

  const tooShort = item.durationUs <= Math.round(opts.transitionMs * 1000)
  const blocked = locked
    ? 'A faixa deste clipe está bloqueada.'
    : item.reverse || item.freeze
      ? 'O zoom automático não funciona em clipes invertidos ou congelados.'
      : !track
        ? 'Lendo a trilha do cursor… Se não carregar, a gravação não tem cliques utilizáveis.'
        : clicks === 0
          ? 'Nenhum clique gravado no trecho usado deste clipe.'
          : tooShort
            ? 'O clipe é mais curto que a transição: diminua a Transição ou use um trecho maior.'
            : null

  /** Prévia fora do histórico, calculada sobre o projeto atual (qualquer edição a descarta — store). */
  const showPreview = (o: AutoZoomOpts): void => {
    const st = useEditorStore.getState()
    if (!st.project || !track) return
    try {
      const r = applyAutoZoom(st.project, item.id, track, o)
      mine.current = r.project
      st.setPreview(r.project)
      setPreviewing(true)
    } catch (e) {
      if (!(e instanceof EditError)) throw e
      toast.error(e.message)
      cancel()
    }
  }
  const cancel = (): void => {
    const st = useEditorStore.getState()
    if (mine.current && st.preview === mine.current) st.setPreview(null)
    mine.current = null
    setPreviewing(false)
  }
  const apply = (): void => {
    if (!track) return
    let out: { segments: number; replaced: number } | null = null
    // edição normal sobre o projeto atual: um passo de desfazer; a prévia (se houver) some com a mudança do projeto
    const ok = useEditorStore.getState().apply((p) => {
      const r = applyAutoZoom(p, item.id, track, optsRef.current)
      out = { segments: r.segments, replaced: r.replaced }
      return r.project
    })
    mine.current = null
    setPreviewing(false)
    const r = out as { segments: number; replaced: number } | null
    if (!ok || !r) return
    const again = appliedOnce ? ' Para trocar os ajustes de um zoom automático já aplicado, desfaça-o antes (Ctrl+Z): aplicar de novo soma os zooms.' : ''
    toast.success(r.segments === 1 ? '1 zoom automático aplicado' : `${r.segments} zooms automáticos aplicados`, {
      description: `${r.replaced > 0 ? (r.replaced === 1 ? '1 keyframe existente foi substituído. ' : `${r.replaced} keyframes existentes foram substituídos. `) : ''}Ctrl+Z desfaz.${again}`
    })
    setAppliedOnce(true)
    warnLinkedEffects(item.id, 'o zoom automático')
  }
  const commitSlider = (key: keyof AutoZoomOpts, v: number): void => {
    const o = { ...optsRef.current, [key]: v }
    optsRef.current = o
    if (previewing) showPreview(o)
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
                onValueCommit={([v]) => commitSlider(sp.key, v)}
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
                <Button size="sm" variant="secondary" className="flex-1" disabled={disabled} onClick={() => showPreview(optsRef.current)}>
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
        {previewing ? <p className="text-[11px] leading-snug text-fg-2" role="status">Pré-visualização (fora do histórico): toque o trecho para conferir. Ajustes nos controles refazem os zooms; qualquer outra edição descarta a prévia.</p> : null}
        {blocked ? <p data-auto-zoom-reason="" className="text-[11px] leading-snug text-muted" role="status">{blocked}</p> : null}
        {appliedOnce && !previewing ? <p className="text-[11px] leading-snug text-muted">Já aplicado: para mudar os ajustes, desfaça o zoom automático anterior (Ctrl+Z) antes de aplicar de novo.</p> : null}
      </div>
    </PanelSection>
  )
}
