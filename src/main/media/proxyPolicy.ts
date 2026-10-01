import type { HwEncoder } from '@shared/types'
import type { MediaInfo } from './probe'

// Decide se um vídeo importado precisa de proxy (preview fluido) ou de intermediário
// (codec que o WebCodecs não decodifica) e monta os argumentos do ffmpeg para gerá-los.
// O autorotate padrão do ffmpeg aplica a rotação de exibição: proxy/intermediário saem "em pé".

export type ProxyReason = 'undecodable' | 'longGop' | 'highRes' | 'vfr'

const LONG_GOP_US = 2_000_000
const HIGH_RES_HEIGHT = 1440
const PROXY_SHORT_SIDE = 720
const STANDARD_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120]

export function needsProxy(info: MediaInfo, decodable: boolean): { proxy: boolean; intermediate: boolean; reasons: ProxyReason[] } {
  const v = info.video
  if (info.kind !== 'video' || !v) return { proxy: false, intermediate: false, reasons: [] }
  const reasons: ProxyReason[] = []
  if (!decodable) reasons.push('undecodable')
  if (v.gopUs > LONG_GOP_US) reasons.push('longGop')
  if (v.height > HIGH_RES_HEIGHT) reasons.push('highRes')
  if (info.vfr) reasons.push('vfr')
  // Não decodificável: o intermediário full-res (GOP 1 s, CFR) serve de preview e de fonte do export.
  if (!decodable) return { proxy: false, intermediate: true, reasons }
  return { proxy: reasons.length > 0, intermediate: false, reasons }
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
    case 'h264_mf':
      return ['-c:v', 'h264_mf', '-rate_control', 'quality', '-quality', speed === 'fast' ? '60' : '85', '-g', g, '-bf', '0', '-pix_fmt', 'nv12']
  }
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
    ...audioArgs(info, '192k'),
    ...tail(output)
  ]
}
