import { FPS60_BITRATE_FACTOR, QUALITY_PRESETS } from '@shared/defaults'
import type { Fps, Quality } from '@shared/types'

// Escolha de resolução/nível H.264 e checagem de suporte (WebCodecs) antes de gravar.
// Spike (18/08/2026): 'avc1.640028' (nível 4.0) é rejeitado para 1440p — o nível
// precisa acompanhar a resolução/fps.

export interface VideoConfigChoice {
  width: number
  height: number
  fps: number
  bitrate: number
  fullCodecString: string
  hardware: boolean
  downgraded: boolean
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

/** Nível H.264 High mínimo para (w×h @ fps). */
export function h264LevelFor(width: number, height: number, fps: number): string {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16)
  const mbps = mbs * fps
  // tabela (frame size em macroblocos, MB/s): 3.1: 3600/108000; 3.2: 5120/216000; 4.0/4.1: 8192/245760;
  // 4.2: 8704/522240; 5.0: 22080/589824; 5.1: 36864/983040; 5.2: 36864/2073600; 6.0: 139264/4177920
  const levels: [string, number, number][] = [
    ['1F', 3600, 108000],
    ['20', 5120, 216000],
    ['28', 8192, 245760],
    ['2A', 8704, 522240],
    ['32', 22080, 589824],
    ['33', 36864, 983040],
    ['34', 36864, 2073600],
    ['3C', 139264, 4177920]
  ]
  for (const [hex, maxMbs, maxMbps] of levels) if (mbs <= maxMbs && mbps <= maxMbps) return `avc1.6400${hex}`
  return 'avc1.64003C'
}

/** (w×h @ fps) cabe no H.264 nível 5.2 (36 864 macroblocos por quadro, 2 073 600 por segundo)? */
export function h264FitsLevel52(width: number, height: number, fps: number): boolean {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16)
  return mbs <= 36864 && mbs * fps <= 2073600
}

/**
 * Codec string HEVC Main (tier Main, progressivo) com o nível mínimo para (w×h @ fps), a partir do 3.0.
 * Prefixo `hvc1` (parâmetros no hvcC, o que o QuickTime/Apple exige). Tabela (MaxLumaPs, MaxLumaSr):
 * 3: 552 960/16 588 800; 3.1: 983 040/33 177 600; 4: 2 228 224/66 846 720; 4.1: …/133 693 440;
 * 5: 8 912 896/267 386 880; 5.1: …/534 773 760; 5.2: …/1 069 547 520; 6: 35 651 584/1 069 547 520; 6.1/6.2.
 */
export function hevcCodecString(width: number, height: number, fps: number): string {
  const ps = width * height
  const sr = ps * fps
  const levels: [number, number, number][] = [
    [90, 552960, 16588800],
    [93, 983040, 33177600],
    [120, 2228224, 66846720],
    [123, 2228224, 133693440],
    [150, 8912896, 267386880],
    [153, 8912896, 534773760],
    [156, 8912896, 1069547520],
    [180, 35651584, 1069547520],
    [183, 35651584, 2139095040],
    [186, 35651584, 4278190080]
  ]
  const level = levels.find(([, maxPs, maxSr]) => ps <= maxPs && sr <= maxSr)?.[0] ?? 186
  return `hvc1.1.6.L${level}.B0`
}

/** Dimensões alvo mantendo a proporção da fonte e limitando pela qualidade escolhida. */
export function targetDimensions(quality: Quality, srcW: number, srcH: number): { width: number; height: number } {
  const p = QUALITY_PRESETS[quality]
  if (!p.height || srcH <= p.height) return { width: even(srcW), height: even(srcH) }
  const scale = p.height / srcH
  return { width: even(srcW * scale), height: even(p.height) }
}

export function bitrateFor(quality: Quality, fps: Fps): number {
  const base = QUALITY_PRESETS[quality].bitrate
  return Math.round(fps === 60 ? base * FPS60_BITRATE_FACTOR : base)
}

async function supported(cfg: VideoEncoderConfig): Promise<boolean> {
  try {
    return (await VideoEncoder.isConfigSupported(cfg)).supported === true
  } catch {
    return false
  }
}

export async function pickVideoConfig(quality: Quality, fps: Fps, srcW: number, srcH: number): Promise<VideoConfigChoice> {
  const tryQuality = async (q: Quality, downgraded: boolean): Promise<VideoConfigChoice | null> => {
    const { width, height } = targetDimensions(q, srcW, srcH)
    const codec = h264LevelFor(width, height, fps)
    const base: VideoEncoderConfig = { codec, width, height, framerate: fps, bitrate: bitrateFor(q, fps), latencyMode: 'realtime', avc: { format: 'avc' } } as VideoEncoderConfig
    if (await supported({ ...base, hardwareAcceleration: 'prefer-hardware' })) return { width, height, fps, bitrate: base.bitrate!, fullCodecString: codec, hardware: true, downgraded }
    if (await supported({ ...base, hardwareAcceleration: 'no-preference' })) return { width, height, fps, bitrate: base.bitrate!, fullCodecString: codec, hardware: false, downgraded }
    return null
  }
  const first = await tryQuality(quality, false)
  if (first) return first
  // degrada: 1440p/native → 1080p → 720p
  const ladder: Quality[] = ['1080p', '720p']
  for (const q of ladder) {
    if (q === quality) continue
    const c = await tryQuality(q, true)
    if (c) return c
  }
  // último recurso: deixa o WebCodecs decidir (Baseline 720p)
  const { width, height } = targetDimensions('720p', srcW, srcH)
  return { width, height, fps: 30, bitrate: bitrateFor('720p', 30), fullCodecString: 'avc1.42E01F', hardware: false, downgraded: true }
}

export async function aacSupported(): Promise<boolean> {
  try {
    return (await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 })).supported === true
  } catch {
    return false
  }
}
