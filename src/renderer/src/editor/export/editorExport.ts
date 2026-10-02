// Exportação do editor (thread principal): sobe uma instância PRÓPRIA do render worker (OffscreenCanvas na
// resolução de saída) e um audio worker de exportação ligados por MessageChannel — o preview continua vivo e
// intocado. Os bytes do MP4 vão para `<saída>.part` via IPC (editorExport.write) com contrapressão (chunkAck
// depois de gravar); no fim o main remuxa com faststart. Falha do CODIFICADOR de hardware antes do 1º pacote →
// nova tentativa com `prefer-software` (outras falhas mostram a causa real); HEVC (só hardware) que falha antes
// do 1º pacote → a mesma exportação em H.264 (hardware → software), com aviso. Tamanho-alvo (qualquer): saída acima do alvo
// é refeita uma vez com bitrate × (alvo/obtido) × 0,97 ("Ajustando tamanho…"). Uma exportação por vez.
import { planAudio } from '@shared/editor/audioPlan'
import type { Project, Us } from '@shared/editor/project'
import { RenderClient } from '../engine/RenderClient'
import { AudioClient } from '../engine/audio/AudioClient'
import { mediaUrlsFor } from '../engine/mediaUrls'
import type { ExportJobSpec, HwPref, RenderOut } from '../engine/protocol'
import { KEYFRAME_INTERVAL_S, missingMediaWarnings, resizeBitrate } from './exportPlan'
import type { VideoCodecChoice } from './exportPresets'
import { EditorExportCancelled, finalizeOrCancel, type Finalized } from './finalize'
import { ipcErrorMessage } from '@/lib/ipcError'

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
  /** Codec pedido (padrão H.264). HEVC só por hardware; se falhar antes do 1º pacote, sai em H.264. */
  codec?: VideoCodecChoice
  /** Intervalo entre quadros-chave (s); padrão 2 s. */
  keyFrameIntervalS?: number
  /** Tamanho estimado (bytes): o main exige estimativa × 2,1 livres antes de começar. */
  estimateBytes?: number
  /** Tamanho máximo (bytes) da saída (tamanho alvo): acima disso, refaz uma vez com bitrate corrigido. */
  targetBytes?: number
  /** Testes: simula a falha do encoder de hardware (exercita a nova tentativa em software). */
  simulateHwFailure?: boolean
  /** Testes: simula a falha do encoder HEVC (exercita a volta para H.264). */
  simulateHevcFailure?: boolean
}

export interface EditorExportProgress {
  /** render: codificando; resize: 2ª passada para caber no tamanho-alvo; finalize: remux faststart. */
  stage: 'render' | 'resize' | 'finalize'
  frame: number
  total: number
  /** 0–100 da passada atual (o remux ocupa os últimos 2 %). */
  percent: number
  /** Velocidade em × tempo real, medida a partir do 1º quadro codificado (null antes disso). */
  speed: number | null
  /** Segundos restantes estimados (null antes do 1º quadro codificado). */
  etaS: number | null
}

export interface EditorExportResult {
  path: string
  size: number
  width: number
  height: number
  fps: number
  /** Codec realmente usado (HEVC que falhou sai como h264). */
  codec: VideoCodecChoice
  /** Codec string completo do encoder (avc1.…/hvc1.…). */
  videoCodec: string
  audioCodec: 'aac' | 'opus' | null
  hardware: HwPref
  /** Encoder de hardware falhou e a exportação foi refeita em software. */
  fellBackToSoftware: boolean
  /** HEVC falhou e a exportação foi refeita em H.264. */
  fellBackFromHevc: boolean
  /** Passadas de codificação (2 = refeita para caber no tamanho-alvo). */
  passes: number
  /** Avisos para a tela de concluído (mídia de áudio que falhou, alvo de tamanho não atingido). */
  warnings: string[]
}

export { EditorExportCancelled }

class AttemptError extends Error {
  constructor(message: string, readonly retryInSoftware: boolean) {
    super(message)
  }
}

const MiB = 1024 * 1024
const formatMB = (b: number): string => `${(b / MiB).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`

let running = false

/** Há uma exportação do editor em andamento. */
export function editorExportRunning(): boolean {
  return running
}

type OnProgress = (p: EditorExportProgress) => void

export async function runEditorExport(req: EditorExportRequest, opts: { onProgress?: OnProgress; signal?: AbortSignal } = {}): Promise<EditorExportResult> {
  if (running) throw new Error('Já existe uma exportação em andamento')
  running = true
  const api = window.api
  const signal = opts.signal ?? new AbortController().signal
  const durationUs = req.toUs - req.fromUs
  try {
    let videoBitrate = req.videoBitrate
    let hw: HwPref = 'prefer-hardware'
    let codec: VideoCodecChoice = req.codec ?? 'h264'
    let fellBack = false
    let fellBackFromHevc = false
    const warnings = new Set<string>()
    for (let pass = 1; ; pass++) {
      const stage = pass === 1 ? 'render' : 'resize'
      const enc = await encode({ ...req, videoBitrate }, codec, hw, stage, signal, opts.onProgress)
      hw = enc.hardware
      codec = enc.codec
      fellBack ||= enc.fellBack
      fellBackFromHevc ||= enc.fellBackFromHevc
      for (const w of enc.warnings) warnings.add(w)
      // remux: progresso real do ffmpeg nos últimos 2 %
      const off = api.editorExport.onFinalizeProgress((p) => {
        if (p.jobId === enc.jobId) opts.onProgress?.({ stage: 'finalize', frame: enc.total, total: enc.total, percent: 98 + 2 * p.fraction, speed: null, etaS: null })
      })
      let out: Finalized
      try {
        opts.onProgress?.({ stage: 'finalize', frame: enc.total, total: enc.total, percent: 98, speed: null, etaS: null })
        out = await finalizeOrCancel(api.editorExport, enc.jobId, { durationUs, maxBytes: pass === 1 ? req.targetBytes : undefined }, signal)
      } finally {
        off()
      }
      if (out.oversize && req.targetBytes && pass === 1) {
        videoBitrate = resizeBitrate(videoBitrate, req.targetBytes, out.size)
        console.warn(`exportação: ${out.size} bytes > alvo ${req.targetBytes}; refazendo a ${videoBitrate} bps`)
        continue
      }
      if (out.warning) warnings.add(out.warning)
      if (req.targetBytes && out.size > req.targetBytes) warnings.add(`O vídeo ficou com ${formatMB(out.size)}, acima do alvo de ${formatMB(req.targetBytes)}.`)
      opts.onProgress?.({ stage: 'finalize', frame: enc.total, total: enc.total, percent: 100, speed: null, etaS: null })
      return {
        path: out.path,
        size: out.size,
        width: req.width,
        height: req.height,
        fps: req.fps,
        codec,
        videoCodec: enc.videoCodec,
        audioCodec: enc.audioCodec,
        hardware: hw,
        fellBackToSoftware: fellBack,
        fellBackFromHevc,
        passes: pass,
        warnings: [...warnings]
      }
    }
  } finally {
    running = false
  }
}

interface Encoded {
  jobId: string
  total: number
  videoCodec: string
  audioCodec: 'aac' | 'opus' | null
  hardware: HwPref
  codec: VideoCodecChoice
  fellBack: boolean
  fellBackFromHevc: boolean
  warnings: string[]
}

/** Aviso da tela de concluído quando o HEVC falha. */
export const HEVC_FALLBACK_WARNING = 'HEVC falhou; exportado em H.264.'

/**
 * Codifica para um .part novo. Falha do codificador antes do 1º pacote: HEVC → H.264 (hardware), e H.264 de
 * hardware → software.
 */
async function encode(req: EditorExportRequest, codec: VideoCodecChoice, hw: HwPref, stage: 'render' | 'resize', signal: AbortSignal, onProgress?: OnProgress): Promise<Encoded> {
  const api = window.api
  let fellBack = false
  let fellBackFromHevc = false
  for (;;) {
    if (signal.aborted) throw new EditorExportCancelled()
    const { jobId } = await api.editorExport.open(req.outputDir, req.fileName, { estimateBytes: req.estimateBytes })
    try {
      const done = await attempt(req, jobId, codec, hw, stage, signal, onProgress)
      const warnings = fellBackFromHevc ? [HEVC_FALLBACK_WARNING, ...done.warnings] : done.warnings
      return { jobId, ...done, warnings, hardware: hw, codec, fellBack, fellBackFromHevc }
    } catch (e) {
      await api.editorExport.cancel(jobId).catch(() => {})
      if (e instanceof EditorExportCancelled || signal.aborted) throw new EditorExportCancelled()
      if (e instanceof AttemptError && e.retryInSoftware) {
        if (codec === 'hevc') {
          console.warn(`exportação: encoder HEVC falhou (${e.message}); refazendo em H.264`)
          codec = 'h264'
          hw = 'prefer-hardware'
          fellBackFromHevc = true
          continue
        }
        if (hw === 'prefer-hardware') {
          console.warn(`exportação: encoder de hardware falhou (${e.message}); tentando em software`)
          hw = 'prefer-software'
          fellBack = true
          continue
        }
        throw new Error(`Não foi possível codificar o vídeo neste computador (${e.message}). Tente o preset WhatsApp (720p) ou atualize o driver de vídeo.`)
      }
      throw e
    }
  }
}

interface AttemptDone {
  total: number
  videoCodec: string
  audioCodec: 'aac' | 'opus' | null
  warnings: string[]
}

/** Uma tentativa completa (workers próprios, descartados no fim). */
function attempt(req: EditorExportRequest, jobId: string, codec: VideoCodecChoice, hw: HwPref, stage: 'render' | 'resize', signal: AbortSignal, onProgress?: OnProgress): Promise<AttemptDone> {
  const api = window.api
  const hasAudio = planAudio(req.project).some((s) => s.mode !== 'mute')
  const urls = mediaUrlsFor(req.project, 'export')
  const render = new RenderClient(new OffscreenCanvas(req.width, req.height), { width: req.width, height: req.height, dpr: 1 })
  const audio = hasAudio ? new AudioClient() : null
  // falhas de mídia de áudio (uma por asset): viram avisos no resultado (o trecho sai em silêncio)
  const audioWarnings = new Set<string>()
  audio?.onError((message, assetId) => {
    if (!assetId) return
    const name = req.project.assets.find((a) => a.id === assetId)?.name ?? assetId
    audioWarnings.add(`Áudio de “${name}” não pôde ser lido e saiu em silêncio (${message}).`)
  })
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
    video: { codec: codec === 'hevc' ? 'hevc' : 'avc', bitrate: req.videoBitrate, hw, keyFrameIntervalS: req.keyFrameIntervalS ?? KEYFRAME_INTERVAL_S },
    audio: hasAudio ? { bitrate: req.audioBitrate } : null,
    ...(req.simulateHwFailure ? { simulateHwFailure: true } : {}),
    ...(req.simulateHevcFailure ? { simulateHevcFailure: true } : {})
  }

  return new Promise<AttemptDone>((resolve, reject) => {
    let writes: Promise<void> = Promise.resolve()
    let settled = false
    let total = 0
    // velocidade/ETA medidas a partir do 1º quadro codificado (sem a abertura de decoders/encoder)
    let first: { t: number; frame: number } | null = null

    const finish = (outcome: { ok: true; value: AttemptDone } | { ok: false; error: Error }): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      off()
      offFatal?.()
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
    const offFatal = audio?.onFatal((message) => {
      render.exportCancel(jobId)
      finish({ ok: false, error: new AttemptError(`O processamento de áudio parou (${message}).`, false) })
    })

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
                finish({ ok: false, error: new Error(`Falha ao gravar o arquivo: ${ipcErrorMessage(e)}`) })
                throw e
              }
            )
          break
        case 'exportProgress': {
          if (m.jobId !== jobId) return
          total = m.total
          const now = performance.now()
          if (!first) first = { t: now, frame: m.frame }
          const elapsedS = (now - first.t) / 1000
          const frames = m.frame - first.frame
          const fpsDone = elapsedS > 0.3 && frames > 0 ? frames / elapsedS : null
          onProgress?.({
            stage,
            frame: m.frame,
            total: m.total,
            percent: Math.min(98, (m.frame / m.total) * 98),
            speed: fpsDone ? fpsDone / req.fps : null,
            etaS: fpsDone ? Math.max(0, (m.total - m.frame) / fpsDone) : null
          })
          break
        }
        case 'exportDone':
          if (m.jobId !== jobId) return
          void writes.then(
            () => {
              const media = missingMediaWarnings(req.project, m.missing)
              const ann = m.missingAnnotations.length ? [`As anotações de ${m.missingAnnotations.length === 1 ? 'uma gravação' : `${m.missingAnnotations.length} gravações`} não puderam ser lidas e ficaram de fora.`] : []
              finish({ ok: true, value: { total, videoCodec: m.videoCodec, audioCodec: m.audioCodec, warnings: [...media, ...ann, ...audioWarnings] } })
            },
            () => {}
          )
          break
        case 'exportError':
          if (m.jobId !== jobId) return
          finish({ ok: false, error: m.cancelled ? new EditorExportCancelled() : new AttemptError(m.message, m.encoderError && m.beforeFirstPacket) })
          break
        case 'error':
          if (m.fatal) finish({ ok: false, error: new AttemptError(`O render da exportação parou (${m.message}).`, false) })
          break
      }
    })
    render.exportStart(job, channel?.port2 ?? null)
  })
}
