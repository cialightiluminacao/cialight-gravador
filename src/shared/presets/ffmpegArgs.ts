// Monta os argumentos do ffmpeg para cada preset de exportação (spec §7.2).
// Função pura: não toca em disco nem em processos — o exportJob (main) executa os passos em ordem.
//
// Estrutura de todo comando:
//   -hide_banner -nostdin -y [-ss S] [-to E] -i <vídeo> [[-ss S] [-to E] -i <áudio>]
//   [-filter_complex ...] -map ... <codec de vídeo> <codec de áudio | -an> [-movflags +faststart]
//   -progress pipe:1 -nostats <saída>
// (o passo 1 do 2-pass termina em `-f mp4 NUL` — descarta a saída no Windows.)

import type { AudioMode, HwEncoder } from '../types'
import type { PresetDef } from './presets'

export interface FfmpegStep {
  args: string[]
  /** 'encode' | 'pass1' | 'pass2' | 'tela' | 'webcam' | 'mic' | 'sistema' | 'combinado' */
  label: string
  outFile: string
  /** Prefixo dos arquivos de log do 2-pass (para o exportJob limpar ao final). */
  passLogPrefix?: string
}

export interface FfmpegPlan {
  steps: FfmpegStep[]
  /** Arquivos finais gerados (sem o NUL do passo 1). */
  outputs: string[]
}

export interface ArgsInput {
  preset: PresetDef
  encoder: HwEncoder
  /** composed.mp4 (com composição) ou rec.mp4 (sem). */
  inputVideo: string
  /** Sempre rec.mp4 (faixas de áudio originais). */
  inputAudio: string
  hasWebcamTrack: boolean
  /** Índice a:N da faixa do microfone em inputAudio (null = não gravada). */
  micTrackIdx: number | null
  /** Índice a:N da faixa do sistema em inputAudio (null = não gravada). */
  systemTrackIdx: number | null
  audioMode: AudioMode
  /** Deslocamento do microfone em ms (>0 atrasa o mic; <0 adianta). */
  micOffsetMs: number
  trimStartMs: number
  trimEndMs: number | null
  durationMs: number
  srcWidth: number
  srcHeight: number
  srcFps: number
  reels: boolean
  targetSizeMB: number | null
  outDir: string
  /** Nome base sem extensão (ex.: 'Gravação 2026-08-18 14-32'). */
  baseName: string
  /** Bitrate de vídeo do 2-pass (planForTarget().kbps). Só tem efeito em preset com supportsTargetSize e targetSizeMB. */
  twoPassKbps?: number | null
  /** Altura de saída do 2-pass (planForTarget().height). Opcional; se ausente vale preset.maxHeight. */
  targetHeight?: number | null
}

const HEAD = ['-hide_banner', '-nostdin', '-y']
const PROGRESS = ['-progress', 'pipe:1', '-nostats']
const FASTSTART = ['-movflags', '+faststart']
export const AMIX_FILTER = 'amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95'
export const REELS_FILTER = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2'
/** Nome (sem extensão) dos logs do 2-pass, gravados na pasta do vídeo de entrada (pasta de brutos). */
export const PASSLOG_NAME = 'ffmpeg2pass'

// ---------- utilitários de caminho (sem `path` do Node: este módulo também roda no renderer) ----------

function sepOf(p: string): string {
  return p.includes('\\') ? '\\' : '/'
}

function joinPath(dir: string, name: string): string {
  const sep = sepOf(dir)
  const trimmed = dir.replace(/[\\/]+$/, '')
  return `${trimmed}${sep}${name}`
}

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i < 0 ? '.' : p.slice(0, i)
}

function sec(ms: number): string {
  return (ms / 1000).toFixed(3)
}

// ---------- entradas e corte ----------

function trimArgs(i: ArgsInput): string[] {
  const out: string[] = []
  if (i.trimStartMs > 0) out.push('-ss', sec(i.trimStartMs))
  // ignora um fim inválido (<= início) — o exportJob já valida, mas a função se defende
  if (i.trimEndMs != null && i.trimEndMs > i.trimStartMs) out.push('-to', sec(i.trimEndMs))
  return out
}

interface Inputs {
  args: string[]
  /** Índice da entrada do vídeo (sempre 0). */
  video: 0
  /** Índice da entrada do áudio (0 quando é o mesmo arquivo, 1 quando separado). */
  audio: 0 | 1
}

/** `-ss/-to` antes de CADA `-i` (opções de entrada valem por entrada). */
function inputs(i: ArgsInput, opts: { video: boolean; audio: boolean } = { video: true, audio: true }): Inputs {
  const trim = trimArgs(i)
  const same = i.inputVideo === i.inputAudio
  const args: string[] = []
  if (opts.video) args.push(...trim, '-i', i.inputVideo)
  if (opts.audio && (!same || !opts.video)) args.push(...trim, '-i', i.inputAudio)
  const audio: 0 | 1 = opts.video && !same ? 1 : 0
  return { args, video: 0, audio }
}

// ---------- vídeo ----------

/** Campos que o bloco do codec de vídeo usa (o probe de encoders valida com eles). */
type CodecInput = Pick<ArgsInput, 'preset' | 'encoder' | 'srcFps'>

function outputFps(i: CodecInput): number {
  return i.preset.maxFps != null && i.srcFps > i.preset.maxFps ? i.preset.maxFps : i.srcFps
}

function gopFrames(i: CodecInput): number {
  return Math.max(1, Math.round(i.preset.gopSeconds * outputFps(i)))
}

function effectiveMaxHeight(i: ArgsInput, twoPass: boolean): number | null {
  const presetMax = i.preset.maxHeight
  if (twoPass && i.targetHeight != null) return presetMax != null ? Math.min(presetMax, i.targetHeight) : i.targetHeight
  return presetMax
}

/** Cadeia de filtros de vídeo: [scale,] [fps,] format=yuv420p — ou reels 9:16 no preset que suporta. */
function videoFilterChain(i: ArgsInput, twoPass: boolean): string {
  if (i.preset.supportsReels && i.reels) return `${REELS_FILTER},format=yuv420p`
  const parts: string[] = []
  const maxH = effectiveMaxHeight(i, twoPass)
  if (maxH != null && (i.srcHeight > maxH || i.srcWidth > Math.round((maxH * 16) / 9 / 2) * 2)) {
    // cabe em (16/9·maxH)×maxH sem ampliar (min(iw)/min(ih)), mantendo proporção e dimensões pares
    const maxW = Math.round((maxH * 16) / 9 / 2) * 2
    parts.push(`scale='min(${maxW},iw)':'min(${maxH},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`)
  }
  if (i.preset.maxFps != null && i.srcFps > i.preset.maxFps) parts.push(`fps=${i.preset.maxFps}`)
  parts.push('format=yuv420p')
  return parts.join(',')
}

function profile(i: CodecInput): string {
  return i.preset.videoProfile ?? 'high'
}

/** Bloco do codec de vídeo (CRF/CQ) por encoder. */
function videoCodecArgs(i: CodecInput): string[] {
  const p = i.preset
  const gop = String(gopFrames(i))
  const bf = String(p.bFrames)
  const prof = profile(i)
  switch (i.encoder) {
    case 'libx264': {
      const args = ['-c:v', 'libx264', '-profile:v', prof, '-preset', 'slow', '-crf', String(p.crf ?? 23)]
      if (p.id === 'small') args.push('-maxrate', '1500k', '-bufsize', '3000k')
      args.push('-bf', bf, '-g', gop, '-keyint_min', gop)
      if (p.id === 'high') args.push('-flags', '+cgop')
      return args
    }
    case 'h264_nvenc':
      return [
        '-c:v', 'h264_nvenc', '-preset', p.id === 'max' ? 'p7' : 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', String(p.hwCq ?? 23), '-b:v', '0',
        '-bf', bf, '-b_ref_mode', 'middle', '-spatial-aq', '1', '-temporal-aq', '1', '-profile:v', prof, '-g', gop
      ]
    case 'h264_qsv':
      return [
        '-c:v', 'h264_qsv', '-preset', 'slower', '-global_quality', String(p.hwCq ?? 23), '-look_ahead', '1', '-look_ahead_depth', '20',
        '-bf', bf, '-profile:v', prof, '-g', gop
      ]
    case 'h264_amf': {
      // AMD AMF: quantizador constante (equivalente ao CQ dos outros encoders de hardware)
      const q = String(p.hwCq ?? 23)
      return ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', q, '-qp_p', q, '-qp_b', q, '-bf', bf, '-profile:v', prof, '-g', gop]
    }
    case 'h264_mf':
      // o h264_mf não tem as constantes 'main'/'high' (o ffmpeg recusa e o encoder nem abre): perfil numérico
      return ['-c:v', 'h264_mf', '-rate_control', 'quality', '-quality', '70', '-profile:v', prof === 'main' ? '77' : '100', '-g', gop]
  }
}

/** Bloco do codec de vídeo exatamente como a exportação do preset usa (validação do probe de encoders). */
export function presetVideoCodecArgs(preset: PresetDef, encoder: HwEncoder, srcFps: number): string[] {
  return videoCodecArgs({ preset, encoder, srcFps })
}

/** Bloco libx264 com bitrate fixo para o 2-pass (sem -crf; maxrate 1,5× e bufsize 3×). */
function twoPassVideoCodecArgs(i: ArgsInput, kbps: number): string[] {
  const gop = String(gopFrames(i))
  return [
    '-c:v', 'libx264', '-profile:v', profile(i), '-preset', 'slow',
    '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${Math.round(kbps * 3)}k`,
    '-bf', String(i.preset.bFrames), '-g', gop, '-keyint_min', gop
  ]
}

// ---------- áudio ----------

interface AudioGraph {
  /** Trechos de filter_complex (vazio quando não há áudio). */
  filters: string[]
  /** true quando há um rótulo [a] para mapear. */
  hasAudio: boolean
}

function micOffsetFilter(offsetMs: number): string | null {
  if (offsetMs > 0) return `adelay=${Math.round(offsetMs)}:all=1`
  if (offsetMs < 0) return `atrim=start=${-offsetMs / 1000},asetpts=PTS-STARTPTS`
  return null
}

/**
 * Resolve o grafo de áudio a partir do modo e das faixas existentes:
 * - mix: mic+sistema → amix+alimiter; só uma → anull; nenhuma → sem áudio.
 * - micOnly / systemOnly: só a faixa (ausente → sem áudio).
 * - separate fora do preset separado: tratado como mix.
 * O offset do mic (adelay/atrim) é aplicado sempre que o mic entra no grafo.
 */
function audioGraph(i: ArgsInput, audioInput: 0 | 1): AudioGraph {
  const mode: AudioMode = i.audioMode === 'separate' ? 'mix' : i.audioMode
  const mic = i.micTrackIdx != null ? `[${audioInput}:a:${i.micTrackIdx}]` : null
  const sys = i.systemTrackIdx != null ? `[${audioInput}:a:${i.systemTrackIdx}]` : null
  const useMic = mode !== 'systemOnly' ? mic : null
  const useSys = mode !== 'micOnly' ? sys : null
  const off = micOffsetFilter(i.micOffsetMs)

  if (useMic && useSys) {
    const filters: string[] = []
    let micLabel = useMic
    if (off) {
      filters.push(`${useMic}${off}[mic]`)
      micLabel = '[mic]'
    }
    filters.push(`${micLabel}${useSys}${AMIX_FILTER}[a]`)
    return { filters, hasAudio: true }
  }
  if (useMic) return { filters: [`${useMic}${off ?? 'anull'}[a]`], hasAudio: true }
  if (useSys) return { filters: [`${useSys}anull[a]`], hasAudio: true }
  return { filters: [], hasAudio: false }
}

function audioCodecArgs(i: ArgsInput, hasAudio: boolean): string[] {
  if (!hasAudio) return ['-an']
  return ['-c:a', 'aac', '-b:a', `${i.preset.audioKbps}k`, '-ar', '48000', '-ac', '2']
}

// ---------- montagem por preset ----------

function singleFilePlan(i: ArgsInput): FfmpegPlan {
  const outFile = joinPath(i.outDir, `${i.baseName}.mp4`)
  const inp = inputs(i)
  const audio = audioGraph(i, inp.audio)

  if (i.preset.copyVideo) {
    // Só cortar: -ss antes do -i cai no keyframe anterior (≤ 1 s); vídeo copiado, áudio re-encodificado.
    const args = [...HEAD, ...inp.args]
    if (audio.hasAudio) args.push('-filter_complex', audio.filters.join(';'))
    args.push('-map', `${inp.video}:v:0`)
    if (audio.hasAudio) args.push('-map', '[a]')
    args.push('-c:v', 'copy', '-avoid_negative_ts', 'make_zero')
    args.push(...audioCodecArgs(i, audio.hasAudio), ...FASTSTART, ...PROGRESS, outFile)
    return { steps: [{ args, label: 'encode', outFile }], outputs: [outFile] }
  }

  const twoPass = i.preset.supportsTargetSize && i.targetSizeMB != null && i.twoPassKbps != null && i.twoPassKbps > 0
  const vf = `[${inp.video}:v:0]${videoFilterChain(i, twoPass)}[v]`
  const fullFilter = [vf, ...audio.filters].join(';')
  const maps = ['-map', '[v]', ...(audio.hasAudio ? ['-map', '[a]'] : [])]
  const audioArgs = audioCodecArgs(i, audio.hasAudio)

  if (twoPass) {
    const kbps = i.twoPassKbps as number
    const passLogPrefix = joinPath(dirname(i.inputVideo), PASSLOG_NAME)
    const codec = twoPassVideoCodecArgs(i, kbps)
    const pass1 = [
      ...HEAD, ...inp.args, '-filter_complex', vf, '-map', '[v]', ...codec,
      '-pass', '1', '-passlogfile', passLogPrefix, '-an', ...PROGRESS, '-f', 'mp4', 'NUL'
    ]
    const pass2 = [
      ...HEAD, ...inp.args, '-filter_complex', fullFilter, ...maps, ...codec,
      '-pass', '2', '-passlogfile', passLogPrefix, ...audioArgs, ...FASTSTART, ...PROGRESS, outFile
    ]
    return {
      steps: [
        { args: pass1, label: 'pass1', outFile: 'NUL', passLogPrefix },
        { args: pass2, label: 'pass2', outFile, passLogPrefix }
      ],
      outputs: [outFile]
    }
  }

  const args = [
    ...HEAD, ...inp.args, '-filter_complex', fullFilter, ...maps, ...videoCodecArgs(i), ...audioArgs, ...FASTSTART, ...PROGRESS, outFile
  ]
  return { steps: [{ args, label: 'encode', outFile }], outputs: [outFile] }
}

/** Preset "Edição posterior": faixas brutas copiadas (audioMode e micOffset não se aplicam). */
function separatePlan(i: ArgsInput): FfmpegPlan {
  const steps: FfmpegStep[] = []
  const out = (suffix: string, ext: string): string => joinPath(i.outDir, `${i.baseName} - ${suffix}.${ext}`)

  const videoIn = inputs(i, { video: true, audio: false })
  const audioIn = inputs(i, { video: false, audio: true })

  const tela = out('tela', 'mp4')
  steps.push({ args: [...HEAD, ...videoIn.args, '-map', '0:v:0', '-c', 'copy', ...FASTSTART, ...PROGRESS, tela], label: 'tela', outFile: tela })

  if (i.hasWebcamTrack) {
    const webcam = out('webcam', 'mp4')
    steps.push({ args: [...HEAD, ...videoIn.args, '-map', '0:v:1', '-c', 'copy', ...FASTSTART, ...PROGRESS, webcam], label: 'webcam', outFile: webcam })
  }
  if (i.micTrackIdx != null) {
    const mic = out('mic', 'wav')
    steps.push({ args: [...HEAD, ...audioIn.args, '-map', `0:a:${i.micTrackIdx}`, '-c:a', 'pcm_s16le', ...PROGRESS, mic], label: 'mic', outFile: mic })
  }
  if (i.systemTrackIdx != null) {
    const sistema = out('sistema', 'wav')
    steps.push({ args: [...HEAD, ...audioIn.args, '-map', `0:a:${i.systemTrackIdx}`, '-c:a', 'pcm_s16le', ...PROGRESS, sistema], label: 'sistema', outFile: sistema })
  }

  // combinado.mkv: v0 + faixas de áudio nomeadas (Microfone antes de Sistema).
  const both = inputs(i)
  const combinado = out('combinado', 'mkv')
  const args = [...HEAD, ...both.args, '-map', `${both.video}:v:0`]
  const titles: string[] = []
  if (i.micTrackIdx != null) {
    args.push('-map', `${both.audio}:a:${i.micTrackIdx}`)
    titles.push('Microfone')
  }
  if (i.systemTrackIdx != null) {
    args.push('-map', `${both.audio}:a:${i.systemTrackIdx}`)
    titles.push('Sistema')
  }
  args.push('-c', 'copy')
  if (titles.length > 0) args.push('-disposition:a:0', 'default')
  titles.forEach((t, n) => args.push(`-metadata:s:a:${n}`, `title=${t}`))
  args.push(...PROGRESS, combinado)
  steps.push({ args, label: 'combinado', outFile: combinado })

  return { steps, outputs: steps.map((s) => s.outFile) }
}

/** Monta o plano de execução do ffmpeg para o preset informado. */
export function buildFfmpegArgs(i: ArgsInput): FfmpegPlan {
  return i.preset.container === 'multi' ? separatePlan(i) : singleFilePlan(i)
}
