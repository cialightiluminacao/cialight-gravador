import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { basename, extname, join } from 'path'
import type { ExportProgress, ExportRequest } from '@shared/ipc'
import type { HwEncoder, Session } from '@shared/types'
import { PRESETS } from '@shared/presets/presets'
import { buildFfmpegArgs, PASSLOG_NAME, type FfmpegPlan } from '@shared/presets/ffmpegArgs'
import { estimateOutputMB } from '@shared/presets/sizeEstimate'
import { needsTwoPass, planForTarget } from '@shared/presets/sizeTarget'
import { sanitizeFileName, uniqueName } from '@shared/filenames'
import { probeFile, runFfmpeg, FfmpegError } from './ffmpegRunner'
import { probeEncoders } from './encoderProbe'
import { normalizeFallbackSession } from './fallbackRemux'
import { getSettings } from '../settings/settingsStore'
import type { SessionStore } from '../session/sessionStore'
import { log } from '../log'

// Job de exportação (main): decide encoder, monta o plano do ffmpeg
// (buildFfmpegArgs), executa os passos em sequência com progresso agregado e
// cancelamento. A composição PiP/anotações (composed.mp4) já vem pronta do
// renderer quando necessária.

interface Job {
  id: string
  abort: AbortController
}

const jobs = new Map<string, Job>()
let seq = 0

function pickEncoder(): Promise<HwEncoder> {
  const cached = getSettings().lastEncoderProbe
  if (cached && cached.available.length) return Promise.resolve(cached.preferred)
  return probeEncoders(false).then((p) => p.preferred)
}

function baseNameFrom(fileName: string): string {
  const clean = sanitizeFileName(fileName)
  const ext = extname(clean)
  return ext.toLowerCase() === '.mp4' || ext.toLowerCase() === '.mkv' ? clean.slice(0, -ext.length) : clean
}

/** Garante que nenhum arquivo do plano sobrescreva um existente (sufixo -2, -3…). */
function uniquifyPlanBase(outDir: string, base: string, sample: string[]): string {
  const existing = new Set(existsSync(outDir) ? readdirSync(outDir) : [])
  // testa com o primeiro output "representativo": se algum arquivo do plano já existe, gera outro base
  let candidate = base
  let n = 1
  const collides = (b: string): boolean => sample.some((s) => existing.has(s.replace(base, b)))
  while (collides(candidate)) {
    n++
    candidate = `${base}-${n}`
  }
  void uniqueName
  return candidate
}

export function startExportJob(req: ExportRequest, store: SessionStore, emit: (p: ExportProgress) => void): { jobId: string; cancel: () => void } {
  const jobId = `exp-${Date.now()}-${++seq}`
  const abort = new AbortController()
  jobs.set(jobId, { id: jobId, abort })
  const send = (p: Omit<ExportProgress, 'jobId'>): void => emit({ jobId, ...p })

  void (async () => {
    try {
      send({ stage: 'prepare', percent: 0, message: 'Preparando…' })
      let session: Session | null = store.get(req.sessionId)
      if (!session) throw new Error('Sessão não encontrada')
      const dir = store.dirOf(session.id)
      if (session.files.fallback) {
        session = await normalizeFallbackSession(session, dir)
        store.save(session)
      }
      const rec = join(dir, session.files.rec)
      const probe = await probeFile(rec)
      const video0 = probe.streams.find((s) => s.type === 'video')
      const durationMs = session.durationMs ?? probe.durationMs
      const opts = req.options
      const preset = PRESETS[opts.presetId]
      const encoder = preset.copyVideo ? 'libx264' : await pickEncoder()
      const outDir = opts.outputDir
      mkdirSync(outDir, { recursive: true })
      const trimStart = Math.max(0, opts.trimStartMs)
      const trimEnd = opts.trimEndMs !== null && opts.trimEndMs < durationMs ? opts.trimEndMs : null
      const effectiveMs = (trimEnd ?? durationMs) - trimStart
      const inputVideo = req.composedFile && existsSync(req.composedFile) ? req.composedFile : rec
      const micIdx = session.tracks.mic ?? null
      const sysIdx = session.tracks.system ?? null

      let twoPassKbps: number | null = null
      let targetHeight: number | null = null
      let warn: string | undefined
      if (preset.supportsTargetSize && opts.targetSizeMB) {
        const measured = probe.bitrate ? Math.round(probe.bitrate / 1000) : null
        const est = estimateOutputMB(preset, effectiveMs, video0?.height ?? session.video.height, video0?.fps ?? session.video.fps, measured)
        if (needsTwoPass(est, opts.targetSizeMB)) {
          const plan = planForTarget(opts.targetSizeMB, effectiveMs, preset.audioKbps, video0?.height ?? session.video.height)
          twoPassKbps = plan.kbps
          targetHeight = plan.height
          if (plan.warn === 'document') warn = 'Qualidade ficará baixa neste tamanho — considere enviar como documento no WhatsApp.'
          log.info(`alvo ${opts.targetSizeMB} MB: estimativa ${est.toFixed(1)} MB → 2-pass ${plan.kbps} kbps @${plan.height}p`)
        }
      }

      const base0 = baseNameFrom(opts.fileName)
      const dryPlan = buildFfmpegArgs({
        preset, encoder, inputVideo, inputAudio: rec, hasWebcamTrack: session.tracks.webcam !== undefined,
        micTrackIdx: micIdx, systemTrackIdx: sysIdx, audioMode: opts.audioMode, micOffsetMs: opts.micOffsetMs,
        trimStartMs: trimStart, trimEndMs: trimEnd, durationMs, srcWidth: video0?.width ?? session.video.width,
        srcHeight: video0?.height ?? session.video.height, srcFps: video0?.fps ?? session.video.fps, reels: opts.reels,
        targetSizeMB: opts.targetSizeMB, outDir, baseName: base0, twoPassKbps, targetHeight
      })
      const base = uniquifyPlanBase(outDir, base0, dryPlan.outputs.map((o) => basename(o)))
      const plan: FfmpegPlan = base === base0 ? dryPlan : buildFfmpegArgs({
        preset, encoder, inputVideo, inputAudio: rec, hasWebcamTrack: session.tracks.webcam !== undefined,
        micTrackIdx: micIdx, systemTrackIdx: sysIdx, audioMode: opts.audioMode, micOffsetMs: opts.micOffsetMs,
        trimStartMs: trimStart, trimEndMs: trimEnd, durationMs, srcWidth: video0?.width ?? session.video.width,
        srcHeight: video0?.height ?? session.video.height, srcFps: video0?.fps ?? session.video.fps, reels: opts.reels,
        targetSizeMB: opts.targetSizeMB, outDir, baseName: base, twoPassKbps, targetHeight
      })

      const total = plan.steps.length
      for (let i = 0; i < total; i++) {
        if (abort.signal.aborted) throw new Error('cancelado')
        const step = plan.steps[i]
        const stage: ExportProgress['stage'] = step.label === 'pass1' ? 'pass1' : step.label === 'pass2' ? 'pass2' : 'encode'
        const stepBase = (i / total) * 100
        const stepSpan = 100 / total
        send({ stage, percent: Math.round(stepBase), message: stepLabel(step.label, i, total) })
        await runFfmpeg(step.args, {
          signal: abort.signal,
          label: step.label,
          cwd: dir,
          onProgress: (p) => {
            const frac = Math.min(1, p.outTimeUs / 1000 / Math.max(1, effectiveMs))
            send({ stage, percent: Math.round(stepBase + frac * stepSpan), message: `${stepLabel(step.label, i, total)}${p.speed ? ` · ${p.speed}` : ''}` })
          }
        })
      }
      // limpa logs do 2-pass
      for (const step of plan.steps) {
        if (!step.passLogPrefix) continue
        const prefixDir = join(dir)
        for (const f of existsSync(prefixDir) ? readdirSync(prefixDir) : []) {
          if (f.startsWith(PASSLOG_NAME)) rmSync(join(prefixDir, f), { force: true })
        }
      }
      if (session.state !== 'finalized') {
        session.state = 'finalized'
        store.save(session)
      }
      send({ stage: 'done', percent: 100, outputs: plan.outputs, message: warn })
    } catch (e) {
      if (abort.signal.aborted) {
        send({ stage: 'cancelled', percent: 0, message: 'Exportação cancelada' })
      } else {
        const msg = e instanceof FfmpegError ? `${e.message}\n${e.stderrTail}` : e instanceof Error ? e.message : String(e)
        log.error('exportação falhou', msg)
        send({ stage: 'error', percent: 0, error: msg })
      }
    } finally {
      jobs.delete(jobId)
    }
  })()

  return { jobId, cancel: () => abort.abort() }
}

export function cancelExportJob(jobId: string): void {
  jobs.get(jobId)?.abort.abort()
}

function stepLabel(label: string, i: number, total: number): string {
  const names: Record<string, string> = {
    encode: 'Codificando vídeo',
    pass1: 'Analisando (passo 1 de 2)',
    pass2: 'Codificando (passo 2 de 2)',
    tela: 'Extraindo tela',
    webcam: 'Extraindo webcam',
    mic: 'Extraindo microfone',
    sistema: 'Extraindo áudio do sistema',
    combinado: 'Gerando arquivo combinado'
  }
  const n = names[label] ?? label
  return total > 1 ? `${n} (${i + 1}/${total})` : n
}
