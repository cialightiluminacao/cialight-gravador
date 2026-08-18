import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import type { ExportOptions, Session } from '@shared/types'
import type { ExportProgress as ExportProgressEvent } from '@shared/ipc'
import { useAppStore } from '@/app/store'
import { ComposeCancelledError, composeSession, discardComposed, needsComposition } from '@/export/exportComposer'
import type { ExportProgressState } from './ExportProgress'

// Executor da exportação, FORA do componente: o estado sobrevive à navegação (Histórico/
// Configurações durante a etapa 1 ou 2), só existe UMA exportação por vez no app e os eventos
// de progresso são filtrados pelo jobId corrente (eventos tardios de jobs encerrados são
// ignorados). A tela de Revisão só observa (useExportRunner) e dispara (startExport).

export type ExportPhase =
  | { kind: 'idle' }
  | { kind: 'running'; progress: ExportProgressState; opts: ExportOptions }
  | { kind: 'done'; outputs: string[]; warning: string | null; opts: ExportOptions }

export interface ExportResult {
  outputs: string[]
  error?: string
}

export interface StartExportArgs {
  session: Session
  options: ExportOptions
  /** Duração conhecida da gravação (session.durationMs ou a medida no player). */
  durationMs: number
  autoFadeMs: number | null
}

interface RunnerState {
  /** Sessão dona da fase atual (running/done). */
  sessionId: string | null
  phase: ExportPhase
  /** Há uma exportação em andamento (composição ou ffmpeg). */
  busy: boolean
}

interface ActiveExport {
  sessionId: string
  opts: ExportOptions
  totalSteps: 1 | 2
  composed: boolean
  composeAbort: AbortController | null
  jobId: string | null
  /** export.run foi chamado mas o jobId ainda não voltou — eventos sem dono são deste job. */
  awaitingJob: boolean
  cancelRequested: boolean
  resolve: (r: ExportResult) => void
}

const IDLE: ExportPhase = { kind: 'idle' }
const CANCELLED_RESULT: ExportResult = { outputs: [], error: 'cancelado' }

let state: RunnerState = { sessionId: null, phase: IDLE, busy: false }
let active: ActiveExport | null = null
let subscribed = false
const finishedJobs = new Set<string>()
const listeners = new Set<() => void>()

function publish(next: RunnerState): void {
  state = next
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

const getSnapshot = (): RunnerState => state

/** Fase da exportação vista por uma sessão + se outra sessão está exportando agora. */
export function useExportRunner(sessionId: string): { phase: ExportPhase; busyElsewhere: boolean } {
  const s = useSyncExternalStore(subscribe, getSnapshot)
  return { phase: s.sessionId === sessionId ? s.phase : IDLE, busyElsewhere: s.busy && s.sessionId !== sessionId }
}

/** Volta a fase da sessão para "idle" (Reexportar / Voltar após falha). Não interrompe exportação em andamento. */
export function resetExport(sessionId: string): void {
  if (state.sessionId === sessionId && !state.busy) publish({ sessionId, phase: IDLE, busy: false })
}

/** Cancela a exportação em andamento (composição ou ffmpeg). */
export function cancelExport(): void {
  const me = active
  if (!me) return
  me.cancelRequested = true
  if (me.composeAbort) {
    me.composeAbort.abort()
    return
  }
  if (me.jobId) void window.api.export.cancel(me.jobId)
  // Se o jobId ainda não voltou, o cancel é enviado assim que export.run resolver.
}

function stageTitle(stage: ExportProgressEvent['stage']): string {
  switch (stage) {
    case 'prepare':
      return 'Preparando'
    case 'pass1':
      return 'Analisando (passo 1 de 2)'
    case 'pass2':
      return 'Codificando (passo 2 de 2)'
    default:
      return 'Codificando com ffmpeg'
  }
}

function runningPhase(me: ActiveExport, progress: ExportProgressState): RunnerState {
  return { sessionId: me.sessionId, phase: { kind: 'running', opts: me.opts, progress }, busy: true }
}

/** Encerra o job ativo: libera o slot, descarta o composed.mp4 e entrega o resultado. */
function settle(me: ActiveExport, phase: ExportPhase, result: ExportResult): void {
  if (active === me) active = null
  if (me.composed) void discardComposed(me.sessionId).catch(() => {})
  publish({ sessionId: me.sessionId, phase, busy: false })
  me.resolve(result)
}

function settleCancelled(me: ActiveExport, partialLeft: boolean): void {
  settle(me, IDLE, CANCELLED_RESULT)
  toast('Exportação cancelada.', partialLeft ? { description: 'Um arquivo parcial pode ter ficado na pasta de destino.' } : undefined)
}

/** A Revisão desta sessão está na tela? (aí o painel já mostra o resultado e o toast só atrapalharia). */
function reviewVisible(sessionId: string): boolean {
  const st = useAppStore.getState()
  return st.screen === 'review' && st.reviewSession?.id === sessionId
}

function settleError(me: ActiveExport, error: string, step: 1 | 2 = me.totalSteps): void {
  settle(me, { kind: 'running', opts: me.opts, progress: { step, totalSteps: me.totalSteps, title: 'Falha', detail: null, percent: 0, error } }, { outputs: [], error })
  if (!reviewVisible(me.sessionId)) toast.error('A exportação falhou.')
}

function settleDone(me: ActiveExport, outputs: string[], warning: string | null): void {
  settle(me, { kind: 'done', opts: me.opts, outputs, warning }, { outputs })
  if (!reviewVisible(me.sessionId)) toast.success(outputs.length === 1 ? 'Vídeo exportado com sucesso.' : `${outputs.length} arquivos exportados.`)
  // A sessão vira "finalized" no main → atualiza a revisão aberta, se for a mesma.
  void window.api.session.get(me.sessionId).then((fresh) => {
    const store = useAppStore.getState()
    if (fresh && store.reviewSession?.id === fresh.id) store.setReviewSession(fresh)
  })
}

function onProgressEvent(p: ExportProgressEvent): void {
  const me = active
  if (!me || finishedJobs.has(p.jobId)) return
  if (me.jobId !== null ? p.jobId !== me.jobId : !me.awaitingJob) return
  switch (p.stage) {
    case 'done':
      finishedJobs.add(p.jobId)
      // O main pode responder "done" a um cancelamento tardio (arquivo parcial): trata como cancelado.
      if (me.cancelRequested) settleCancelled(me, true)
      else settleDone(me, p.outputs ?? [], p.message ?? null)
      return
    case 'error':
      finishedJobs.add(p.jobId)
      settleError(me, p.error ?? 'Erro desconhecido')
      return
    case 'cancelled':
      finishedJobs.add(p.jobId)
      settleCancelled(me, false)
      return
    default:
      publish(runningPhase(me, { step: me.totalSteps, totalSteps: me.totalSteps, title: stageTitle(p.stage), detail: p.message ?? null, percent: p.percent, error: null }))
  }
}

function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true
  window.api.export.onProgress(onProgressEvent)
}

function composeDetail(session: Session, opts: ExportOptions): string {
  const parts = [opts.includeWebcam && session.tracks.webcam !== undefined ? 'webcam' : null, opts.includeAnnotations && session.strokes.length ? 'anotações' : null].filter((x): x is string => x !== null)
  return `${parts.join(' + ')} · ${session.video.height}p · ${session.video.fps} fps`
}

/**
 * Inicia a exportação (composição no Worker quando há webcam/anotações → job ffmpeg no main).
 * Resolve com os arquivos gerados, ou com `error` ('cancelado' quando interrompida).
 */
export async function startExport({ session, options: opts, durationMs, autoFadeMs }: StartExportArgs): Promise<ExportResult> {
  if (active) return { outputs: [], error: 'Já existe uma exportação em andamento' }
  ensureSubscribed()
  const api = window.api
  const compose = needsComposition(session, opts)
  const me: ActiveExport = {
    sessionId: session.id,
    opts,
    totalSteps: compose ? 2 : 1,
    composed: false,
    composeAbort: null,
    jobId: null,
    awaitingJob: false,
    cancelRequested: false,
    resolve: () => {}
  }
  active = me
  const composeState = (percent: number): RunnerState => runningPhase(me, { step: 1, totalSteps: 2, title: 'Compondo o vídeo', detail: composeDetail(session, opts), percent, error: null })
  publish(compose ? composeState(0) : runningPhase(me, { step: 1, totalSteps: 1, title: 'Preparando', detail: null, percent: 0, error: null }))

  try {
    let composedFile: string | null = null
    if (compose) {
      const ac = new AbortController()
      me.composeAbort = ac
      me.composed = true
      composedFile = await composeSession({
        sessionId: session.id,
        session,
        options: opts,
        fps: session.video.fps,
        width: session.video.width,
        height: session.video.height,
        durationMs,
        autoFadeMs,
        onProgress: (pct) => publish(composeState(pct)),
        signal: ac.signal
      })
      me.composeAbort = null
    }
    if (me.cancelRequested) throw new ComposeCancelledError()
    const result = new Promise<ExportResult>((resolve) => {
      me.resolve = resolve
    })
    me.awaitingJob = true
    const { jobId } = await api.export.run({ sessionId: session.id, options: opts, composedFile })
    me.awaitingJob = false
    if (!finishedJobs.has(jobId)) {
      me.jobId = jobId
      if (me.cancelRequested) void api.export.cancel(jobId)
    }
    return await result
  } catch (e) {
    me.composeAbort = null
    if (e instanceof ComposeCancelledError) {
      settleCancelled(me, false)
      return CANCELLED_RESULT
    }
    const error = e instanceof Error ? e.message : String(e)
    settleError(me, error, me.awaitingJob || me.jobId !== null ? me.totalSteps : 1)
    return { outputs: [], error }
  }
}
