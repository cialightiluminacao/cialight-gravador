import { LoaderCircle, TriangleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Progress } from '@/components/ui/primitives'
import { cn } from '@/lib/cn'

// Painel de progresso da exportação: etapa atual (composição → ffmpeg), barra, cancelar.
// Em erro mostra a mensagem e oferece tentar de novo.

export interface ExportProgressState {
  /** Etapa 1 = composição (webcam/anotações), 2 = codificação ffmpeg. */
  step: 1 | 2
  totalSteps: 1 | 2
  title: string
  detail: string | null
  percent: number
  error: string | null
}

/** Resumo do que está sendo exportado (mostrado abaixo do progresso). */
export interface ExportSummary {
  preset: string
  range: string
  fileName: string
  outputDir: string
  extras: string[]
}

interface Props {
  state: ExportProgressState
  summary: ExportSummary
  onCancel: () => void
  onRetry: () => void
  onBack: () => void
}

export function ExportProgress({ state, summary, onCancel, onRetry, onBack }: Props): React.JSX.Element {
  const failed = state.error !== null
  return (
    <div className="flex h-full flex-col rise-in">
      <div className="flex-1">
        <div className={cn('card p-5', failed && 'border-danger/30')}>
          <div className="flex items-start gap-3">
            <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', failed ? 'bg-danger/15 text-danger' : 'bg-accent/15 text-accent-2')}>
              {failed ? <TriangleAlert className="h-5 w-5" /> : <LoaderCircle className="h-5 w-5 animate-spin" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">{failed ? 'Falha na exportação' : `Etapa ${state.step} de ${state.totalSteps}`}</div>
              <div className="mt-0.5 text-[15px] font-semibold leading-tight">{failed ? 'Não foi possível exportar' : state.title}</div>
              {!failed && state.detail ? <div className="mt-0.5 truncate text-xs text-muted">{state.detail}</div> : null}
            </div>
            {!failed ? (
              <span className="font-mono tnum text-2xl font-semibold text-fg">
                {Math.round(state.percent)}
                <span className="text-sm text-muted">%</span>
              </span>
            ) : null}
          </div>
          {failed ? (
            <pre className="mt-4 max-h-48 select-text overflow-auto whitespace-pre-wrap rounded-lg border border-danger/20 bg-danger/5 p-3 font-mono text-[11px] leading-relaxed text-fg-2">{state.error}</pre>
          ) : (
            <Progress className="mt-4 h-2.5" value={state.percent} tone={state.step === 1 && state.totalSteps === 2 ? 'info' : 'accent'} />
          )}
          {!failed && state.totalSteps === 2 ? (
            <div className="mt-3 flex items-center gap-2 text-[11px] text-muted">
              <StepDot done={state.step > 1} active={state.step === 1} label="Compor webcam e anotações" />
              <span className="h-px flex-1 bg-border-strong" />
              <StepDot done={false} active={state.step === 2} label="Codificar com ffmpeg" />
            </div>
          ) : null}
        </div>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-xl border border-border bg-surface/60 px-4 py-3 text-xs">
          <dt className="text-muted">Preset</dt>
          <dd className="min-w-0 truncate text-fg-2">{summary.preset}</dd>
          <dt className="text-muted">Trecho</dt>
          <dd className="font-mono tnum text-fg-2">{summary.range}</dd>
          {summary.extras.length ? (
            <>
              <dt className="text-muted">Inclui</dt>
              <dd className="text-fg-2">{summary.extras.join(' · ')}</dd>
            </>
          ) : null}
          <dt className="text-muted">Arquivo</dt>
          <dd className="min-w-0 truncate text-fg-2" title={summary.fileName}>
            {summary.fileName}
          </dd>
          <dt className="text-muted">Pasta</dt>
          <dd className="min-w-0 truncate text-fg-2" title={summary.outputDir}>
            {summary.outputDir}
          </dd>
        </dl>
        {!failed ? <p className="mt-3 px-1 text-xs text-muted">A exportação continua mesmo com a janela minimizada. Você pode seguir usando o computador.</p> : null}
      </div>
      <div className="mt-4 flex gap-2">
        {failed ? (
          <>
            <Button variant="ghost" className="flex-1" onClick={onBack}>
              Voltar
            </Button>
            <Button variant="primary" className="flex-1" onClick={onRetry}>
              Tentar de novo
            </Button>
          </>
        ) : (
          <Button variant="outline" size="lg" className="w-full" onClick={onCancel}>
            <X className="h-4 w-4" /> Cancelar exportação
          </Button>
        )}
      </div>
    </div>
  )
}

function StepDot({ done, active, label }: { done: boolean; active: boolean; label: string }): React.JSX.Element {
  return (
    <span className={cn('flex items-center gap-1.5', active ? 'text-fg' : done ? 'text-ok' : 'text-muted')}>
      <span className={cn('h-2 w-2 rounded-full', active ? 'bg-accent' : done ? 'bg-ok' : 'bg-muted-2')} />
      {label}
    </span>
  )
}
