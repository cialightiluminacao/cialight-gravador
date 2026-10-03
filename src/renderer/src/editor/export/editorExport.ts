// Exportação do editor (thread principal): sobe uma instância PRÓPRIA do render worker (OffscreenCanvas na
// resolução de saída) e um audio worker de exportação ligados por MessageChannel — o preview continua vivo e
// intocado. Os bytes do MP4 vão para `<saída>.part` via IPC (editorExport.write) com contrapressão (chunkAck
// depois de gravar); no fim o main remuxa com faststart. Falha do CODIFICADOR de hardware antes do 1º pacote →
// nova tentativa com `prefer-software` (outras falhas mostram a causa real); HEVC (só hardware) que falha antes
// do 1º pacote → a mesma exportação em H.264 (hardware → software), com aviso. O software também falhou antes do
// 1º pacote (ou o H.264 não existe no tamanho) → codificador de reserva: libx264 no main, alimentado por pipe com o
// PCM do trecho (antes) e os quadros RGBA do mesmo compositor (encodeChain.ts). Tamanho-alvo (qualquer): saída acima do alvo
// é refeita uma vez com bitrate × (alvo/obtido) × 0,97 ("Ajustando tamanho…"). Uma exportação por vez.
// Legendas: sem "queimar", a faixa de legendas sai escondida (o preview continua mostrando); com ".srt ao lado", o
// SRT do trecho exportado é gravado junto do arquivo FINAL (nome numerado) só depois da exportação concluir.
import { canEncodeVideo, Quality } from 'mediabunny'
import { planAudio } from '@shared/editor/audioPlan'
import { captionCues, withCaptionsHidden } from '@shared/editor/ops'
import { cuesForRange, serializeSrt } from '@shared/editor/srt'
import type { Project, Us } from '@shared/editor/project'
import { RenderClient } from '../engine/RenderClient'
import { AudioClient } from '../engine/audio/AudioClient'
import { mediaUrlsFor } from '../engine/mediaUrls'
import type { ExportJobSpec, HwPref, RenderOut } from '../engine/protocol'
import { audioRateWarning, KEYFRAME_INTERVAL_S, missingFontWarnings, missingMediaWarnings, resizeBitrate } from './exportPlan'
import type { VideoCodecChoice } from './exportPresets'
import { EditorExportCancelled, finalizeOrCancel, isCancelledReply, settleOrCancel, type Finalized } from './finalize'
import { firstEncodeStep, needsAvcCheck, nextEncodeStep, X264_FALLBACK_WARNING, X264_VIDEO_CODEC, x264PipeSpec, type EncodeStep } from './encodeChain'
import { pipeAudioBlocks, pipeFrames } from './formatExport'
import { editorExportRunning, withExportLock } from './exportLock'
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
  /** Testes: simula a falha do encoder H.264 em software antes do 1º pacote (exercita o codificador de reserva). */
  simulateSoftwareFailure?: boolean
  /** Testes: simula a falha do encoder HEVC (exercita a volta para H.264). */
  simulateHevcFailure?: boolean
  /** Testes: a 1ª passada usa 4× o bitrate pedido (passa do tamanho alvo → exercita a 2ª passada). */
  simulateFirstPassOvershoot?: boolean
  /** Legendas: desenhar no vídeo (padrão: sim) e/ou gravar `<nome>.srt` ao lado do arquivo final (padrão: não). */
  captions?: { burn: boolean; srtBeside: boolean }
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
  /** Codificando pelo codificador de reserva (libx264 no main): a interface mostra "Codificador de reserva". */
  reserve?: boolean
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
  /** Taxa de áudio realmente usada (bps; 0 sem áudio). Menor que a pedida → aviso em `warnings`. */
  audioBitrate: number
  hardware: HwPref
  /** Encoder de hardware falhou e a exportação foi refeita em software. */
  fellBackToSoftware: boolean
  /** HEVC falhou e a exportação foi refeita em H.264. */
  fellBackFromHevc: boolean
  /** O H.264 do WebCodecs (hardware e software) falhou: saiu pelo codificador de reserva (libx264). */
  fellBackToX264: boolean
  /** Passadas de codificação (2 = refeita para caber no tamanho-alvo). */
  passes: number
  /** Avisos para a tela de concluído (mídia de áudio que falhou, alvo de tamanho não atingido). */
  warnings: string[]
  /** .srt gravado ao lado do vídeo (captions.srtBeside). */
  srtPath?: string
  /** .srt pedido e não gravado (já existia um com o nome, nada no trecho, falha): o motivo, para um toast. */
  srtWarning?: string
}

export { EditorExportCancelled }

class AttemptError extends Error {
  constructor(message: string, readonly retryInSoftware: boolean) {
    super(message)
  }
}

const MiB = 1024 * 1024
const formatMB = (b: number): string => `${(b / MiB).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`

export { editorExportRunning }

type OnProgress = (p: EditorExportProgress) => void

export async function runEditorExport(req: EditorExportRequest, opts: { onProgress?: OnProgress; signal?: AbortSignal } = {}): Promise<EditorExportResult> {
  return withExportLock(() => runLocked(req, opts))
}

async function runLocked(input: EditorExportRequest, opts: { onProgress?: OnProgress; signal?: AbortSignal }): Promise<EditorExportResult> {
  const api = window.api
  const req = input.captions && !input.captions.burn ? { ...input, project: withCaptionsHidden(input.project) } : input
  const signal = opts.signal ?? new AbortController().signal
  const durationUs = req.toUs - req.fromUs
  let videoBitrate = req.simulateFirstPassOvershoot ? req.videoBitrate * 4 : req.videoBitrate
  let step: EncodeStep = firstEncodeStep(req.codec ?? 'h264')
  let fellBack = false
  let fellBackFromHevc = false
  const warnings = new Set<string>()
  for (let pass = 1; ; pass++) {
    const stage = pass === 1 ? 'render' : 'resize'
    const enc = await encode({ ...req, videoBitrate }, step, stage, signal, opts.onProgress)
    step = enc.step
    fellBack ||= enc.fellBack
    fellBackFromHevc ||= enc.fellBackFromHevc
    for (const w of enc.warnings) warnings.add(w)
    // remux (WebCodecs) / fim do ffmpeg (reserva): progresso real do ffmpeg nos últimos 2 %
    const off = api.editorExport.onFinalizeProgress((p) => {
      if (p.jobId === enc.jobId) opts.onProgress?.({ stage: 'finalize', frame: enc.total, total: enc.total, percent: 98 + 2 * p.fraction, speed: null, etaS: null })
    })
    let out: Finalized
    try {
      opts.onProgress?.({ stage: 'finalize', frame: enc.total, total: enc.total, percent: 98, speed: null, etaS: null })
      const maxBytes = pass === 1 ? req.targetBytes : undefined
      const jobId = enc.jobId
      out =
        step.kind === 'x264'
          ? await settleOrCancel(() => api.editorExport.pipeFinish(jobId, { maxBytes }), () => api.editorExport.cancel(jobId), signal)
          : await finalizeOrCancel(api.editorExport, jobId, { durationUs, maxBytes }, signal)
    } finally {
      off()
    }
    if (out.oversize && req.targetBytes && pass === 1) {
      // nunca acima do bitrate do pedido (o do alvo): com a 1ª passada inflada (teste) a regra linear subestimaria a correção
      videoBitrate = Math.min(req.videoBitrate, resizeBitrate(videoBitrate, req.targetBytes, out.size))
      console.warn(`exportação: ${out.size} bytes > alvo ${req.targetBytes}; refazendo a ${videoBitrate} bps`)
      continue
    }
    if (out.warning) warnings.add(out.warning)
    if (req.targetBytes && out.size > req.targetBytes) warnings.add(`O vídeo ficou com ${formatMB(out.size)}, acima do alvo de ${formatMB(req.targetBytes)}.`)
    // legendas: o .srt do trecho ao lado do arquivo FINAL (nome numerado), só depois da exportação concluir
    const srt = input.captions?.srtBeside ? await writeSrtBeside(input, out.path) : null
    if (srt?.warning) warnings.add(srt.warning)
    opts.onProgress?.({ stage: 'finalize', frame: enc.total, total: enc.total, percent: 100, speed: null, etaS: null })
    return {
      path: out.path,
      size: out.size,
      width: req.width,
      height: req.height,
      fps: req.fps,
      codec: step.kind === 'x264' ? 'h264' : step.codec,
      videoCodec: enc.videoCodec,
      audioCodec: enc.audioCodec,
      audioBitrate: enc.audioBitrate,
      hardware: step.kind === 'x264' ? 'prefer-software' : step.hw,
      fellBackToSoftware: fellBack,
      fellBackFromHevc,
      fellBackToX264: step.kind === 'x264',
      passes: pass,
      warnings: [...warnings],
      ...(srt?.path ? { srtPath: srt.path } : {}),
      ...(srt?.warning ? { srtWarning: srt.warning } : {})
    }
  }
}

/** SRT do trecho exportado ao lado do vídeo final; falha ou nada para gravar vira aviso (o vídeo já está pronto). */
async function writeSrtBeside(req: EditorExportRequest, videoPath: string): Promise<{ path?: string; warning?: string }> {
  const cues = cuesForRange(captionCues(req.project), req.fromUs, req.toUs)
  if (!cues.length) return { warning: 'Nenhuma legenda no trecho exportado: o arquivo .srt não foi gravado.' }
  try {
    const r = await window.api.captions.writeSrtBeside(videoPath, serializeSrt(cues))
    return r.path ? { path: r.path } : { warning: r.warning ?? 'O arquivo .srt não foi gravado.' }
  } catch (e) {
    return { warning: `Não foi possível gravar o arquivo .srt ao lado do vídeo (${ipcErrorMessage(e)}).` }
  }
}

interface Encoded {
  jobId: string
  total: number
  videoCodec: string
  audioCodec: 'aac' | 'opus' | null
  audioBitrate: number
  /** Passo da cadeia que codificou (a 2ª passada do tamanho-alvo começa nele). */
  step: EncodeStep
  fellBack: boolean
  fellBackFromHevc: boolean
  warnings: string[]
}

type EncodedBase = Omit<Encoded, 'step' | 'fellBack' | 'fellBackFromHevc'>

/** Aviso da tela de concluído quando o HEVC falha. */
export const HEVC_FALLBACK_WARNING = 'HEVC falhou; exportado em H.264.'

/** O H.264 do WebCodecs em software existe neste tamanho/bitrate? Erro na consulta = não. */
async function avcEncodable(req: EditorExportRequest): Promise<boolean> {
  try {
    return await canEncodeVideo('avc', { width: req.width, height: req.height, quality: new Quality({ bitrate: req.videoBitrate }), hardwareAcceleration: 'prefer-software' })
  } catch {
    return false
  }
}

/**
 * Codifica para um .part novo, a partir de `start` na cadeia (encodeChain.ts): falha do codificador antes do 1º
 * pacote passa ao próximo passo (HEVC → H.264 hardware → software → libx264 por pipe).
 */
async function encode(req: EditorExportRequest, start: EncodeStep, stage: 'render' | 'resize', signal: AbortSignal, onProgress?: OnProgress): Promise<Encoded> {
  const api = window.api
  let step = start
  let fellBack = false
  let fellBackFromHevc = false
  const advance = (why: string): void => {
    const next = nextEncodeStep(step)
    if (!next) throw new Error(`Não foi possível codificar o vídeo neste computador (${why}).`)
    const from = step.kind === 'x264' ? '' : step.codec === 'hevc' ? 'encoder HEVC' : step.hw === 'prefer-hardware' ? 'encoder de hardware' : 'H.264 em software'
    console.warn(`exportação: ${from} falhou (${why}); tentando ${next.kind === 'x264' ? 'o codificador de reserva (libx264)' : next.hw === 'prefer-software' ? 'em software' : 'em H.264'}`)
    if (step.kind === 'webcodecs' && step.codec === 'hevc') fellBackFromHevc = true
    if (next.kind === 'x264' || next.hw === 'prefer-software') fellBack = true
    step = next
  }
  const withFlags = (done: EncodedBase): Encoded => ({
    ...done,
    warnings: [...(fellBackFromHevc ? [HEVC_FALLBACK_WARNING] : []), ...(step.kind === 'x264' ? [X264_FALLBACK_WARNING] : []), ...done.warnings],
    step,
    fellBack,
    fellBackFromHevc
  })
  for (;;) {
    if (signal.aborted) throw new EditorExportCancelled()
    if (needsAvcCheck(step) && !(await avcEncodable(req))) {
      advance(`H.264 indisponível em ${req.width}×${req.height}`)
      continue
    }
    if (step.kind === 'x264') {
      try {
        return withFlags(await encodeX264(req, stage, signal, onProgress))
      } catch (e) {
        if (e instanceof EditorExportCancelled || signal.aborted) throw new EditorExportCancelled()
        throw new Error(`Não foi possível codificar o vídeo neste computador, nem com o codificador de reserva (${ipcErrorMessage(e)}).`)
      }
    }
    const { jobId } = await api.editorExport.open(req.outputDir, req.fileName, { estimateBytes: req.estimateBytes, reserveSrt: req.captions?.srtBeside === true })
    try {
      const done = await attempt(req, jobId, step.codec, step.hw, stage, signal, onProgress)
      return withFlags({ jobId, ...done })
    } catch (e) {
      await api.editorExport.cancel(jobId).catch(() => {})
      if (e instanceof EditorExportCancelled || signal.aborted) throw new EditorExportCancelled()
      if (e instanceof AttemptError && e.retryInSoftware) {
        advance(e.message)
        continue
      }
      throw e
    }
  }
}

/** Parte do progresso da passada ocupada pelo áudio no codificador de reserva (o resto são os quadros). */
const X264_AUDIO_SHARE = 4

/**
 * Codificador de reserva: abre o job x264 no main, manda o PCM do trecho (mesmo mixer e grade da exportação de
 * vídeo) e depois os quadros RGBA do mesmo compositor (t = n/fps) com contrapressão. O fim (pipeFinish) é do laço
 * das passadas. Falha ou cancelamento cancelam o job (o main apaga .part e o áudio temporário).
 */
async function encodeX264(req: EditorExportRequest, stage: 'render' | 'resize', signal: AbortSignal, onProgress?: OnProgress): Promise<EncodedBase> {
  const api = window.api.editorExport
  const hasAudio = planAudio(req.project).some((s) => s.mode !== 'mute')
  const spec = x264PipeSpec({ ...req, keyFrameIntervalS: req.keyFrameIntervalS ?? KEYFRAME_INTERVAL_S }, hasAudio)
  if (signal.aborted) throw new EditorExportCancelled()
  // espaço: + o PCM temporário (f32 estéreo)
  const estimateBytes = req.estimateBytes ? req.estimateBytes + (spec.audio?.samples ?? 0) * 8 : undefined
  const { jobId } = await api.openPipe(req.outputDir, req.fileName, spec, { estimateBytes, reserveSrt: req.captions?.srtBeside === true })
  try {
    const warnings: string[] = []
    if (spec.audio) {
      const audio = await pipeAudioBlocks(req, jobId, signal, (done, total) =>
        onProgress?.({ stage, frame: 0, total: 0, percent: (done / total) * X264_AUDIO_SHARE, speed: null, etaS: null, reserve: true })
      )
      warnings.push(...audio.warnings)
    }
    const frames = await pipeFrames(req, jobId, signal, (frame, total, speed, etaS) =>
      onProgress?.({ stage, frame, total, percent: X264_AUDIO_SHARE + (frame / total) * (98 - X264_AUDIO_SHARE), speed, etaS, reserve: true })
    )
    warnings.push(...frames.warnings)
    return { jobId, total: frames.frames, videoCodec: X264_VIDEO_CODEC, audioCodec: spec.audio ? 'aac' : null, audioBitrate: spec.audio ? spec.audio.kbps * 1000 : 0, warnings }
  } catch (e) {
    await api.cancel(jobId).catch(() => {})
    if (e instanceof EditorExportCancelled || signal.aborted) throw new EditorExportCancelled()
    throw e
  }
}

interface AttemptDone {
  total: number
  videoCodec: string
  audioCodec: 'aac' | 'opus' | null
  audioBitrate: number
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
    ...(req.simulateSoftwareFailure ? { simulateSoftwareFailure: true } : {}),
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
              (reply) => {
                // o main já cancelou o job (janela/saída): cancelamento, não erro
                if (isCancelledReply(reply)) {
                  render.exportCancel(jobId)
                  finish({ ok: false, error: new EditorExportCancelled() })
                  return
                }
                render.chunkAck(jobId, m.seq)
              },
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
              const fonts = missingFontWarnings(m.missingFonts)
              const rate = audioRateWarning(req.audioBitrate, m.audioBitrate, m.audioCodec)
              finish({ ok: true, value: { total, videoCodec: m.videoCodec, audioCodec: m.audioCodec, audioBitrate: m.audioBitrate, warnings: [...media, ...ann, ...fonts, ...audioWarnings, ...(rate ? [rate] : [])] } })
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
