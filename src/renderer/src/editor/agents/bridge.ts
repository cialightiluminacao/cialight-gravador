import { toast } from 'sonner'
import { agentTools, type AgentRequest, type AgentToolName } from '@shared/agentProtocol'
import type { Project } from '@shared/editor/project'
import { createEmptyProject } from '@shared/editor/factory'
import { newProjectId } from '@shared/editor/ids'
import { applyAgentEdits } from '@shared/editor/agentEdits'
import { projectDurationUs, captionCues, addAsset } from '@shared/editor/ops'
import { enqueueAsset } from '../ui/mediaImport'
import { pendingAudioProcessing } from '@shared/editor/audioPlan'
import { parseProject, validateProject } from '@shared/editor/schema'
import { planTranscription, wordsToTimeline } from '@shared/editor/transcribePlan'
import { planSilenceCuts, applySilenceCuts, SILENCE_SPEECH_OPTS } from '@shared/editor/silenceCut'
import { speechFromFile, type SpeechInterval } from '@shared/editor/speech'
import { privacyWarnings } from '@shared/editor/privacy'
import { useAppStore } from '@/app/store'
import { useEditorStore, flushAutosave } from '../state/editorStore'
import { buildGenerated } from '../ui/captionsGenerate'
import { defaultSilenceSources } from '../ui/silenceSources'
import { mediaUrlsFor } from '../engine/mediaUrls'
import { SpeechLoader } from '../engine/audio/speechLoader'
import { renderStill } from '../export/formatExport'
import { exportQueue } from '../export/exportQueueStore'
import { EXPORT_PRESETS, settingsForPreset, exportRequestFor, validateExport, outputFileName } from '../export/exportPresets'
import { exportMediaIssues } from '../export/exportPlan'
import { defaultExportFolder } from '../ui/frameExport'

let revision = crypto.randomUUID() as string
useEditorStore.subscribe((state, previous) => { if (state.project !== previous.project) revision = crypto.randomUUID() })
export const agentRevision = (): string => revision
export interface AgentJob { id: string; task: string; projectId: string; state: 'running' | 'done' | 'error' | 'cancelled'; progress: string; result?: unknown; error?: string }
const jobs: AgentJob[] = []
const listeners = new Set<() => void>()
let jobSnapshot: readonly AgentJob[] = []
let analysis: { job: AgentJob; controller: AbortController; phase: 'analyze' | 'download' | 'transcribe' } | null = null
const notify = (): void => { jobSnapshot = jobs.map(j => ({ ...j })); listeners.forEach(fn => fn()) }
export const subscribeAgentJobs = (fn: () => void): (() => void) => { listeners.add(fn); return () => listeners.delete(fn) }
export const getAgentJobs = (): readonly AgentJob[] => jobSnapshot
const us = (s: number): number => Math.round(s * 1e6)
const message = (e: unknown): string => e instanceof Error ? e.message : String(e)

function active(projectId: string, expected?: string): Project {
  const st = useEditorStore.getState()
  if (useAppStore.getState().screen !== 'editor' || st.project?.id !== projectId) throw new Error('Abra este projeto no editor antes de continuar')
  if (expected !== undefined && expected !== revision) throw new Error('Conflito: o projeto mudou. Leia inspect/status novamente antes de editar.')
  if (st.txBase || st.preview) throw new Error('Finalize o arrasto ou a prévia manual antes de editar com o agente')
  return st.project
}

function commit(projectId: string, expected: string, next: Project): void {
  active(projectId, expected)
  const parsed = parseProject(next), errors = validateProject(parsed)
  if (errors.length) throw new Error(errors.join('; '))
  useEditorStore.getState().setPlaying(false)
  if (!useEditorStore.getState().apply(() => parsed)) throw new Error('Não foi possível aplicar a edição')
}

function ready(p: Project): void {
  const issues = exportMediaIssues(p, 0, projectDurationUs(p))
  if (issues.length) throw new Error(`Aguarde ou corrija as mídias: ${issues.map(x => `${x.name} (${x.status})`).join(', ')}`)
  const audioJobs = Object.values(useEditorStore.getState().audioJobs)
  if (audioJobs.some(j => 'error' in j)) throw new Error('Há um tratamento de áudio com erro. Confira o inspetor antes de exportar.')
  if (audioJobs.some(j => 'percent' in j)) throw new Error('Aguarde o tratamento de áudio terminar')
  if (pendingAudioProcessing(p).length) throw new Error('Aguarde o tratamento de áudio terminar')
}

async function openProject(projectId: string): Promise<void> {
  if (analysis) throw new Error('Cancele ou aguarde a análise antes de trocar de projeto')
  if (useEditorStore.getState().txBase) throw new Error('Finalize a edição manual antes de trocar de projeto')
  if (useAppStore.getState().screen === 'editor' && useEditorStore.getState().project?.id === projectId) return
  await window.api.project.load(projectId) // validate existence before leaving the current editor
  await flushAutosave()
  useAppStore.getState().openEditor(projectId)
  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (useEditorStore.getState().project?.id === projectId && !useEditorStore.getState().saving) { clearInterval(timer); clearTimeout(timeout); resolve() }
    }, 50)
    const timeout = setTimeout(() => { clearInterval(timer); reject(new Error('O projeto não abriu a tempo')) }, 20000)
  })
}

async function startAnalysis(args: unknown): Promise<unknown> {
  const a = agentTools.cialight_analyze.schema.parse(args)
  const p = active(a.projectId, a.revision)
  ready(p)
  if (analysis) throw new Error('Já existe uma análise em andamento')
  const job: AgentJob = { id: `analysis-${crypto.randomUUID()}`, task: a.task, projectId: p.id, state: 'running', progress: 'Preparando análise' }
  const controller = new AbortController()
  const runningAnalysis = { job, controller, phase: 'analyze' as 'analyze' | 'download' | 'transcribe' }
  analysis = runningAnalysis; jobs.push(job)
  if (jobs.length > 100) jobs.shift()
  notify()
  const check = (): void => { if (controller.signal.aborted) throw new Error('Cancelado') }
  void (async () => {
    let next = p
    const result: Record<string, unknown> = {}
    const off = window.api.transcribe.onProgress(pr => { job.progress = `${pr.stage === 'extract' ? 'Extraindo áudio' : 'Transcrevendo'} ${Math.round(pr.fraction * 100)}%`; notify() })
    try {
      if (a.task !== 'transcribe') {
        job.progress = 'Analisando pausas'; notify()
        const sources = defaultSilenceSources(p)
        if (!sources.length) throw new Error('Não há faixa com voz para analisar')
        const sourceAssets = new Set(p.tracks.filter(t => sources.includes(t.id)).flatMap(t => t.items.flatMap(i => i.type === 'media' ? [i.assetId] : [])))
        const urls = Object.fromEntries(Object.entries(mediaUrlsFor(p, 'preview')).filter(([id, v]) => sourceAssets.has(id) && v.speech).map(([id, v]) => [id, v.speech!]))
        const files = await new SpeechLoader(async url => {
          const response = await fetch(url, { signal: controller.signal })
          if (!response.ok) throw new Error('Não foi possível ler a análise de fala')
          return response.json()
        }, () => {}).loadFiles(urls)
        check()
        const speech: Record<string, SpeechInterval[]> = Object.fromEntries(Object.entries(files).map(([id, f]) => [id, speechFromFile(f, SILENCE_SPEECH_OPTS)]))
        const plan = planSilenceCuts(p, { sourceTrackIds: sources, minSilenceUs: us(a.minimumSilence), paddingUs: us(a.padding) }, speech)
        if (plan.missingAssetIds.length) throw new Error('A análise de fala ainda não está pronta para todas as mídias. Aguarde a importação terminar.')
        if (plan.blocked || plan.lockedTrackIds.length) throw new Error(plan.blocked ?? 'Há faixas bloqueadas; desbloqueie para manter a sincronia dos cortes')
        result.silences = { cuts: plan.cuts.map(c => ({ from: c.fromUs / 1e6, to: c.toUs / 1e6 })), savedSeconds: plan.savedUs / 1e6 }
        if (a.apply) next = applySilenceCuts(next, plan.cuts)
      }
      if (a.task === 'prepare') {
        const sources = new Set(defaultSilenceSources(next))
        const actions = next.tracks.filter(t => sources.has(t.id)).flatMap(t => t.items.flatMap(i => i.type === 'media' && p.assets.find(x => x.id === i.assetId)?.audio ? [{ type: 'audio' as const, itemId: i.id, normalize: true }] : []))
        if (a.apply && actions.length) next = applyAgentEdits(next, actions).project
      }
      if (a.task !== 'silences') {
        const plan = planTranscription(p)
        if (!plan.jobs.length) throw new Error('Não há áudio para transcrever')
        const models = await window.api.transcribe.models()
        const model = models.find(m => m.id === a.model)
        if (!model?.present) {
          if (!a.downloadModel) throw new Error('Baixe o modelo em Legendas → Gerar legendas, ou autorize downloadModel explicitamente.')
          job.progress = 'Baixando modelo de legendas'; notify()
          runningAnalysis.phase = 'download'
          try { await window.api.transcribe.downloadModel(a.model) } finally { runningAnalysis.phase = 'analyze' }
        }
        check()
        runningAnalysis.phase = 'transcribe'
        let transcribed: Awaited<ReturnType<typeof window.api.transcribe.run>>
        try { transcribed = await window.api.transcribe.run({ projectId: p.id, modelId: a.model, language: a.language, jobs: plan.jobs }) } finally { runningAnalysis.phase = 'analyze' }
        check()
        if ('cancelled' in transcribed) throw new Error('Cancelado')
        result.words = transcribed.words
        result.transcript = wordsToTimeline(planTranscription(next).segments, transcribed.words)
        result.warnings = transcribed.warnings
        if (a.apply) {
          const generated = buildGenerated(next, transcribed.words, 'replace')
          if (generated.kind === 'noSpeech') throw new Error('Nenhuma fala reconhecida; nenhuma edição foi aplicada')
          next = generated.project; result.captions = generated.count
        }
      }
      check()
      // ONE synchronous commit after all asynchronous work, and only against the captured revision.
      if (a.apply) { commit(p.id, a.revision, next); await flushAutosave() }
      job.result = { ...result, applied: a.apply, revision, duration: projectDurationUs(next) / 1e6 }
      job.state = 'done'; job.progress = a.apply ? 'Edição aplicada; Ctrl+Z desfaz' : 'Análise concluída'
      toast.success(job.progress)
    } catch (e) {
      job.state = controller.signal.aborted ? 'cancelled' : 'error'; job.error = message(e); job.progress = job.error
      if (job.state === 'error') toast.error('Análise do agente não concluída', { description: job.error })
    } finally { off(); analysis = null; notify() }
  })()
  return { jobId: job.id, state: job.state }
}

export async function executeAgentRequest(request: Pick<AgentRequest, 'tool' | 'args'>): Promise<unknown> {
  if (useAppStore.getState().phase !== 'idle') throw new Error('Aguarde o fim da gravação')
  const name: AgentToolName = request.tool
  const args = agentTools[name].schema.parse(request.args)
  switch (name) {
    case 'cialight_status': {
      const st = useEditorStore.getState()
      return { projectId: st.project?.id ?? null, name: st.project?.name ?? null, revision, screen: useAppStore.getState().screen, duration: st.project ? projectDurationUs(st.project) / 1e6 : 0, ingest: st.ingest, audioJobs: st.audioJobs, jobs: jobs.map(j => ({ id: j.id, task: j.task, state: j.state, progress: j.progress })), exports: exportQueue.items.map(i => ({ id: i.id, state: i.state, percent: i.progress?.percent })), tools: Object.keys(agentTools), units: 'seconds' }
    }
    case 'cialight_projects': {
      const a = agentTools.cialight_projects.schema.parse(args)
      if (a.action === 'list') return { projects: await window.api.project.list() }
      if (a.action === 'create') {
        const p = { ...createEmptyProject(a.name ?? 'Projeto com IA'), id: newProjectId(new Date()) }
        await window.api.project.create(p)
        await openProject(p.id)
        return { projectId: p.id, revision }
      }
      if (!a.projectId) throw new Error('Informe projectId')
      await openProject(a.projectId)
      return { projectId: a.projectId, revision }
    }
    case 'cialight_inspect': {
      const a = agentTools.cialight_inspect.schema.parse(args), p = active(a.projectId)
      return { revision, project: p, duration: projectDurationUs(p) / 1e6, captions: captionCues(p), presets: EXPORT_PRESETS, warnings: privacyWarnings(p, 0, projectDurationUs(p)) }
    }
    case 'cialight_import': {
      const a = agentTools.cialight_import.schema.parse(args)
      active(a.projectId, a.revision)
      const before = useEditorStore.getState().project
      // Probe in main first, then importPaths applies to the live state. Prevent crossing a project switch.
      const assets = await window.api.media.import(a.projectId, a.paths)
      active(a.projectId, a.revision)
      if (useEditorStore.getState().project !== before) throw new Error('O projeto mudou durante a leitura dos arquivos')
      if (!useEditorStore.getState().apply(p => assets.reduce((q, asset) => addAsset(q, asset), p))) throw new Error('Falha ao importar mídias')
      await flushAutosave()
      for (const asset of assets) if (asset.status === 'processing') void enqueueAsset(a.projectId, asset)
      return { revision, assets }
    }
    case 'cialight_edit': {
      const a = agentTools.cialight_edit.schema.parse(args), p = active(a.projectId, a.revision)
      const r = applyAgentEdits(p, a.actions)
      if (!a.dryRun) { commit(p.id, a.revision, r.project); await flushAutosave() }
      return { revision, dryRun: a.dryRun, createdIds: r.createdIds, warnings: r.warnings, duration: projectDurationUs(r.project) / 1e6 }
    }
    case 'cialight_history': {
      const a = agentTools.cialight_history.schema.parse(args)
      active(a.projectId, a.revision)
      const st = useEditorStore.getState()
      if (a.action === 'undo') { if (!st.canUndo) throw new Error('Nada para desfazer'); st.undo() }
      if (a.action === 'redo') { if (!st.canRedo) throw new Error('Nada para refazer'); st.redo() }
      await flushAutosave()
      return { revision }
    }
    case 'cialight_analyze': return startAnalysis(args)
    case 'cialight_preview': {
      const a = agentTools.cialight_preview.schema.parse(args), p = active(a.projectId)
      const renderedRevision = revision
      if (us(a.at) >= projectDurationUs(p)) throw new Error('Escolha um instante dentro do vídeo')
      const r = await renderStill(p, us(a.at))
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(r.png)], { type: 'image/png' }))
      try {
        const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale)
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
        return { at: a.at, revision: renderedRevision, currentRevision: revision, width: canvas.width, height: canvas.height, warnings: r.warnings, image: { mimeType: 'image/png', data: canvas.toDataURL('image/png').split(',')[1] } }
      } finally { bitmap.close() }
    }
    case 'cialight_export': {
      const a = agentTools.cialight_export.schema.parse(args), p = active(a.projectId, a.revision)
      ready(p)
      const fromUs = us(a.from), toUs = a.to === undefined ? projectDurationUs(p) : us(a.to)
      if (toUs <= fromUs || toUs > projectDurationUs(p)) throw new Error('Intervalo de exportação inválido')
      const s = settingsForPreset(a.preset, p.canvas), validation = validateExport(s, p.canvas, toUs - fromUs, false)
      if (validation.blocker) throw new Error(validation.blocker)
      const app = useAppStore.getState(), outputDir = a.outputDir ?? defaultExportFolder(app.settings, app.appInfo)
      if (!outputDir) throw new Error('Defina uma pasta de saída nas configurações')
      const privacy = privacyWarnings(p, fromUs, toUs).map(w => w.message)
      const r = exportQueue.enqueue({ job: { kind: 'video', request: { project: p, fromUs, toUs, ...exportRequestFor(s, toUs - fromUs), outputDir, fileName: outputFileName(a.fileName ?? p.name, 'mp4'), captions: { burn: true, srtBeside: true } } }, durationUs: toUs - fromUs, label: `${p.name} · ${a.preset} · Agente`, privacy })
      return { jobId: r.id, revision, warnings: privacy, position: r.position }
    }
    case 'cialight_jobs': {
      const a = agentTools.cialight_jobs.schema.parse(args)
      if (a.cancel) {
        if (!a.jobId) throw new Error('Informe jobId para cancelar')
        if (analysis?.job.id === a.jobId) {
          analysis.controller.abort()
          if (analysis.phase === 'transcribe') await window.api.transcribe.cancel()
          else if (analysis.phase === 'download') await window.api.transcribe.cancelDownload()
        } else if (exportQueue.items.some(i => i.id === a.jobId)) exportQueue.cancel(a.jobId)
        else throw new Error('Job em execução não encontrado')
      }
      const output = [...jobs, ...exportQueue.items.map(i => ({ id: i.id, task: 'export', state: i.state, progress: i.progress, result: i.result, error: i.message }))]
      const filtered = a.jobId ? output.filter(j => j.id === a.jobId) : output.map(({ result: _, ...summary }) => summary)
      if (a.jobId && !filtered.length) throw new Error('Job não encontrado nesta sessão')
      return { jobs: filtered, revision }
    }
  }
}

export function installAgentBridge(): () => void {
  return window.api.agents.onRequest(request => {
    void executeAgentRequest(request).then(result => window.api.agents.reply({ id: request.id, result }), e => window.api.agents.reply({ id: request.id, error: message(e) }))
  })
}
