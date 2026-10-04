import { useEffect, useMemo, useRef, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { planTranscription } from '@shared/editor/transcribePlan'
import type { TranscribeLanguage, TranscribeResult, WhisperModelId, WhisperModelStatus } from '@shared/ipc'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent, Progress, Select } from '@/components/ui/primitives'
import { ipcErrorMessage } from '@/lib/ipcError'
import { cn } from '@/lib/cn'
import { useEditorStore } from '../state/editorStore'
import { buildGenerated, generatedToast, modelChoiceLabel, modelStatusText, progressView, sourceSummary, type BuildResult, type GenerateMode, type GenerateStage } from './captionsGenerate'
import { warningsSummary } from './captionsEdit'

// Diálogo "Gerar legendas" (G2): modelo (baixa só depois do clique explícito; o tamanho aparece antes), idioma, o que
// fazer com as legendas atuais, a fonte do áudio e o progresso com "Cancelar". Fechar (Esc, X) durante a geração =
// cancelar. O resultado entra num único passo de desfazer, montado sobre o projeto ATUAL (buildGenerated).

const st = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()

// lembrados durante a sessão (não vão para o settings.json)
let lastModel: WhisperModelId = 'base'
let lastLanguage: TranscribeLanguage = 'pt'

const LANGUAGES: { value: TranscribeLanguage; label: string }[] = [
  { value: 'pt', label: 'Português (Brasil)' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'auto', label: 'Detectar automaticamente' }
]

interface RunToken { cancelled: boolean; phase: 'download' | 'run' }

export function GenerateCaptionsDialog({ open, onOpenChange, captionCount }: { open: boolean; onOpenChange: (open: boolean) => void; captionCount: number }): React.JSX.Element {
  const project = useEditorStore((s) => s.project)
  const [models, setModels] = useState<WhisperModelStatus[] | null>(null)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [model, setModel] = useState<WhisperModelId>(lastModel)
  const [language, setLanguage] = useState<TranscribeLanguage>(lastLanguage)
  const [mode, setMode] = useState<GenerateMode>('replace')
  const [stage, setStage] = useState<GenerateStage | null>(null)
  const runRef = useRef<RunToken | null>(null)
  const running = stage !== null

  useEffect(() => {
    if (!open) return
    let alive = true
    setModelsError(null)
    window.api.transcribe.models().then(
      (m) => alive && setModels(m),
      (e) => alive && setModelsError(ipcErrorMessage(e))
    )
    return () => {
      alive = false
    }
  }, [open])

  // painel desmontado (troca de aba, projeto fechado) no meio da geração: cancela
  useEffect(() => () => cancelRun(), [])

  // (o progresso re-renderiza ~10×/s: o plano só é refeito quando o projeto muda)
  const plan = useMemo(() => (open && project ? planTranscription(project) : null), [open, project])
  const chosen = models?.find((m) => m.id === model) ?? null
  const effectiveMode: GenerateMode = captionCount ? mode : 'replace'

  function cancelRun(): void {
    const t = runRef.current
    if (!t || t.cancelled) return
    t.cancelled = true
    if (t.phase === 'download') void window.api.transcribe.cancelDownload().catch(() => {})
    else void window.api.transcribe.cancel().catch(() => {})
  }

  const close = (o: boolean): void => {
    if (!o && runRef.current) cancelRun()
    onOpenChange(o)
  }

  const start = async (): Promise<void> => {
    const p = st().project
    if (!p || !chosen || runRef.current) return
    const plan0 = planTranscription(p)
    if (plan0.scope === 'none') return
    const token: RunToken = { cancelled: false, phase: 'download' }
    runRef.current = token
    const m = chosen
    const useMode = effectiveMode
    lastModel = m.id
    lastLanguage = language
    const cancelled = (): void => {
      toast('Geração de legendas cancelada')
    }
    try {
      if (!m.present) {
        setStage({ kind: 'download', receivedBytes: 0, totalBytes: m.sizeBytes })
        const off = window.api.transcribe.onDownloadProgress((pr) => {
          if (runRef.current === token && !token.cancelled && pr.id === m.id) setStage({ kind: 'download', receivedBytes: pr.receivedBytes, totalBytes: pr.totalBytes })
        })
        let r: Awaited<ReturnType<typeof window.api.transcribe.downloadModel>>
        try {
          r = await window.api.transcribe.downloadModel(m.id)
        } finally {
          off()
        }
        // o estado "baixado" do catálogo em dia (inclusive se cancelou: o .part não conta)
        void window.api.transcribe.models().then(setModels, () => {})
        if ('cancelled' in r || token.cancelled) return cancelled()
      }
      if (token.cancelled) return cancelled()
      token.phase = 'run'
      setStage({ kind: 'extract', fraction: 0 })
      const off = window.api.transcribe.onProgress((pr) => {
        if (runRef.current === token && !token.cancelled) setStage({ kind: pr.stage, fraction: pr.fraction })
      })
      let res: TranscribeResult | { cancelled: true }
      try {
        res = await window.api.transcribe.run({ projectId: p.id, modelId: m.id, language, jobs: plan0.jobs })
      } finally {
        off()
      }
      if ('cancelled' in res || token.cancelled) return cancelled()
      setStage({ kind: 'build' })
      // projeto trocado no meio (outro projeto aberto): nada a aplicar
      if (st().project?.id !== p.id) return
      const words = res.words
      let out: BuildResult | null = null
      const applied = st().apply((cur) => {
        const r = buildGenerated(cur, words, useMode)
        out = r
        return r.kind === 'ok' ? r.project : cur
      })
      const built = out as BuildResult | null
      if (!applied || !built) return // EditError (ex.: faixa bloqueada): o store já avisou
      if (built.kind === 'noSpeech') {
        toast('Nenhuma fala encontrada no áudio')
        return
      }
      onOpenChange(false)
      if (built.count === 0) {
        toast(`Nenhuma legenda nova: ${built.skipped === 1 ? 'a gerada encostava' : `as ${built.skipped} geradas encostavam`} em legendas existentes`)
        return
      }
      const all = [...res.warnings, ...built.warnings]
      const title = generatedToast(built.count, built.skipped, useMode)
      if (all.length) toast.warning(title, { description: <span className="whitespace-pre-line">{warningsSummary(all)}</span>, duration: 10_000 })
      else toast.success(title)
    } catch (e) {
      if (token.cancelled) cancelled()
      else toast.error('Não foi possível gerar as legendas', { description: ipcErrorMessage(e) })
    } finally {
      if (runRef.current === token) runRef.current = null
      setStage(null)
    }
  }

  const view = stage ? progressView(stage) : null
  const canStart = !!plan && plan.scope !== 'none' && !!chosen && !running

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title="Gerar legendas" description="Transcreve a fala do projeto e cria as legendas automaticamente." className="w-[min(480px,92vw)]">
        <div className="flex flex-col gap-4" data-generate-dialog="">
          <fieldset className="flex flex-col gap-1.5" disabled={running}>
            <legend className="mb-1 text-[12px] font-semibold text-fg-2">Modelo</legend>
            {models ? (
              <div role="radiogroup" aria-label="Modelo" className="flex flex-col gap-1.5">
                {models.map((m) => (
                  <label
                    key={m.id}
                    data-model-option={m.id}
                    className={cn('flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-[12.5px]', model === m.id ? 'border-accent/60 bg-accent/10' : 'border-border hover:border-border-strong', running && 'cursor-default opacity-60')}
                  >
                    <input type="radio" name="whisper-model" value={m.id} checked={model === m.id} onChange={() => setModel(m.id)} className="accent-[var(--accent)]" />
                    <span className="flex-1 text-fg">{modelChoiceLabel(m)}</span>
                    <span data-model-status={m.present ? 'present' : 'missing'} className={cn('text-[11px]', m.present ? 'text-ok' : 'text-muted')}>
                      {modelStatusText(m)}
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-[12px] text-muted">{modelsError ? `Não foi possível ler os modelos: ${modelsError}` : 'Verificando os modelos…'}</p>
            )}
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] font-semibold text-fg-2">Idioma</span>
            <div data-generate-language={language}>
              <Select ariaLabel="Idioma" triggerClassName="h-8 rounded-lg px-2.5 text-[12.5px]" value={language} options={LANGUAGES} disabled={running} onValueChange={(v) => setLanguage(v as TranscribeLanguage)} />
            </div>
          </div>

          {captionCount ? (
            <fieldset className="flex flex-col gap-1.5" disabled={running}>
              <legend className="mb-1 text-[12px] font-semibold text-fg-2">Quando já há legendas</legend>
              <div role="radiogroup" aria-label="Quando já há legendas" className="flex flex-col gap-1">
                {(
                  [
                    ['replace', 'Substituir as atuais'],
                    ['fill', 'Só onde não há legenda']
                  ] as const
                ).map(([v, label]) => (
                  <label key={v} className="flex cursor-pointer items-center gap-2 text-[12.5px] text-fg" data-generate-mode={v}>
                    <input type="radio" name="generate-mode" value={v} checked={mode === v} onChange={() => setMode(v)} className="accent-[var(--accent)]" />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          <div className="flex flex-col gap-1">
            <span className="text-[12px] font-semibold text-fg-2">Fonte</span>
            <p className="text-[12.5px] text-fg" data-generate-source="">
              {plan ? (plan.scope === 'none' ? 'Nenhum áudio de voz no projeto' : sourceSummary(plan)) : '—'}
            </p>
          </div>

          <p className="flex items-start gap-1.5 text-[11.5px] text-muted" data-generate-privacy="">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" />
            A transcrição é feita neste computador; o áudio não sai daqui.
          </p>

          {view ? (
            <div className="flex flex-col gap-1.5" role="status" aria-live="polite" data-generate-progress="">
              <span className="text-[12.5px] text-fg" data-generate-step="">
                {view.label}
              </span>
              <Progress value={view.percent} />
            </div>
          ) : null}

          <div className="flex justify-end gap-2">
            {running ? (
              <Button variant="secondary" onClick={cancelRun} data-generate-cancel="">
                Cancelar
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={() => close(false)}>
                  Fechar
                </Button>
                <Button variant="primary" disabled={!canStart} onClick={() => void start()} data-generate-start="">
                  {chosen && !chosen.present ? 'Baixar modelo e gerar' : 'Gerar'}
                </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
