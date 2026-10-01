// Exportação do editor (thread principal): sobe uma instância PRÓPRIA do render worker (OffscreenCanvas na
// resolução de saída) e um audio worker de exportação ligados por MessageChannel — o preview continua vivo e
// intocado. Os bytes do MP4 vão para `<saída>.part` via IPC (editorExport.write) com contrapressão (chunkAck
// depois de gravar); no fim o main remuxa com faststart. Encoder de hardware que falha antes do 1º pacote →
// nova tentativa com `prefer-software`; se também falhar, erro claro. Uma exportação por vez.
import { planAudio } from '@shared/editor/audioPlan'
import type { Project, Us } from '@shared/editor/project'
import { RenderClient } from '../engine/RenderClient'
import { AudioClient } from '../engine/audio/AudioClient'
import { mediaUrlsFor } from '../engine/mediaUrls'
import type { ExportJobSpec, HwPref, RenderOut } from '../engine/protocol'
import { KEYFRAME_INTERVAL_S } from './exportPlan'

export interface EditorExportRequest {
  project: Project
  width: number
  height: number
  fps: number
  fromUs: Us
  toUs: Us
  videoBitrate: number
  audioBitrate: number
  outputDir: string
  fileName: string
  /** Testes: simula a falha do encoder de hardware (exercita a nova tentativa em software). */
  simulateHwFailure?: boolean
}

export interface EditorExportProgress {
  stage: 'render' | 'finalize'
  frame: number
  total: number
  /** 0–100 (a etapa de faststart conta como os últimos 2 %). */
  percent: number
  /** Velocidade em × tempo real (null no início). */
  speed: number | null
  /** Segundos restantes estimados (null no início). */
  etaS: number | null
}

export interface EditorExportResult {
  path: string
  size: number
  videoCodec: string
  audioCodec: 'aac' | 'opus' | null
  hardware: HwPref
  /** Encoder de hardware falhou e a exportação foi refeita em software. */
  fellBackToSoftware: boolean
}

export class EditorExportCancelled extends Error {
  constructor() {
    super('Exportação cancelada')
    this.name = 'EditorExportCancelled'
  }
}

class AttemptError extends Error {
  constructor(message: string, readonly beforeFirstPacket: boolean) {
    super(message)
  }
}

let running = false

/** Há uma exportação do editor em andamento. */
export function editorExportRunning(): boolean {
  return running
}

export async function runEditorExport(req: EditorExportRequest, opts: { onProgress?: (p: EditorExportProgress) => void; signal?: AbortSignal } = {}): Promise<EditorExportResult> {
  if (running) throw new Error('Já existe uma exportação em andamento')
  running = true
  const api = window.api
  const signal = opts.signal ?? new AbortController().signal
  let jobId: string | null = null
  try {
    let fellBack = false
    for (const hw of ['prefer-hardware', 'prefer-software'] as const) {
      if (signal.aborted) throw new EditorExportCancelled()
      jobId = (await api.editorExport.open(req.outputDir, req.fileName)).jobId
      try {
        const done = await attempt(req, jobId, hw, signal, opts.onProgress)
        opts.onProgress?.({ stage: 'finalize', frame: done.total, total: done.total, percent: 98, speed: null, etaS: null })
        const id = jobId
        jobId = null // finalize apaga o .part mesmo se falhar
        const out = await api.editorExport.finalize(id)
        opts.onProgress?.({ stage: 'finalize', frame: done.total, total: done.total, percent: 100, speed: null, etaS: null })
        return { ...out, videoCodec: done.videoCodec, audioCodec: done.audioCodec, hardware: hw, fellBackToSoftware: fellBack }
      } catch (e) {
        if (jobId) await api.editorExport.cancel(jobId).catch(() => {})
        jobId = null
        if (e instanceof EditorExportCancelled || signal.aborted) throw new EditorExportCancelled()
        if (e instanceof AttemptError && e.beforeFirstPacket && hw === 'prefer-hardware') {
          console.warn(`exportação: encoder de hardware falhou (${e.message}); tentando em software`)
          fellBack = true
          continue
        }
        if (e instanceof AttemptError && e.beforeFirstPacket) {
          throw new Error(`Não foi possível codificar o vídeo neste computador (${e.message}). Tente o preset WhatsApp (720p) ou atualize o driver de vídeo.`)
        }
        throw e
      }
    }
    throw new Error('Não foi possível codificar o vídeo neste computador.')
  } finally {
    if (jobId) await api.editorExport.cancel(jobId).catch(() => {})
    running = false
  }
}

interface AttemptDone {
  total: number
  videoCodec: string
  audioCodec: 'aac' | 'opus' | null
}

/** Uma tentativa completa (workers próprios, descartados no fim). */
function attempt(req: EditorExportRequest, jobId: string, hw: HwPref, signal: AbortSignal, onProgress?: (p: EditorExportProgress) => void): Promise<AttemptDone> {
  const api = window.api
  const hasAudio = planAudio(req.project).length > 0
  const urls = mediaUrlsFor(req.project, 'export')
  const render = new RenderClient(new OffscreenCanvas(req.width, req.height), { width: req.width, height: req.height, dpr: 1 })
  const audio = hasAudio ? new AudioClient() : null
  const audioWarnings: string[] = []
  audio?.onError((m) => audioWarnings.push(m))
  render.setProject(req.project, urls, false)
  audio?.setProject(req.project, urls, false)
  const channel = audio ? new MessageChannel() : null
  if (audio && channel) audio.connectPort(channel.port1)

  const job: ExportJobSpec = {
    jobId,
    width: req.width,
    height: req.height,
    fps: req.fps,
    fromUs: req.fromUs,
    toUs: req.toUs,
    video: { bitrate: req.videoBitrate, hw, keyFrameIntervalS: KEYFRAME_INTERVAL_S },
    audio: hasAudio ? { bitrate: req.audioBitrate } : null,
    ...(req.simulateHwFailure ? { simulateHwFailure: true } : {})
  }

  return new Promise<AttemptDone>((resolve, reject) => {
    let writes: Promise<void> = Promise.resolve()
    let settled = false
    const t0 = performance.now()
    let total = 0

    const finish = (outcome: { ok: true; value: AttemptDone } | { ok: false; error: Error }): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      off()
      // espera as gravações em curso antes de liberar o arquivo (finalize/cancel)
      void writes
        .catch(() => {})
        .then(() => {
          render.dispose()
          audio?.dispose()
          if (outcome.ok) resolve(outcome.value)
          else reject(outcome.error)
        })
    }
    const onAbort = (): void => {
      render.exportCancel(jobId)
      finish({ ok: false, error: new EditorExportCancelled() })
    }
    signal.addEventListener('abort', onAbort)

    const off = render.onMessage((m: RenderOut) => {
      if (settled) return
      switch (m.t) {
        case 'exportChunk':
          if (m.jobId !== jobId) return
          writes = writes
            .then(() => api.editorExport.write(jobId, m.data, m.position))
            .then(
              () => render.chunkAck(jobId, m.seq),
              (e: unknown) => {
                render.exportCancel(jobId)
                finish({ ok: false, error: new Error(`Falha ao gravar o arquivo: ${e instanceof Error ? e.message : String(e)}`) })
                throw e
              }
            )
          break
        case 'exportProgress': {
          if (m.jobId !== jobId) return
          total = m.total
          const elapsedS = (performance.now() - t0) / 1000
          const doneS = m.frame / req.fps
          const speed = elapsedS > 0.5 ? doneS / elapsedS : null
          const fpsDone = elapsedS > 0 ? m.frame / elapsedS : 0
          onProgress?.({
            stage: 'render',
            frame: m.frame,
            total: m.total,
            percent: Math.min(98, (m.frame / m.total) * 98),
            speed,
            etaS: speed && fpsDone > 0 ? Math.max(0, (m.total - m.frame) / fpsDone) : null
          })
          break
        }
        case 'exportDone':
          if (m.jobId !== jobId) return
          if (audioWarnings.length) console.warn(`exportação: avisos de áudio: ${audioWarnings.join(' | ')}`)
          void writes.then(
            () => finish({ ok: true, value: { total, videoCodec: m.videoCodec, audioCodec: m.audioCodec } }),
            () => {}
          )
          break
        case 'exportError':
          if (m.jobId !== jobId) return
          finish({ ok: false, error: m.cancelled ? new EditorExportCancelled() : new AttemptError(m.message, m.beforeFirstPacket) })
          break
        case 'error':
          if (m.fatal) finish({ ok: false, error: new AttemptError(`render: ${m.message}`, false) })
          break
      }
    })
    render.exportStart(job, channel?.port2 ?? null)
  })
}
