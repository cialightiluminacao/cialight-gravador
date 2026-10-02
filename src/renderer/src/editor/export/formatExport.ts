// Formatos extras da exportação do editor (thread principal): GIF curto, quadro PNG e só áudio. Mesmo
// caminho de quadros/áudio da exportação de vídeo ("preview = export"): uma instância PRÓPRIA do render worker
// (OffscreenCanvas no tamanho de saída) e/ou um AudioClient de exportação; o preview fica intocado.
//  - GIF: quadros RGBA do compositor (exportFramesStart) → editorExport.pipeWrite (ffmpeg FFV1 sem perdas) →
//    pipeFinish (paleta + paletteuse). Progresso: quadros 0–80 %, paleta 80–100 %.
//  - Só áudio: blocos de 100 ms do mixer (a mesma grade da exportação de vídeo) → pipeWrite (PCM f32 estéreo
//    48 kHz) → ffmpeg (wav/mp3/m4a). Total de quadros = round(duração·48 kHz), exato.
//  - PNG: composeAt no instante pedido → canvas.convertToBlob → writeStill (atômico).
// Contrapressão de ponta a ponta: cada pipeWrite é esperado antes de liberar o próximo (≤ 2 em voo). Cancelar
// apaga parcial e temporários (main). Uma exportação por vez (exportLock).
import type { Project, Us } from '@shared/editor/project'
import { RenderClient } from '../engine/RenderClient'
import { AudioClient } from '../engine/audio/AudioClient'
import { mediaUrlsFor } from '../engine/mediaUrls'
import type { FramesJobSpec, RenderOut } from '../engine/protocol'
import { missingMediaWarnings } from './exportPlan'
import { audioBlocks, audioOnlyBlocker, audioPipeSpec, gifPipeSpec, type AudioFormat } from './formatPlan'
import { EditorExportCancelled, isCancelledReply, settleOrCancel } from './finalize'
import { withExportLock } from './exportLock'
import type { EditorExportProgress } from './editorExport'
import { ipcErrorMessage } from '@/lib/ipcError'

export interface FormatExportResult {
  kind: 'gif' | 'png' | 'audio'
  path: string
  size: number
  /** GIF/PNG: tamanho da imagem. */
  width?: number
  height?: number
  /** GIF: quadros e fps. */
  frames?: number
  fps?: number
  /** Só áudio: formato. */
  format?: AudioFormat
  warnings: string[]
}

type OnProgress = (p: EditorExportProgress) => void
interface RunOpts {
  onProgress?: OnProgress
  signal?: AbortSignal
}

export interface GifExportRequest {
  project: Project
  width: number
  height: number
  fps: number
  fromUs: Us
  toUs: Us
  outputDir: string
  fileName: string
  /** Espaço em disco (gifDiskBytes): o main exige × 2,1 livres. */
  estimateBytes?: number
}

export interface AudioExportRequest {
  project: Project
  fromUs: Us
  toUs: Us
  format: AudioFormat
  outputDir: string
  fileName: string
  estimateBytes?: number
}

export interface StillExportRequest {
  project: Project
  tUs: Us
  outputDir: string
  fileName: string
}

/** GIF: parte dos quadros no progresso (o resto é a paleta). */
const GIF_RENDER_SHARE = 80
/** Só áudio: parte da mixagem no progresso (o resto é fechar o arquivo). */
const AUDIO_RENDER_SHARE = 98

/** Rejeita com EditorExportCancelled se o sinal abortar antes de `p`. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new EditorExportCancelled())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new EditorExportCancelled())
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      }
    )
  })
}

/** Fim de uma saída por pipe com o progresso do main (0–1) mapeado em [from, 100]. */
async function finishPipe(jobId: string, signal: AbortSignal, total: number, from: number, onProgress?: OnProgress): Promise<{ path: string; size: number; warning?: string }> {
  const api = window.api.editorExport
  const report = (fraction: number): void => onProgress?.({ stage: 'finalize', frame: total, total, percent: from + (100 - from) * fraction, speed: null, etaS: null })
  const off = api.onFinalizeProgress((p) => {
    if (p.jobId === jobId) report(p.fraction)
  })
  try {
    report(0)
    const out = await settleOrCancel(() => api.pipeFinish(jobId), () => api.cancel(jobId), signal)
    report(1)
    return out
  } finally {
    off()
  }
}

/** Abre o pipe, roda `produce` e finaliza; qualquer falha/cancelamento cancela o job (main apaga tudo). */
async function withPipe<T>(open: () => Promise<{ jobId: string }>, signal: AbortSignal, produce: (jobId: string) => Promise<T>): Promise<{ jobId: string; value: T }> {
  if (signal.aborted) throw new EditorExportCancelled()
  const { jobId } = await open()
  try {
    return { jobId, value: await produce(jobId) }
  } catch (e) {
    await window.api.editorExport.cancel(jobId).catch(() => {})
    if (e instanceof EditorExportCancelled || signal.aborted) throw new EditorExportCancelled()
    throw e
  }
}

/**
 * Quadros RGBA do compositor (o mesmo laço de quadros da exportação de vídeo) → editorExport.pipeWrite do job
 * `jobId`, com contrapressão (o worker espera o ack de cada quadro gravado; ≤ 2 em voo). Reutilizável pelo
 * fallback libx264. Resolve com o total de quadros e os avisos de mídia indisponível.
 */
export function pipeFrames(
  req: { project: Project; width: number; height: number; fps: number; fromUs: Us; toUs: Us },
  jobId: string,
  signal: AbortSignal,
  onFrame?: (frame: number, total: number, speed: number | null, etaS: number | null) => void
): Promise<{ frames: number; warnings: string[] }> {
  const api = window.api.editorExport
  const render = new RenderClient(new OffscreenCanvas(req.width, req.height), { width: req.width, height: req.height, dpr: 1 })
  render.setProject(req.project, mediaUrlsFor(req.project, 'export'), false)
  const job: FramesJobSpec = { jobId, width: req.width, height: req.height, fps: req.fps, fromUs: req.fromUs, toUs: req.toUs }
  return new Promise((resolve, reject) => {
    let writes: Promise<void> = Promise.resolve()
    let settled = false
    let first: { t: number; frame: number } | null = null
    const finish = (outcome: { ok: true; value: { frames: number; warnings: string[] } } | { ok: false; error: Error }): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      off()
      void writes
        .catch(() => {})
        .then(() => {
          render.dispose()
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
        case 'exportFrame': {
          if (m.jobId !== jobId) return
          const { seq, total } = m
          const data = new Uint8Array(m.rgba)
          writes = writes
            .then(() => api.pipeWrite(jobId, data))
            .then(
              (reply) => {
                // o main já cancelou o job (janela/saída): cancelamento, não erro
                if (isCancelledReply(reply)) {
                  render.exportCancel(jobId)
                  finish({ ok: false, error: new EditorExportCancelled() })
                  return
                }
                render.chunkAck(jobId, seq)
                const now = performance.now()
                if (!first) first = { t: now, frame: seq }
                const elapsedS = (now - first.t) / 1000
                const fpsDone = elapsedS > 0.3 && seq > first.frame ? (seq - first.frame) / elapsedS : null
                onFrame?.(seq, total, fpsDone ? fpsDone / req.fps : null, fpsDone ? Math.max(0, (total - seq) / fpsDone) : null)
              },
              (e: unknown) => {
                render.exportCancel(jobId)
                finish({ ok: false, error: new Error(`Falha ao gravar o arquivo: ${ipcErrorMessage(e)}`) })
                throw e
              }
            )
          break
        }
        case 'exportFramesDone':
          if (m.jobId !== jobId) return
          void writes.then(
            () => {
              const ann = m.missingAnnotations.length ? [`As anotações de ${m.missingAnnotations.length === 1 ? 'uma gravação' : `${m.missingAnnotations.length} gravações`} não puderam ser lidas e ficaram de fora.`] : []
              finish({ ok: true, value: { frames: m.frames, warnings: [...missingMediaWarnings(req.project, m.missing), ...ann] } })
            },
            () => {}
          )
          break
        case 'exportError':
          if (m.jobId !== jobId) return
          finish({ ok: false, error: m.cancelled ? new EditorExportCancelled() : new Error(m.message) })
          break
        case 'error':
          if (m.fatal) finish({ ok: false, error: new Error(`O render da exportação parou (${m.message}).`) })
          break
      }
    })
    render.exportFramesStart(job)
  })
}

/** GIF curto (sem áudio): quadros do compositor no tamanho do GIF → paleta → GIF em loop. */
export function runGifExport(req: GifExportRequest, opts: RunOpts = {}): Promise<FormatExportResult> {
  return withExportLock(async () => {
    const signal = opts.signal ?? new AbortController().signal
    const api = window.api.editorExport
    const { jobId, value } = await withPipe(
      () => api.openPipe(req.outputDir, req.fileName, gifPipeSpec(req.width, req.height, req.fps), { estimateBytes: req.estimateBytes }),
      signal,
      (id) =>
        pipeFrames(req, id, signal, (frame, total, speed, etaS) =>
          opts.onProgress?.({ stage: 'render', frame, total, percent: (frame / total) * GIF_RENDER_SHARE, speed, etaS })
        )
    )
    const out = await finishPipe(jobId, signal, value.frames, GIF_RENDER_SHARE, opts.onProgress)
    return { kind: 'gif', path: out.path, size: out.size, width: req.width, height: req.height, frames: value.frames, fps: req.fps, warnings: [...value.warnings, ...(out.warning ? [out.warning] : [])] }
  })
}

/**
 * Só áudio: PCM do mixer de exportação em blocos de 100 ms a partir do início do trecho (a mesma grade e o
 * mesmo mixer da exportação de vídeo: o áudio sai igual ao do vídeo do mesmo trecho) → ffmpeg.
 */
export function runAudioExport(req: AudioExportRequest, opts: RunOpts = {}): Promise<FormatExportResult> {
  return withExportLock(async () => {
    const signal = opts.signal ?? new AbortController().signal
    const blocker = audioOnlyBlocker(req.project)
    if (blocker) throw new Error(blocker)
    const api = window.api.editorExport
    const blocks = audioBlocks(req.fromUs, req.toUs)
    if (!blocks.length) throw new Error('Intervalo de exportação vazio')
    const audio = new AudioClient()
    const warnings = new Set<string>()
    let fatal: ((e: Error) => void) | null = null
    const died = new Promise<never>((_, reject) => (fatal = reject))
    died.catch(() => {})
    audio.onError((message, assetId) => {
      if (!assetId) return
      const name = req.project.assets.find((a) => a.id === assetId)?.name ?? assetId
      warnings.add(`Áudio de “${name}” não pôde ser lido e saiu em silêncio (${message}).`)
    })
    audio.onFatal((message) => fatal?.(new Error(`O processamento de áudio parou (${message}).`)))
    try {
      audio.setProject(req.project, mediaUrlsFor(req.project, 'export'), false)
      const { jobId } = await withPipe(
        () => api.openPipe(req.outputDir, req.fileName, audioPipeSpec(req.format), { estimateBytes: req.estimateBytes }),
        signal,
        async (id) => {
          const t0 = performance.now()
          const durS = (req.toUs - req.fromUs) / 1e6
          // um bloco mixando enquanto o anterior é gravado (≤ 2 em voo)
          let next: Promise<Awaited<ReturnType<AudioClient['render']>>> | null = audio.render(blocks[0].fromUs, blocks[0].frames)
          for (let k = 0; k < blocks.length; k++) {
            const block = await abortable(Promise.race([next!, died]), signal)
            if (!block || block.pcm.length !== blocks[k].frames * 2) throw new Error(`Falha ao mixar o áudio em ${((blocks[k].fromUs - req.fromUs) / 1e6).toFixed(1)} s.`)
            next = k + 1 < blocks.length ? audio.render(blocks[k + 1].fromUs, blocks[k + 1].frames) : null
            const pcm = block.pcm
            if (isCancelledReply(await abortable(api.pipeWrite(id, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)), signal))) throw new EditorExportCancelled()
            const elapsedS = (performance.now() - t0) / 1000
            const doneS = ((k + 1) / blocks.length) * durS
            const speed = elapsedS > 0.3 ? doneS / elapsedS : null
            opts.onProgress?.({ stage: 'render', frame: k + 1, total: blocks.length, percent: ((k + 1) / blocks.length) * AUDIO_RENDER_SHARE, speed, etaS: speed ? Math.max(0, (durS - doneS) / speed) : null })
          }
        }
      )
      const out = await finishPipe(jobId, signal, blocks.length, AUDIO_RENDER_SHARE, opts.onProgress)
      return { kind: 'audio', path: out.path, size: out.size, format: req.format, warnings: [...warnings, ...(out.warning ? [out.warning] : [])] }
    } finally {
      audio.dispose()
    }
  })
}

/** Cliente de render que o quadro PNG usa (RenderClient; os testes injetam um falso). */
export interface StillClient {
  readonly ready: Promise<void>
  setProject(project: Project, mediaUrls: ReturnType<typeof mediaUrlsFor>, useProxy: boolean): void
  exportStill(tUs: Us): Promise<Extract<RenderOut, { t: 'still' }>>
  dispose(): void
}

export interface StillOpts {
  signal?: AbortSignal
  /** Prazo do render do quadro (padrão STILL_TIMEOUT_MS): decoder/GPU pendurado não prende a exportação. */
  timeoutMs?: number
  client?: (width: number, height: number) => StillClient
}

/** Prazo do quadro PNG. */
export const STILL_TIMEOUT_MS = 30_000

const defaultStillClient = (width: number, height: number): StillClient => new RenderClient(new OffscreenCanvas(width, height), { width, height, dpr: 1 })

/** Rejeita se `p` não resolver em `ms` (o timer é sempre limpo). */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([p, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]).finally(() => clearTimeout(timer))
}

/**
 * Quadro em `tUs` como PNG no tamanho do projeto, renderizado numa instância própria (sem contorno de seleção):
 * os mesmos pixels do preview. Cancelável (signal) e com prazo (timeoutMs); a instância é sempre descartada.
 */
export async function renderStill(project: Project, tUs: Us, opts: StillOpts = {}): Promise<{ png: Uint8Array; warnings: string[] }> {
  const signal = opts.signal ?? new AbortController().signal
  if (signal.aborted) throw new EditorExportCancelled()
  const timeoutMs = opts.timeoutMs ?? STILL_TIMEOUT_MS
  const { width, height } = project.canvas
  const render = (opts.client ?? defaultStillClient)(width, height)
  const work = async (): Promise<Extract<RenderOut, { t: 'still' }>> => {
    await render.ready
    render.setProject(project, mediaUrlsFor(project, 'export'), false)
    return render.exportStill(tUs)
  }
  try {
    const r = await abortable(withTimeout(work(), timeoutMs, `O quadro não ficou pronto em ${Math.max(1, Math.round(timeoutMs / 1000))} s (o render parou de responder). Tente de novo.`), signal)
    if (!r.png) throw new Error(`Não foi possível gerar o quadro (${r.error ?? 'erro desconhecido'}).`)
    const ann = r.missingAnnotations.length ? ['As anotações não puderam ser lidas e ficaram de fora.'] : []
    return { png: new Uint8Array(r.png), warnings: [...missingMediaWarnings(project, r.missing.map((assetId) => ({ assetId, frames: 1 }))), ...ann] }
  } finally {
    render.dispose()
  }
}

/** Quadro PNG gravado na pasta (nunca sobrescreve). Cancelar/prazo estourado: nada é gravado; a trava sempre é solta. */
export function exportStill(req: StillExportRequest, opts: StillOpts = {}): Promise<FormatExportResult> {
  return withExportLock(async () => {
    const { png, warnings } = await renderStill(req.project, req.tUs, opts)
    if (opts.signal?.aborted) throw new EditorExportCancelled()
    const out = await window.api.editorExport.writeStill(req.outputDir, req.fileName, png)
    return { kind: 'png', path: out.path, size: out.size, width: req.project.canvas.width, height: req.project.canvas.height, warnings }
  })
}
