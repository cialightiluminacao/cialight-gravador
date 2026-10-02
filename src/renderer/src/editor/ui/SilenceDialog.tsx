import { useEffect, useMemo, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { AudioLines, Info, LoaderCircle, Lock, TriangleAlert, X } from 'lucide-react'
import { toast } from 'sonner'
import { applySilenceCuts, planSilenceCuts, SILENCE_DEFAULTS, SILENCE_SPEECH_OPTS, type SilenceCutPlan } from '@shared/editor/silenceCut'
import { audioAnalysisComplete, SPEECH_DEFAULTS, type SpeechInterval } from '@shared/editor/speech'
import { projectDurationUs } from '@shared/editor/ops'
import type { Project } from '@shared/editor/project'
import { Button } from '@/components/ui/Button'
import { Segmented, Select, Slider } from '@/components/ui/primitives'
import { mediaUrlsFor } from '../engine/mediaUrls'
import { SpeechLoader } from '../engine/audio/speechLoader'
import { useEditorStore } from '../state/editorStore'
import { useSilencePreview } from '../state/silencePreview'
import { audioItems, defaultSilenceSource, formatSaved, silenceSourceTracks } from './silenceSources'

// "Remover silêncios": escolhe a faixa de voz de referência, a duração mínima do silêncio e a margem; os cortes
// aparecem em vermelho na régua e nas faixas enquanto o painel está aberto (não modal, sobre o inspetor: a linha do
// tempo e o visualizador ficam visíveis e utilizáveis)
// com o total economizado; "Aplicar" corta todas as faixas desbloqueadas num passo de desfazer.
// O limiar de volume (−35 dB) vem da análise feita na ingestão (o speech.json guarda só os silêncios brutos): o painel
// o mostra, mas não o altera — dá para exigir silêncios mais longos, não um limiar diferente.

// fala sem margem nem mescla (a margem é do painel); cache por URL como no audio worker
const loader = new SpeechLoader(
  async (url) => {
    const r = await fetch(url, { cache: 'no-store' })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  },
  () => {},
  SILENCE_SPEECH_OPTS
)

const fmtS = (us: number, digits = 2): string => `${(us / 1e6).toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })} s`
const MIN_SILENCE_RANGE: [number, number] = [SPEECH_DEFAULTS.minSilenceUs, 3_000_000]
const PADDING_RANGE: [number, number] = [0, 500_000]

/** URLs dos speech.json dos itens com som da faixa (assetId → URL). */
function speechUrls(p: Project, trackId: string | null): Record<string, string> {
  const t = p.tracks.find((x) => x.id === trackId)
  if (!t) return {}
  const urls = mediaUrlsFor(p, 'preview')
  const out: Record<string, string> = {}
  for (const i of audioItems(p, t)) {
    const u = urls[i.assetId]?.speech
    if (u) out[i.assetId] = u
  }
  return out
}

function Note({ tone, icon: Icon, children }: { tone: 'muted' | 'warn' | 'danger'; icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }): React.JSX.Element {
  const color = tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-muted'
  return (
    <p className={`flex items-start gap-1.5 text-[11px] leading-relaxed ${color}`}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </p>
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
  const [trackId, setTrackId] = useState<string | null>(null)
  const [minSilenceUs, setMinSilence] = useState<number>(SILENCE_DEFAULTS.minSilenceUs)
  const [paddingUs, setPadding] = useState<number>(SILENCE_DEFAULTS.paddingUs)
  const [rangeMode, setRangeMode] = useState<'all' | 'inout'>('all')
  const [speech, setSpeech] = useState<{ key: string; data: Record<string, SpeechInterval[]> } | null>(null)
  const hasInOut = inUs !== null && outUs !== null && outUs > inUs

  // ao abrir: a faixa sugerida (menu) ou a primeira de voz; trecho I–O se marcado
  useEffect(() => {
    if (!open) return
    const p = useEditorStore.getState().project
    setTrackId(p ? defaultSilenceSource(p, preferred) : null)
    setRangeMode(hasInOut ? 'inout' : 'all')
  }, [open, preferred])

  // fala da faixa escolhida (relê quando a análise de um asset chega)
  const urls = useMemo(() => (open && project ? speechUrls(project, trackId) : {}), [open, project?.assets, project?.tracks, trackId])
  const urlsKey = JSON.stringify(urls)
  useEffect(() => {
    if (!open) return
    let alive = true
    void loader.load(urls).then((data) => {
      if (alive) setSpeech({ key: urlsKey, data })
    })
    return () => {
      alive = false
    }
  }, [open, urlsKey])
  const loading = open && speech?.key !== urlsKey

  const plan: SilenceCutPlan | null = useMemo(() => {
    if (!open || !project || !trackId || loading || !speech) return null
    const range = rangeMode === 'inout' && hasInOut ? { fromUs: inUs!, toUs: outUs! } : undefined
    return planSilenceCuts(project, { sourceTrackIds: [trackId], minSilenceUs, paddingUs, range }, speech.data)
  }, [open, project, trackId, loading, speech, minSilenceUs, paddingUs, rangeMode, hasInOut, inUs, outUs])

  // pré-visualização na linha do tempo
  useEffect(() => {
    useSilencePreview.getState().setCuts(plan?.cuts ?? [])
  }, [plan])

  if (!project) return null
  const sources = silenceSourceTracks(project)
  const track = project.tracks.find((t) => t.id === trackId)
  const pending = track ? audioItems(project, track).map((i) => project.assets.find((a) => a.id === i.assetId)!).filter((a) => !a.speech && !audioAnalysisComplete(a) && a.status !== 'error') : []
  const missing = plan ? plan.missingAssetIds.filter((id) => !pending.some((a) => a.id === id)) : []
  const locked = plan ? plan.lockedTrackIds.map((id) => project.tracks.find((t) => t.id === id)?.name ?? id) : []
  const total = projectDurationUs(project)
  const canApply = !!plan && plan.cuts.length > 0 && !plan.blocked

  const close = (): void => useSilencePreview.getState().close()
  const apply = (): void => {
    if (!plan || !canApply) return
    const { cuts, savedUs } = plan
    if (!useEditorStore.getState().apply((p) => applySilenceCuts(p, cuts))) return
    close()
    toast.success(`${cuts.length === 1 ? '1 silêncio removido' : `${cuts.length} silêncios removidos`} (${formatSaved(savedUs)} a menos)`, {
      action: { label: 'Desfazer', onClick: () => useEditorStore.getState().undo() }
    })
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => {
      if (!o) close()
    }} modal={false}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          data-silence-dialog=""
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed right-3 top-14 z-50 w-[min(380px,92vw)] rounded-2xl border border-border-strong bg-surface p-5 shadow-2xl animate-in fade-in-0 zoom-in-95 focus:outline-none"
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
            <div className="space-y-1.5">
              <span className="text-[12px] font-medium text-fg-2">Faixa de voz de referência</span>
              <Select
                value={trackId}
                onValueChange={setTrackId}
                placeholder="Nenhuma faixa com som"
                disabled={!sources.length}
                triggerClassName="h-9 text-xs"
                options={sources.map((t) => ({ value: t.id, label: t.name, hint: t.role === 'voice' ? 'Voz' : t.kind === 'video' ? 'Vídeo' : undefined }))}
              />
            </div>
            <Field label="Duração mínima do silêncio" value={fmtS(minSilenceUs)}>
              <Slider aria-label="Duração mínima do silêncio" min={MIN_SILENCE_RANGE[0]} max={MIN_SILENCE_RANGE[1]} step={50_000} value={[minSilenceUs]} onValueChange={([v]) => setMinSilence(v)} />
            </Field>
            <Field label="Margem antes e depois da fala" value={fmtS(paddingUs)}>
              <Slider aria-label="Margem antes e depois da fala" min={PADDING_RANGE[0]} max={PADDING_RANGE[1]} step={10_000} value={[paddingUs]} onValueChange={([v]) => setPadding(v)} />
            </Field>
            <Note tone="muted" icon={Info}>
              Silêncio = volume abaixo de {SPEECH_DEFAULTS.thresholdDb} dB por {fmtS(SPEECH_DEFAULTS.minSilenceUs)} ou mais (limiar fixado na análise da mídia).
            </Note>
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
                <span className="text-[12px] text-muted">Nenhum silêncio com essa duração{track ? ` em “${track.name}”` : ''}.</span>
              )}
            </div>

            {pending.length ? <Note tone="muted" icon={LoaderCircle}>A fala de {pending.length === 1 ? 'uma mídia' : `${pending.length} mídias`} desta faixa ainda está sendo analisada: o trecho dela entra quando a análise terminar.</Note> : null}
            {missing.length ? <Note tone="warn" icon={TriangleAlert}>{missing.length === 1 ? 'Uma mídia' : `${missing.length} mídias`} desta faixa sem análise de fala: o trecho dela não é cortado.</Note> : null}
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
