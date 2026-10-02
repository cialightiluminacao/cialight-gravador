import { existsSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import { DENOISE_MODEL, LOUDNORM_TARGET, type AudioProcessOpts } from '@shared/editor/audioProcess'
import { runFfmpeg } from '../export/ffmpegRunner'
import { CancelledError, partPath } from './analysis'

// Pré-processamento de voz no ffmpeg: redução de ruído (RNNoise, filtro arnndn com o modelo somnolent-hogwash) e
// normalização de loudness em duas passadas (loudnorm: mede → aplica com linear=true), alvo −16 LUFS / −1,5 dBTP.
// Com as duas, o ruído sai antes da normalização (a medida da 1ª passada já é do sinal limpo). A saída é um arquivo
// só de áudio (AAC 192k em .m4a, 48 kHz, os canais da fonte) com a MESMA linha do tempo da faixa original:
//  - aresample first_pts=0 começa em 0 (completa com silêncio se a faixa começa depois, corta o que vier antes);
//  - o arnndn atrasa o sinal em um quadro do RNNoise (480 amostras a 48 kHz, medido por correlação cruzada):
//    atrim corta essas amostras, asetpts volta os timestamps (em unidades do timebase: /SR/TB) e apad repõe o fim.
// O modelo é aberto pelo nome com o cwd do ffmpeg na pasta do modelo: caminho do Windows no filtergraph exigiria
// escapar ':' e '\'.

/** Atraso do arnndn (FRAME_SIZE do RNNoise a 48 kHz). */
export const DENOISE_DELAY_SAMPLES = 480
const SR = 48000

export interface LoudnormMeasure { i: number; tp: number; lra: number; thresh: number; offset: number }
/** dualMono: fonte mono — o mixer a toca nos dois canais, então mede-se como dois canais iguais (+3 LU). */
export interface LoudnormOpts { dualMono: boolean }

export function denoiseFilter(): string {
  const d = DENOISE_DELAY_SAMPLES
  return `arnndn=m=${DENOISE_MODEL.file},atrim=start_sample=${d},asetpts=PTS-${d}/SR/TB,apad=pad_len=${d}`
}

const head = (input: string, map: string): string[] => ['-hide_banner', '-nostdin', '-y', '-i', input, '-map', map, '-vn']
const base = `aresample=${SR}:first_pts=0`
const loudnormTarget = (o: LoudnormOpts): string => `loudnorm=I=${LOUDNORM_TARGET.i}:TP=${LOUDNORM_TARGET.tp}:LRA=${LOUDNORM_TARGET.lra}${o.dualMono ? ':dual_mono=true' : ''}`
const chain = (opts: AudioProcessOpts): string[] => [base, ...(opts.denoise ? [denoiseFilter()] : [])]
const encode = (output: string): string[] => ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output]

/** 2ª passada: valores medidos e linear=true (ganho constante quando o true peak permite; senão o loudnorm comprime). O loudnorm trabalha a 192 kHz: volta a 48 kHz. */
export function loudnormApplyFilter(m: LoudnormMeasure, o: LoudnormOpts): string {
  return `${loudnormTarget(o)}:measured_I=${m.i}:measured_TP=${m.tp}:measured_LRA=${m.lra}:measured_thresh=${m.thresh}:offset=${m.offset}:linear=true:print_format=summary,aresample=${SR}`
}

/** 1ª passada: a cadeia inteira (com o denoise, se houver) até o loudnorm em modo medida, saída nula. */
export function loudnormMeasureArgs(input: string, map: string, opts: AudioProcessOpts, o: LoudnormOpts): string[] {
  return [...head(input, map), '-af', [...chain(opts), `${loudnormTarget(o)}:print_format=json`].join(','), '-progress', 'pipe:1', '-nostats', '-f', 'null', '-']
}

/** Arquivo final: cadeia + loudnorm com a medida (null = trilha sem sinal mensurável: não normaliza). */
export function audioProcessArgs(input: string, map: string, output: string, opts: AudioProcessOpts, measured: LoudnormMeasure | null, o: LoudnormOpts): string[] {
  const filters = [...chain(opts), ...(opts.normalize && measured ? [loudnormApplyFilter(measured, o)] : [])]
  return [...head(input, map), '-af', filters.join(','), ...encode(output)]
}

/** Só a redução de ruído. */
export const denoiseArgs = (input: string, map: string, output: string): string[] => audioProcessArgs(input, map, output, { denoise: true, normalize: false }, null, { dualMono: false })

/** JSON do loudnorm (print_format=json) no stderr; null se ausente ou sem medida finita (silêncio → "-inf"). */
export function parseLoudnormJson(stderr: string): LoudnormMeasure | null {
  const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(stderr)
  if (!m) return null
  let j: Record<string, string>
  try {
    j = JSON.parse(m[0]) as Record<string, string>
  } catch {
    return null
  }
  const r = { i: Number(j.input_i), tp: Number(j.input_tp), lra: Number(j.input_lra), thresh: Number(j.input_thresh), offset: Number(j.target_offset) }
  return Object.values(r).every(Number.isFinite) ? r : null
}

export interface AudioProcessRun {
  /** Pasta com o modelo RNNoise (resources/models/rnnoise). */
  modelDir: string
  durationUs: number
  dualMono: boolean
  signal?: AbortSignal
  onProgress?: (percent: number) => void
}

/**
 * Gera `out` (gravando em .part e renomeando no fim). Normalizar = 2 passadas (medida 0–50 %, aplicação 50–100 %).
 * Cancelamento → CancelledError e nenhum arquivo (nem .part) fica.
 */
export async function processAudioFile(input: string, map: string, out: string, opts: AudioProcessOpts, run: AudioProcessRun): Promise<void> {
  if (opts.denoise && !existsSync(join(run.modelDir, DENOISE_MODEL.file))) {
    throw new Error(`modelo de redução de ruído ausente (${join(run.modelDir, DENOISE_MODEL.file)}); rode "npm run fetch:models"`)
  }
  const lo = { dualMono: run.dualMono }
  const span = (from: number, to: number) => (p: { outTimeUs: number }): void => {
    if (run.durationUs > 0) run.onProgress?.(Math.min(99, Math.round(from + ((to - from) * p.outTimeUs) / run.durationUs)))
  }
  let measured: LoudnormMeasure | null = null
  if (opts.normalize) measured = await loudnormTwoPassMeasure(input, map, opts, lo, run, span(0, 50))
  const tmp = partPath(out)
  try {
    const r = await runFfmpeg(audioProcessArgs(input, map, tmp, opts, measured, lo), { cwd: run.modelDir || undefined, signal: run.signal, label: 'processar áudio', onProgress: span(opts.normalize ? 50 : 0, 100) })
    if (r.cancelled) throw new CancelledError()
    renameSync(tmp, out)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/** 1ª passada do loudnorm (medida); a 2ª é a geração do arquivo em processAudioFile. */
async function loudnormTwoPassMeasure(input: string, map: string, opts: AudioProcessOpts, lo: LoudnormOpts, run: AudioProcessRun, onProgress: (p: { outTimeUs: number }) => void): Promise<LoudnormMeasure | null> {
  const r = await runFfmpeg(loudnormMeasureArgs(input, map, opts, lo), { cwd: run.modelDir || undefined, signal: run.signal, label: 'loudnorm (medida)', onProgress })
  if (r.cancelled) throw new CancelledError()
  return parseLoudnormJson(r.stderrTail)
}

/** Normalização em duas passadas (medida → aplicação) de `input` para `out`, sem redução de ruído. */
export const loudnormTwoPass = (input: string, map: string, out: string, run: AudioProcessRun): Promise<void> => processAudioFile(input, map, out, { denoise: false, normalize: true }, run)
