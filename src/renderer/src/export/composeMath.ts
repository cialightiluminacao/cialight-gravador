// Lógica pura do compositor de exportação (sem DOM/mediabunny) — testável em Node:
// quando compor, grade de frames CFR do corte, cursor "último sample com timestamp ≤ t" e progresso.
import type { ExportOptions, Session } from '@shared/types'
import { PRESETS } from '@shared/presets/presets'

/** true quando a exportação precisa do vídeo composto (webcam e/ou anotações num preset que re-encodifica). */
export function needsComposition(session: Pick<Session, 'tracks' | 'strokes'>, options: Pick<ExportOptions, 'presetId' | 'includeWebcam' | 'includeAnnotations'>): boolean {
  if (PRESETS[options.presetId].copyVideo) return false
  const wantsWebcam = options.includeWebcam && session.tracks.webcam !== undefined
  const wantsStrokes = options.includeAnnotations && session.strokes.length > 0
  return wantsWebcam || wantsStrokes
}

/** Menor coisa que um sample decodificado precisa ter para o cursor. */
export interface TimedSample {
  /** Timestamp de apresentação em segundos. */
  timestamp: number
  close(): void
}

/** Plano de frames de saída (CFR) para o trecho [trimStartMs, trimEndMs]. */
export interface FramePlan {
  fps: number
  /** Início do corte (s). */
  startSec: number
  /** Fim do corte (s). */
  endSec: number
  /** Quantidade de frames a gerar (≥ 1). */
  frameCount: number
  /** Duração de cada frame (s). */
  frameDuration: number
  /**
   * true quando o corte não começa em 0: o arquivo composto recebe um único frame
   * "segurado" em t=0 com duração `startSec`, para a linha do tempo bater com rec.mp4
   * (o ffmpeg aplica o mesmo `-ss/-to` ao vídeo composto e ao áudio do bruto).
   */
  leadingHold: boolean
}

/** Monta o plano de frames; garante ao menos 1 frame e end > start. */
export function planFrames(trimStartMs: number, trimEndMs: number, fps: number): FramePlan {
  const safeFps = fps > 0 && Number.isFinite(fps) ? fps : 30
  const startSec = Math.max(0, trimStartMs) / 1000
  const endSec = Math.max(startSec + 1 / safeFps, trimEndMs / 1000)
  const frameCount = Math.max(1, Math.round((endSec - startSec) * safeFps))
  return { fps: safeFps, startSec, endSec, frameCount, frameDuration: 1 / safeFps, leadingHold: startSec > 0 }
}

/** Instante (s, na linha do tempo ORIGINAL) do frame `index` do plano. */
export function frameTimestamp(plan: FramePlan, index: number): number {
  return plan.startSec + index * plan.frameDuration
}

/** Progresso 0–100 do compositor (frames concluídos / total). */
export function composeProgress(framesDone: number, frameCount: number): number {
  if (frameCount <= 0) return 100
  return Math.max(0, Math.min(100, Math.round((framesDone / frameCount) * 100)))
}

/** Emite progresso a cada `every` frames e no último. */
export function shouldReportProgress(frameIndex: number, frameCount: number, every = 15): boolean {
  return frameIndex === frameCount - 1 || (frameIndex + 1) % every === 0
}

/**
 * Cursor sobre um iterador de samples em ordem de apresentação: `advanceTo(t)` devolve
 * o último sample com timestamp ≤ t (mantendo o anterior quando não há sample novo —
 * conteúdo estático repete o frame). Samples ultrapassados são fechados; o atual é
 * fechado ao ser substituído ou em `dispose()`.
 */
export class FrameCursor<S extends TimedSample> {
  private current: S | null = null
  private pending: S | null = null
  private done = false

  constructor(private readonly source: AsyncIterator<S>) {}

  private async pull(): Promise<S | null> {
    if (this.done) return null
    const r = await this.source.next()
    if (r.done) {
      this.done = true
      return null
    }
    return r.value
  }

  async advanceTo(timestampSec: number): Promise<S | null> {
    if (this.pending === null && !this.done) this.pending = await this.pull()
    while (this.pending !== null && this.pending.timestamp <= timestampSec) {
      this.current?.close()
      this.current = this.pending
      this.pending = await this.pull()
    }
    return this.current
  }

  /** Sample atual sem avançar. */
  get value(): S | null {
    return this.current
  }

  dispose(): void {
    this.current?.close()
    this.pending?.close()
    this.current = null
    this.pending = null
    this.done = true
    void this.source.return?.()
  }
}
