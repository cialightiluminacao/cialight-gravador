import { execFile, spawn } from 'child_process'
import { renameSync, rmSync, writeFileSync } from 'fs'
import { ffmpegPath } from '../export/ffmpegPath'
import { jpegScaleColorOpts, type SourceColor } from '@shared/editor/sourceColor'
import { FfmpegError, probeFile, runFfmpeg } from '../export/ffmpegRunner'
import { log } from '../log'
import { parseEbur128, parseSilencedetect, SPEECH_DEFAULTS, type Loudness, type SpeechFile } from '@shared/editor/speech'

// Análises para a timeline: filmstrip (sprite horizontal de miniaturas), peaks de áudio
// (min/max por 10 ms) e a miniatura do projeto. Saídas são escritas em <arquivo>.part e
// renomeadas no fim: nunca fica um arquivo pela metade com o nome final.

export const FILMSTRIP_TILE_H = 64
const FILMSTRIP_MAX_FRAMES = 300
const PEAKS_RATE = 8000
const PEAKS_WINDOW = PEAKS_RATE / 100 // 10 ms

export interface AnalysisOpts {
  signal?: AbortSignal
  onProgress?: (percent: number) => void
  /** Stream de entrada (ex.: '0:v:1' para a webcam do rec.mp4); padrão 1ª faixa do tipo. */
  map?: string
  /** Cor da fonte (probe) para ler o YUV pela regra única (sourceColor.ts); ausente = gravação do app (marcada). */
  source?: { color?: SourceColor | null; width: number; height: number } | null
}

export class CancelledError extends Error {
  constructor() {
    super('cancelado')
    this.name = 'CancelledError'
  }
}

/** Um quadro a cada max(1 s, dur/300). */
export function filmstripPlan(durationUs: number): { everyUs: number; frames: number } {
  const everyUs = Math.max(1_000_000, Math.round(durationUs / FILMSTRIP_MAX_FRAMES))
  const frames = Math.max(1, Math.min(FILMSTRIP_MAX_FRAMES, Math.ceil(durationUs / everyUs)))
  return { everyUs, frames }
}

let partSeq = 0

/**
 * Nome temporário único (pid + contador) com a mesma extensão (o ffmpeg escolhe o formato por ela):
 * uma execução cancelada que limpa o próprio .part nunca apaga o .part da execução que a substituiu.
 */
export function partPath(out: string): string {
  const tag = `.part-${process.pid}-${++partSeq}`
  const dot = out.lastIndexOf('.')
  return dot > out.lastIndexOf('\\') && dot > out.lastIndexOf('/') ? `${out.slice(0, dot)}${tag}${out.slice(dot)}` : `${out}${tag}`
}

/** Roda o ffmpeg gravando em .part; renomeia no sucesso, apaga no erro/cancelamento. */
export async function runToFile(args: (tmp: string) => string[], out: string, opts: AnalysisOpts, durationUs: number, label: string): Promise<void> {
  const tmp = partPath(out)
  try {
    const r = await runFfmpeg(args(tmp), {
      signal: opts.signal,
      label,
      onProgress: (p) => opts.onProgress?.(durationUs > 0 ? Math.min(99, Math.round((p.outTimeUs / durationUs) * 100)) : 0)
    })
    if (r.cancelled) throw new CancelledError()
    renameSync(tmp, out)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

export async function buildFilmstrip(
  input: string,
  outJpg: string,
  durationUs: number,
  opts: AnalysisOpts = {}
): Promise<{ file: string; frames: number; everyUs: number; tileW: number; tileH: number }> {
  const { everyUs, frames } = filmstripPlan(durationUs)
  await runToFile(
    (tmp) => [
      '-hide_banner', '-nostdin', '-y', '-i', input, '-map', opts.map ?? '0:v:0', '-an',
      // fps racional exato (1e6/everyUs quadros por segundo); tile completa com preto se faltar quadro no fim
      '-vf', `fps=1000000/${everyUs},scale=-2:${FILMSTRIP_TILE_H}:${jpegScaleColorOpts(opts.source ?? null)},tile=${frames}x1`,
      '-frames:v', '1', '-q:v', '5', '-update', '1', '-progress', 'pipe:1', '-nostats', tmp
    ],
    outJpg,
    opts,
    durationUs,
    'filmstrip'
  )
  // largura real da miniatura vem do scale=-2 (depende do aspecto e da rotação): mede o sprite
  const pr = await probeFile(outJpg)
  const width = pr.streams.find((s) => s.type === 'video')?.width ?? 0
  const height = pr.streams.find((s) => s.type === 'video')?.height ?? FILMSTRIP_TILE_H
  return { file: outJpg, frames, everyUs, tileW: Math.round(width / frames), tileH: height }
}

/** Miniatura única de 320 px de largura (resumo do projeto). */
export async function buildThumb(input: string, outJpg: string, durationUs: number, opts: AnalysisOpts = {}): Promise<string> {
  const atSec = Math.min(1, durationUs / 2 / 1_000_000)
  await runToFile(
    (tmp) => ['-hide_banner', '-nostdin', '-y', '-ss', atSec.toFixed(3), '-i', input, '-map', opts.map ?? '0:v:0', '-an', '-frames:v', '1', '-vf', `scale=320:-2:${jpegScaleColorOpts(opts.source ?? null)}`, '-q:v', '3', '-update', '1', '-progress', 'pipe:1', '-nostats', tmp],
    outJpg,
    opts,
    durationUs,
    'thumb'
  )
  return outJpg
}

/** min/max por janela de `window` amostras, quantizados ×127 em Int8 intercalados (min, max). */
export class PeaksAccumulator {
  private out = new Int8Array(4096)
  private len = 0
  private count = 0
  private min = Infinity
  private max = -Infinity

  constructor(private readonly window: number) {}

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]
      if (s < this.min) this.min = s
      if (s > this.max) this.max = s
      if (++this.count === this.window) this.emit()
    }
  }

  finish(): Int8Array {
    if (this.count > 0) this.emit()
    return this.out.slice(0, this.len)
  }

  private emit(): void {
    if (this.len + 2 > this.out.length) {
      const next = new Int8Array(this.out.length * 2)
      next.set(this.out)
      this.out = next
    }
    this.out[this.len++] = quantize(this.min)
    this.out[this.len++] = quantize(this.max)
    this.count = 0
    this.min = Infinity
    this.max = -Infinity
  }
}

function quantize(v: number): number {
  return Math.max(-127, Math.min(127, Math.round(v * 127)))
}

/** Peaks: ffmpeg decodifica para PCM float mono 8 kHz no stdout; 2 bytes a cada 10 ms. */
export function buildPeaks(input: string, outBin: string, opts: AnalysisOpts & { durationUs?: number } = {}): Promise<{ file: string; samplesPerSec: 100 }> {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostdin', '-v', 'error', '-i', input, '-map', opts.map ?? '0:a:0', '-vn', '-ac', '1', '-ar', String(PEAKS_RATE), '-f', 'f32le', 'pipe:1']
    log.info(`ffmpeg [peaks]: ${args.join(' ')}`)
    const child = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const acc = new PeaksAccumulator(PEAKS_WINDOW)
    let rest: Buffer = Buffer.alloc(0)
    let received = 0
    let lastPct = -1
    let cancelled = false
    let stderr = ''
    const expected = opts.durationUs ? (opts.durationUs / 1_000_000) * PEAKS_RATE : 0

    const onAbort = (): void => {
      cancelled = true
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => child.kill())
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (d: Buffer) => {
      // pedaços do pipe não respeitam o alinhamento de 4 bytes do float
      const buf = rest.length ? Buffer.concat([rest, d]) : d
      const usable = buf.length - (buf.length % 4)
      if (usable > 0) {
        // cópia alinhada (Float32Array exige offset múltiplo de 4)
        const f = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + usable))
        acc.push(f)
        received += f.length
      }
      rest = buf.subarray(usable)
      if (expected > 0 && opts.onProgress) {
        const pct = Math.min(99, Math.floor((received / expected) * 100))
        if (pct !== lastPct) opts.onProgress((lastPct = pct))
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-4000)
    })
    child.on('error', (e) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(new FfmpegError(`não foi possível iniciar o ffmpeg: ${e.message}`, '', -1))
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (cancelled) return reject(new CancelledError())
      if (code !== 0) return reject(new FfmpegError(`ffmpeg (peaks) saiu com código ${code}`, stderr, code ?? -1))
      const tmp = partPath(outBin)
      try {
        writeFileSync(tmp, acc.finish())
        renameSync(tmp, outBin)
      } catch (e) {
        rmSync(tmp, { force: true })
        return reject(e)
      }
      resolve({ file: outBin, samplesPerSec: 100 })
    })
  })
}

/**
 * Roda o ffmpeg só para ler o stderr de um filtro de análise (saída `-f null`). Guarda apenas as linhas que
 * casam com `keep` (silencedetect pode gerar milhares) e o progresso vem de `-progress pipe:1`.
 */
function runAnalysisFilter(input: string, map: string, filter: string, keep: RegExp, durationUs: number, opts: AnalysisOpts, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostdin', '-i', input, '-map', map, '-vn', '-af', filter, '-f', 'null', '-progress', 'pipe:1', '-nostats', '-']
    log.info(`ffmpeg [${label}]: ${args.join(' ')}`)
    const child = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const kept: string[] = []
    const tail: string[] = []
    let pending = ''
    let lastPct = -1
    let cancelled = false
    const onLine = (line: string): void => {
      if (!line.trim()) return
      if (keep.test(line)) kept.push(line)
      tail.push(line)
      if (tail.length > 20) tail.shift()
    }
    const onAbort = (): void => {
      cancelled = true
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => child.kill())
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout.on('data', (d: Buffer) => {
      const m = [...d.toString('utf8').matchAll(/out_time_us=(\d+)/g)].pop()
      if (!m || !(durationUs > 0) || !opts.onProgress) return
      const pct = Math.min(99, Math.floor((Number(m[1]) / durationUs) * 100))
      if (pct !== lastPct) opts.onProgress((lastPct = pct))
    })
    child.stderr.on('data', (d: Buffer) => {
      const lines = (pending + d.toString('utf8')).split(/\r?\n/)
      pending = lines.pop() ?? ''
      lines.forEach(onLine)
    })
    child.on('error', (e) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(new FfmpegError(`não foi possível iniciar o ffmpeg: ${e.message}`, '', -1))
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      onLine(pending)
      if (cancelled) return reject(new CancelledError())
      if (code !== 0) return reject(new FfmpegError(`ffmpeg (${label}) saiu com código ${code}`, tail.join('\n'), code ?? -1))
      resolve(kept.join('\n'))
    })
  })
}

export interface SpeechOpts extends AnalysisOpts {
  thresholdDb?: number
  minSilenceUs?: number
}

/** Silêncios brutos (silencedetect, limiar fixo -35 dB / 0,35 s) gravados em JSON (.part → rename); os intervalos de fala saem de speechFromFile. */
export async function buildSpeech(input: string, outJson: string, durationUs: number, opts: SpeechOpts = {}): Promise<SpeechFile> {
  const thresholdDb = opts.thresholdDb ?? SPEECH_DEFAULTS.thresholdDb
  const minSilenceUs = opts.minSilenceUs ?? SPEECH_DEFAULTS.minSilenceUs
  const filter = `silencedetect=n=${thresholdDb}dB:d=${minSilenceUs / 1_000_000}`
  const text = await runAnalysisFilter(input, opts.map ?? '0:a:0', filter, /silence_(start|end)/, durationUs, opts, 'speech')
  const result: SpeechFile = { version: 1, thresholdDb, minSilenceUs, silences: parseSilencedetect(text), durationUs }
  const tmp = partPath(outJson)
  try {
    writeFileSync(tmp, JSON.stringify(result))
    renameSync(tmp, outJson)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
  return result
}

/** Loudness integrado (LUFS), true peak (dBFS) e LRA (LU) pelo ebur128 do ffmpeg. */
export async function buildLoudness(input: string, durationUs: number, opts: AnalysisOpts = {}): Promise<Loudness> {
  // framelog=quiet: sem a linha por 100 ms; o resumo final continua saindo
  const text = await runAnalysisFilter(input, opts.map ?? '0:a:0', 'ebur128=peak=true:framelog=quiet', /Summary:|^\s*(I|LRA|Peak):\s/, durationUs, opts, 'loudness')
  const r = parseEbur128(text)
  if (!r) throw new FfmpegError('ffmpeg (loudness) não devolveu o resumo do ebur128', text.split('\n').slice(-5).join('\n'), 0)
  return r
}
