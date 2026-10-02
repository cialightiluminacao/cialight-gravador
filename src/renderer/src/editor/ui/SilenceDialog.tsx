import { useEffect, useMemo, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { AudioLines, Info, LoaderCircle, Lock, Music, TriangleAlert, X } from 'lucide-react'
import { toast } from 'sonner'
import { applySilenceCuts, planSilenceCuts, SILENCE_DEFAULTS, SILENCE_SPEECH_OPTS, speechInCuts, type SilenceCutPlan } from '@shared/editor/silenceCut'
import { audioAnalysisComplete, SPEECH_DEFAULTS, speechFromFile, type SpeechFile, type SpeechInterval } from '@shared/editor/speech'
import { projectDurationUs } from '@shared/editor/ops'
import type { Project } from '@shared/editor/project'
import { Button } from '@/components/ui/Button'
import { Segmented, Slider, Toggle } from '@/components/ui/primitives'
import { mediaUrlsFor } from '../engine/mediaUrls'
import { SpeechLoader } from '../engine/audio/speechLoader'
import { useEditorStore } from '../state/editorStore'
import { useSilencePreview } from '../state/silencePreview'
import { audioItems, defaultSilenceSources, formatDb, formatSaved, silenceSourceTracks } from './silenceSources'

// "Remover silêncios": escolhe as faixas de voz de referência (padrão: todas as de papel Voz), a duração mínima do
// silêncio e a margem; os cortes aparecem em vermelho na régua e nas faixas enquanto o painel está aberto (não modal,
// abaixo da barra superior, sobre o inspetor: linha do tempo e visualizador ficam utilizáveis, e os atalhos de
// transporte continuam valendo) com o total economizado; "Aplicar" corta todas as faixas desbloqueadas num passo de
// desfazer. O limiar de volume vem da análise feita na ingestão (o speech.json guarda só os silêncios brutos): o
// painel o mostra (lido dos arquivos), mas não o altera — dá para exigir silêncios mais longos, não outro limiar.
// Avisa quando outra faixa analisada (ex.: áudio do sistema) tem fala dentro dos cortes, com a opção de incluí-la.

// arquivos de fala pela URL, com o cache do audio worker (SpeechLoader)
const loader = new SpeechLoader(
  async (url) => {
    const r = await fetch(url, { cache: 'no-store' })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  },
  () => {}
)

const fmtS = (us: number, digits = 2): string => `${(us / 1e6).toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })} s`
const MAX_MIN_SILENCE = 3_000_000
const PADDING_RANGE: [number, number] = [0, 500_000]
type Loaded = { key: string; files: Record<string, SpeechFile>; speech: Record<string, SpeechInterval[]> }

/** URLs dos speech.json dos itens com som das faixas (assetId → URL). */
function speechUrls(p: Project, trackIds: readonly string[]): Record<string, string> {
  const urls = mediaUrlsFor(p, 'preview')
  const out: Record<string, string> = {}
  for (const t of p.tracks) {
    if (!trackIds.includes(t.id)) continue
    for (const i of audioItems(p, t)) {
      const u = urls[i.assetId]?.speech
      if (u) out[i.assetId] = u
    }
  }
  return out
}

/** Topo do painel: logo abaixo da barra superior do editor. */
function panelTop(): number {
  const b = document.querySelector('[data-editor-topbar]')?.getBoundingClientRect().bottom
  return Math.round((b ?? 88) + 8)
}

function Note({ tone, icon: Icon, children }: { tone: 'muted' | 'warn' | 'danger'; icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }): React.JSX.Element {
  const color = tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-muted'
  return (
    <div className={`flex items-start gap-1.5 text-[11px] leading-relaxed ${color}`}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div>{children}</div>
    </div>
  )
}

function Field({ label, value, children }: { label: string; value: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-[12px]">
        <span className="font-medium text-fg-2">{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-fg">{value}</span>
      </div>
      {children}
    </div>
  )
}

export function SilenceDialog(): React.JSX.Element | null {
  const open = useSilencePreview((s) => s.open)
  const preferred = useSilencePreview((s) => s.trackId)
  const project = useEditorStore((s) => s.project)
  const inUs = useEditorStore((s) => s.inUs)
  const outUs = useEditorStore((s) => s.outUs)
  const [sources, setSources] = useState<string[]>([])
  const [minSilenceUs, setMinSilence] = useState<number>(SILENCE_DEFAULTS.minSilenceUs)
  const [paddingUs, setPadding] = useState<number>(SILENCE_DEFAULTS.paddingUs)
  const [rangeMode, setRangeMode] = useState<'all' | 'inout'>('all')
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [top, setTop] = useState(96)
  const hasInOut = inUs !== null && outUs !== null && outUs > inUs

  // ao abrir: as faixas de Voz (+ a do menu), trecho I–O se marcado, logo abaixo da barra superior
  useEffect(() => {
    if (!open) return
    const p = useEditorStore.getState().project
    setSources(p ? defaultSilenceSources(p, preferred) : [])
    setRangeMode(hasInOut ? 'inout' : 'all')
    setTop(panelTop())
    const onResize = (): void => setTop(panelTop())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open, preferred])

  // fala de TODAS as faixas com som (as de referência e as que podem ter fala dentro dos cortes); relê quando a
  // análise de um asset chega
  const candidates = useMemo(() => (open && project ? silenceSourceTracks(project) : []), [open, project?.tracks, project?.assets])
  const urls = useMemo(() => (open && project ? speechUrls(project, candidates.map((t) => t.id)) : {}), [open, project?.assets, candidates])
  const urlsKey = JSON.stringify(urls)
  useEffect(() => {
    if (!open) return
    let alive = true
    void loader.loadFiles(urls).then((files) => {
      if (!alive) return
      const speech = Object.fromEntries(Object.entries(files).map(([id, f]) => [id, speechFromFile(f, SILENCE_SPEECH_OPTS)]))
      setLoaded({ key: urlsKey, files, speech })
    })
    return () => {
      alive = false
    }
  }, [open, urlsKey])
  const loading = open && loaded?.key !== urlsKey

  const plan: SilenceCutPlan | null = useMemo(() => {
    if (!open || !project || !sources.length || loading || !loaded) return null
    const range = rangeMode === 'inout' && hasInOut ? { fromUs: inUs!, toUs: outUs! } : undefined
    return planSilenceCuts(project, { sourceTrackIds: sources, minSilenceUs, paddingUs, range }, loaded.speech)
  }, [open, project, sources, loading, loaded, minSilenceUs, paddingUs, rangeMode, hasInOut, inUs, outUs])
  const others = useMemo(
    () => (plan && project && loaded ? speechInCuts(project, plan.cuts, candidates.map((t) => t.id).filter((id) => !sources.includes(id)), loaded.speech) : []),
    [plan, project, loaded, candidates, sources]
  )

  // pré-visualização na linha do tempo
  useEffect(() => {
    useSilencePreview.getState().setCuts(plan?.cuts ?? [])
  }, [plan])

  if (!project) return null
  const name = (id: string): string => project.tracks.find((t) => t.id === id)?.name ?? id
  const sourceAssets = project.tracks.filter((t) => sources.includes(t.id)).flatMap((t) => audioItems(project, t).map((i) => project.assets.find((a) => a.id === i.assetId)!))
  const pending = sourceAssets.filter((a, i, all) => all.indexOf(a) === i && !a.speech && !audioAnalysisComplete(a) && a.status !== 'error')
  const missing = plan ? plan.missingAssetIds.filter((id) => !pending.some((a) => a.id === id)) : []
  const locked = plan ? plan.lockedTrackIds.map(name) : []
  // limiar e silêncio mínimo da análise, lidos dos arquivos das faixas de referência
  const files = sourceAssets.map((a) => loaded?.files[a.id]).filter((f): f is SpeechFile => !!f)
  const thresholds = [...new Set(files.map((f) => f.thresholdDb))].sort((a, b) => a - b)
  const detectMin = files.length ? Math.max(...files.map((f) => f.minSilenceUs)) : SPEECH_DEFAULTS.minSilenceUs
  const minRange: [number, number] = [Math.min(detectMin, MAX_MIN_SILENCE), MAX_MIN_SILENCE]
  const total = projectDurationUs(project)
  const canApply = !!plan && plan.cuts.length > 0 && !plan.blocked

  const close = (): void => useSilencePreview.getState().close()
  const toggleSource = (id: string, on: boolean): void => setSources((s) => (on ? [...s, id] : s.filter((x) => x !== id)))
  const apply = (): void => {
    if (!plan || !canApply) return
    const { cuts, savedUs } = plan
    const st = useEditorStore.getState
    const before = st().history.present
    if (!st().apply((p) => applySilenceCuts(p, cuts))) return
    // "Desfazer" do aviso só desfaz ESTE corte: nada pode ter entrado no histórico depois dele
    const depth = st().history.past.length
    close()
    toast.success(`${cuts.length === 1 ? '1 silêncio removido' : `${cuts.length} silêncios removidos`} (${formatSaved(savedUs)} a menos)`, {
      action: {
        label: 'Desfazer',
        onClick: () => {
          const h = st().history
          if (h.past.length === depth && h.past[depth - 1] === before && !st().txBase) st().undo()
          else toast('Houve outras edições depois: use Desfazer (Ctrl+Z) para voltar passo a passo.')
        }
      }
    })
  }

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) close()
      }}
      modal={false}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          data-silence-dialog=""
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          style={{ top, maxHeight: `calc(100vh - ${top + 12}px)` }}
          className="fixed right-3 z-50 w-[min(380px,92vw)] overflow-y-auto rounded-2xl border border-border-strong bg-surface p-5 shadow-2xl animate-in fade-in-0 zoom-in-95 focus:outline-none"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <DialogPrimitive.Title className="flex items-center gap-2 text-base font-semibold">
                <AudioLines className="h-4 w-4 text-accent" /> Remover silêncios
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1 text-[12px] leading-relaxed text-muted">
                Corta as pausas da voz em todas as faixas desbloqueadas, mantendo tela, webcam, anotações e efeitos em sincronia.
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close className="rounded-lg p-1 text-muted hover:bg-white/5 hover:text-fg" aria-label="Fechar">
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>

          <div className="mt-4 space-y-4">
            <div className="space-y-1.5" role="group" aria-label="Faixas de voz de referência">
              <span className="text-[12px] font-medium text-fg-2">Faixas de voz de referência</span>
              {candidates.length ? (
                <div className="space-y-1 rounded-xl border border-border bg-bg-2 px-3 py-2">
                  {candidates.map((t) => (
                    <label key={t.id} className="flex items-center justify-between gap-2 text-[12px]" data-silence-source={t.id}>
                      <span className="truncate text-fg">
                        {t.name}
                        <span className="ml-1.5 text-[10px] text-muted">{t.role === 'voice' ? 'Voz' : t.role === 'music' ? 'Música' : t.kind === 'video' ? 'Vídeo' : 'Áudio'}</span>
                      </span>
                      <Toggle size="sm" checked={sources.includes(t.id)} onCheckedChange={(on) => toggleSource(t.id, on)} aria-label={`Usar “${t.name}” como referência`} />
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-[12px] text-muted">Nenhuma faixa com som.</p>
              )}
            </div>
            <Field label="Duração mínima do silêncio" value={fmtS(Math.max(minSilenceUs, minRange[0]))}>
              <Slider aria-label="Duração mínima do silêncio" min={minRange[0]} max={minRange[1]} step={50_000} value={[Math.max(minSilenceUs, minRange[0])]} onValueChange={([v]) => setMinSilence(v)} />
            </Field>
            <Field label="Margem antes e depois da fala" value={fmtS(paddingUs)}>
              <Slider aria-label="Margem antes e depois da fala" min={PADDING_RANGE[0]} max={PADDING_RANGE[1]} step={10_000} value={[paddingUs]} onValueChange={([v]) => setPadding(v)} />
            </Field>
            {thresholds.length ? (
              <Note tone="muted" icon={Info}>
                <span data-silence-threshold="">
                  Silêncio = volume abaixo de {thresholds.map(formatDb).join(' / ')} por {fmtS(detectMin)} ou mais (limiar fixado na análise da mídia).
                </span>
              </Note>
            ) : null}
            {hasInOut ? (
              <Segmented
                size="sm"
                value={rangeMode}
                onValueChange={setRangeMode}
                options={[
                  { value: 'all', label: 'Projeto inteiro' },
                  { value: 'inout', label: 'Só o trecho I–O' }
                ]}
              />
            ) : null}

            <div className="rounded-xl border border-border bg-bg-2 px-3 py-2.5" data-silence-summary="" aria-live="polite">
              {loading ? (
                <span className="flex items-center gap-2 text-[12px] text-muted">
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Lendo a análise de fala…
                </span>
              ) : plan && plan.cuts.length ? (
                <div className="flex items-baseline justify-between gap-2 text-[12px]">
                  <span className="text-fg-2">
                    <span className="font-semibold text-fg">{plan.cuts.length}</span> {plan.cuts.length === 1 ? 'silêncio' : 'silêncios'} (em vermelho na linha do tempo)
                  </span>
                  <span className="font-mono text-[11px] tabular-nums text-fg" title={`De ${formatSaved(total)} para ${formatSaved(total - plan.savedUs)}`}>
                    −{formatSaved(plan.savedUs)}
                  </span>
                </div>
              ) : (
                <span className="text-[12px] text-muted">{sources.length ? 'Nenhum silêncio com essa duração nas faixas escolhidas.' : 'Escolha ao menos uma faixa de referência.'}</span>
              )}
            </div>

            {others.map((o) => (
              <Note key={o.trackId} tone="warn" icon={TriangleAlert}>
                <span data-silence-other={o.trackId}>
                  Há fala em “{name(o.trackId)}” dentro de {o.cuts === 1 ? '1 corte' : `${o.cuts} cortes`}.{' '}
                </span>
                <button type="button" className="font-semibold text-fg underline-offset-2 hover:underline" onClick={() => toggleSource(o.trackId, true)}>
                  Incluir como referência
                </button>
              </Note>
            ))}
            {plan?.musicTrackIds.length ? (
              <Note tone="muted" icon={Music}>
                A música em {plan.musicTrackIds.map((id) => `“${name(id)}”`).join(', ')} também será cortada (os cortes valem para todas as faixas desbloqueadas). Bloqueie a faixa para mantê-la contínua.
              </Note>
            ) : null}
            {pending.length ? <Note tone="muted" icon={LoaderCircle}>A fala de {pending.length === 1 ? 'uma mídia' : `${pending.length} mídias`} das faixas de referência ainda está sendo analisada: até lá o trecho dela conta como fala (não é cortado).</Note> : null}
            {missing.length ? <Note tone="warn" icon={TriangleAlert}>{missing.length === 1 ? 'Uma mídia' : `${missing.length} mídias`} das faixas de referência sem análise de fala: o trecho dela conta como fala (não é cortado).</Note> : null}
            {locked.length && !plan?.blocked ? <Note tone="warn" icon={Lock}>Faixas bloqueadas não são cortadas e ficarão fora de sincronia: {locked.join(', ')}.</Note> : null}
            {plan?.blocked ? <Note tone="danger" icon={Lock}>{plan.blocked}</Note> : null}
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={close}>
              Cancelar
            </Button>
            <Button size="sm" variant="primary" disabled={!canApply} onClick={apply}>
              Aplicar
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
