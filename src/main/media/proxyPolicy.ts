import type { HwEncoder } from '@shared/types'
import { colorTagArgs } from '@shared/editor/sourceColor'
import type { Asset } from '@shared/editor/project'
import type { MediaInfo } from './probe'

export { audioAnalysisComplete } from '@shared/editor/speech'

// Decide se um vídeo importado precisa de proxy (preview fluido) ou de intermediário
// (codec que o WebCodecs não decodifica) e monta os argumentos do ffmpeg para gerá-los.
// O autorotate padrão do ffmpeg aplica a rotação de exibição: proxy/intermediário saem "em pé".

export type ProxyReason = 'undecodable' | 'audioUndecodable' | 'longGop' | 'highRes' | 'vfr'

const LONG_GOP_US = 2_000_000
const HIGH_RES_HEIGHT = 1440
const PROXY_SHORT_SIDE = 720
const STANDARD_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120]

export interface ProxyDecision {
  proxy: boolean
  intermediate: boolean
  /** Intermediário só para o áudio (AAC): o vídeo, decodificável, é copiado (mídia só de áudio: .m4a). */
  audioOnly?: true
  reasons: ProxyReason[]
}

/**
 * `decodable`: faixa de vídeo; `audioDecodable`: faixa de áudio (FLAC, HE-AAC, AC-3… o WebCodecs pode não
 * decodificar — sem o intermediário a mídia tocaria e exportaria em silêncio).
 */
export function needsProxy(info: MediaInfo, decodable: boolean, audioDecodable = true): ProxyDecision {
  const audioBad = !audioDecodable && !!info.audio && info.kind !== 'image'
  if (info.kind === 'audio') return audioBad ? { proxy: false, intermediate: true, audioOnly: true, reasons: ['audioUndecodable'] } : { proxy: false, intermediate: false, reasons: [] }
  const v = info.video
  if (info.kind !== 'video' || !v) return { proxy: false, intermediate: false, reasons: [] }
  const reasons: ProxyReason[] = []
  if (!decodable) reasons.push('undecodable')
  if (v.gopUs > LONG_GOP_US) reasons.push('longGop')
  if (v.height > HIGH_RES_HEIGHT) reasons.push('highRes')
  if (info.vfr) reasons.push('vfr')
  if (audioBad) reasons.push('audioUndecodable')
  // Não decodificável: o intermediário full-res (GOP 1 s, CFR, áudio AAC) serve de preview e de fonte do export.
  if (!decodable) return { proxy: false, intermediate: true, reasons }
  const proxy = reasons.some((r) => r !== 'audioUndecodable')
  // Só o áudio não decodifica: intermediário com o vídeo copiado + AAC (o proxy, se pedido, já sai com AAC)
  if (audioBad) return { proxy, intermediate: true, audioOnly: true, reasons }
  return { proxy, intermediate: false, reasons }
}

/** Taxa de saída CFR: encaixa em uma taxa padrão próxima (±2 %), senão arredonda a 3 casas. */
function outputFps(fps: number): number {
  if (!(fps > 0)) return 30
  const near = STANDARD_RATES.find((r) => Math.abs(r - fps) / r <= 0.02)
  return near ?? Math.round(fps * 1000) / 1000
}

/** Bloco de vídeo por encoder: `quality` é CRF/CQ (menor = melhor), `gop` em quadros, sem B-frames. */
function videoCodecArgs(encoder: HwEncoder, quality: number, gop: number, speed: 'fast' | 'quality'): string[] {
  const g = String(gop)
  switch (encoder) {
    case 'libx264':
      return ['-c:v', 'libx264', '-preset', speed === 'fast' ? 'veryfast' : 'fast', '-crf', String(quality), '-g', g, '-keyint_min', g, '-sc_threshold', '0', '-bf', '0', '-pix_fmt', 'yuv420p']
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', speed === 'fast' ? 'p3' : 'p5', '-rc', 'vbr', '-cq', String(quality), '-b:v', '0', '-g', g, '-no-scenecut', '1', '-bf', '0', '-pix_fmt', 'yuv420p']
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', speed === 'fast' ? 'veryfast' : 'medium', '-global_quality', String(quality), '-g', g, '-bf', '0', '-pix_fmt', 'nv12']
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', speed === 'fast' ? 'speed' : 'quality', '-rc', 'cqp', '-qp_i', String(quality), '-qp_p', String(quality), '-g', g, '-bf', '0', '-pix_fmt', 'nv12']
    case 'h264_mf':
      return ['-c:v', 'h264_mf', '-rate_control', 'quality', '-quality', speed === 'fast' ? '60' : '85', '-g', g, '-bf', '0', '-pix_fmt', 'nv12']
  }
}

/** Bloco de vídeo do proxy e do intermediário a 30 fps (validação do probe de encoders: mesmos argumentos). */
export function ingestVideoCodecArgs(encoder: HwEncoder, kind: 'proxy' | 'intermediate'): string[] {
  return kind === 'proxy' ? videoCodecArgs(encoder, encoder === 'libx264' ? 23 : 25, 15, 'fast') : videoCodecArgs(encoder, encoder === 'h264_nvenc' ? 19 : 18, 30, 'quality')
}

function commonHead(input: string): string[] {
  return ['-hide_banner', '-nostdin', '-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?']
}

function audioArgs(info: MediaInfo, bitrate: string): string[] {
  return info.audio ? ['-c:a', 'aac', '-b:a', bitrate] : ['-an']
}

function tail(output: string): string[] {
  return ['-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output]
}

/** Lados de exibição (após rotação). */
function displaySize(info: MediaInfo): { w: number; h: number } {
  const v = info.video!
  return v.rotation === 90 || v.rotation === 270 ? { w: v.height, h: v.width } : { w: v.width, h: v.height }
}

/**
 * Proxy de preview: H.264 GOP 0,5 s sem B-frames, lado curto 720 (nunca amplia),
 * yuv420p, AAC 128k, CFR quando a fonte é VFR, faststart.
 */
export function proxyArgs(input: string, output: string, info: MediaInfo, encoder: HwEncoder): string[] {
  const v = info.video
  if (!v) throw new Error('proxy só para mídia com vídeo')
  const fps = outputFps(v.fps)
  const { w, h } = displaySize(info)
  const scale = w >= h ? `scale=-2:${Math.min(PROXY_SHORT_SIDE, h)}` : `scale=${Math.min(PROXY_SHORT_SIDE, w)}:-2`
  return [
    ...commonHead(input),
    '-vf', scale,
    ...(info.vfr ? ['-fps_mode', 'cfr', '-r', String(fps)] : []),
    ...videoCodecArgs(encoder, encoder === 'libx264' ? 23 : 25, Math.max(1, Math.round(fps / 2)), 'fast'),
    // o YUV passa sem conversão de matriz: a marcação diz como lê-lo (regra única, sourceColor.ts)
    ...colorTagArgs(info.color, v.width, v.height),
    ...audioArgs(info, '128k'),
    ...tail(output)
  ]
}

/** Intermediário para codec não decodificável: mesma resolução, -crf 18 (nvenc -cq 19), GOP 1 s, CFR. */
export function intermediateArgs(input: string, output: string, info: MediaInfo, encoder: HwEncoder): string[] {
  const v = info.video
  if (!v) throw new Error('intermediário só para mídia com vídeo')
  const fps = outputFps(v.fps)
  return [
    ...commonHead(input),
    ...(info.vfr ? ['-fps_mode', 'cfr', '-r', String(fps)] : []),
    ...videoCodecArgs(encoder, encoder === 'h264_nvenc' ? 19 : 18, Math.max(1, Math.round(fps)), 'quality'),
    ...colorTagArgs(info.color, v.width, v.height),
    ...audioArgs(info, '192k'),
    ...tail(output)
  ]
}

/**
 * Intermediário de áudio (AAC 192k, faststart): mídia só de áudio → `-vn` (capa ignorada, saída .m4a);
 * vídeo → vídeo copiado sem recodificar + áudio convertido (saída .mp4).
 */
export function audioIntermediateArgs(input: string, output: string, info: MediaInfo): string[] {
  const head = ['-hide_banner', '-nostdin', '-y', '-i', input]
  const audio = ['-c:a', 'aac', '-b:a', '192k']
  if (info.kind === 'audio') return [...head, '-map', '0:a:0', '-vn', ...audio, ...tail(output)]
  return [...head, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', ...audio, ...tail(output)]
}

/**
 * Derivados de um asset já prontos? Vídeo: filmstrip, peaks (se tem áudio) e proxy/intermediário
 * quando a política pede (VFR não fica no Asset, então não entra aqui). Áudio: peaks (e o intermediário
 * quando o WebCodecs não decodifica). Imagem: sempre.
 */
export function derivedComplete(a: Asset): boolean {
  if (a.kind === 'image') return true
  const audioDecodable = a.audio?.decodable !== false
  if (a.kind === 'audio') return !!a.peaks && (audioDecodable || !!a.intermediate)
  if (!a.filmstrip || (a.audio && !a.peaks)) return false
  if (!a.video) return true
  const { video } = a
  const d = needsProxy({ durationUs: a.durationUs, kind: 'video', video, audio: a.audio, vfr: false, formatName: '' }, video.decodable, audioDecodable)
  return (!d.intermediate || !!a.intermediate) && (!d.proxy || !!a.proxy)
}
