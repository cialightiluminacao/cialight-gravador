import type { PipeSpec } from '@shared/ipc'

// Saídas por pipe da exportação do editor (GIF, só áudio): o pedido do renderer (PipeSpec) é validado aqui e
// vira argumentos do ffmpeg — o renderer nunca passa argumentos crus. Puro: testado em node.
//  GIF: passada 1 = RGBA cru do stdin → FFV1 sem perdas (temporário); 2 = palettegen (stats_mode=diff) →
//  paleta PNG temporária; 3 = paletteuse (sierra2_4a, diff_mode=rectangle) → .gif.part em loop infinito.
//  Tudo em RGB: nenhuma conversão YUV (sem matriz de cor no caminho; os pixels são os do compositor).
//  Áudio: PCM f32le estéreo 48 kHz do stdin → WAV (PCM 16 bits), MP3 (LAME) ou M4A (AAC + faststart).
//  x264 (fallback da exportação de vídeo, quando nem o H.264 do WebCodecs em software funciona): quadros RGBA do
//  stdin + PCM f32le temporário → H.264 High yuv420p convertido e marcado em BT.709 faixa limitada (a mesma cor
//  que a exportação do WebCodecs grava — paridade de pixels), AAC, faststart, direto no .mp4.part.

export const GIF_MAX_FPS = 30
export const PIPE_MAX_DIM = 4096
export const AUDIO_DEFAULT_KBPS = 192
export const AUDIO_MIN_KBPS = 64
export const AUDIO_MAX_KBPS = 320
/** x264: limites do pedido (fps do projeto; bitrate de vídeo em bps; GOP em quadros; AAC em kbps). */
export const X264_MAX_FPS = 240
export const X264_MIN_BPS = 100_000
export const X264_MAX_BPS = 200_000_000
export const X264_MAX_GOP = 1000
export const X264_AAC_MIN_KBPS = 32
export const X264_AAC_MAX_KBPS = 512
/** Amostras de áudio (por canal) no máximo: 24 h a 48 kHz. */
export const X264_MAX_SAMPLES = 48_000 * 86_400

const INVALID = 'Formato de exportação inválido'

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const evenDim = (v: unknown): v is number => isInt(v) && v >= 2 && v <= PIPE_MAX_DIM && v % 2 === 0

/** Valida o pedido vindo do renderer e devolve uma cópia só com os campos conhecidos (lança se inválido). */
export function validatePipeSpec(spec: unknown): PipeSpec {
  const s = (spec ?? {}) as Record<string, unknown>
  if (typeof spec !== 'object' || spec === null) throw new Error(INVALID)
  if (s.kind === 'gif') {
    if (!evenDim(s.width) || !evenDim(s.height) || !isInt(s.fps) || s.fps < 1 || s.fps > GIF_MAX_FPS || s.loop !== true) throw new Error(INVALID)
    return { kind: 'gif', width: s.width, height: s.height, fps: s.fps, loop: true }
  }
  if (s.kind === 'audio') {
    if ((s.format !== 'wav' && s.format !== 'mp3' && s.format !== 'm4a') || s.sampleRate !== 48000 || s.channels !== 2) throw new Error(INVALID)
    if (s.format === 'wav') return { kind: 'audio', format: 'wav', sampleRate: 48000, channels: 2 }
    const kbps = s.kbps ?? AUDIO_DEFAULT_KBPS
    if (!isInt(kbps) || kbps < AUDIO_MIN_KBPS || kbps > AUDIO_MAX_KBPS) throw new Error(INVALID)
    return { kind: 'audio', format: s.format, sampleRate: 48000, channels: 2, kbps }
  }
  if (s.kind === 'x264') {
    const okFps = typeof s.fps === 'number' && Number.isFinite(s.fps) && s.fps > 0 && s.fps <= X264_MAX_FPS
    const okBps = isInt(s.videoBitrate) && s.videoBitrate >= X264_MIN_BPS && s.videoBitrate <= X264_MAX_BPS
    const okGop = isInt(s.keyFrameInterval) && s.keyFrameInterval >= 1 && s.keyFrameInterval <= X264_MAX_GOP
    if (!evenDim(s.width) || !evenDim(s.height) || !okFps || !okBps || !okGop || s.audio === undefined) throw new Error(INVALID)
    let audio: { kbps: number; samples: number } | null = null
    if (s.audio !== null) {
      const a = (typeof s.audio === 'object' ? s.audio : {}) as Record<string, unknown>
      if (!isInt(a.kbps) || a.kbps < X264_AAC_MIN_KBPS || a.kbps > X264_AAC_MAX_KBPS || !isInt(a.samples) || a.samples < 1 || a.samples > X264_MAX_SAMPLES) throw new Error(INVALID)
      audio = { kbps: a.kbps, samples: a.samples }
    }
    return { kind: 'x264', width: s.width, height: s.height, fps: s.fps as number, videoBitrate: s.videoBitrate as number, keyFrameInterval: s.keyFrameInterval as number, audio }
  }
  throw new Error(INVALID)
}

/** Extensão do arquivo final. */
export function pipeExtension(spec: PipeSpec): 'gif' | 'wav' | 'mp3' | 'm4a' | 'mp4' {
  return spec.kind === 'gif' ? 'gif' : spec.kind === 'x264' ? 'mp4' : spec.format
}

/**
 * fps como fração para o ffmpeg: inteiro → N/1; família NTSC (N·1000/1001, ex.: 29,97) → N000/1001; o resto com
 * 3 casas decimais, reduzido (12,5 → 25/2).
 */
export function fpsRational(fps: number): string {
  const n = Math.round(fps)
  if (Math.abs(fps - n) < 1e-6) return `${n}/1`
  const ntsc = Math.round(fps * 1.001)
  if (Math.abs(fps - (ntsc * 1000) / 1001) < 0.005) return `${ntsc * 1000}/1001`
  let num = Math.round(fps * 1000)
  let den = 1000
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
  const g = gcd(num, den)
  num /= g
  den /= g
  return `${num}/${den}`
}

const PROGRESS = ['-progress', 'pipe:1', '-nostats']

/** GIF, passada 1: quadros RGBA do stdin → FFV1 (bgr0, sem perdas) em `lossless`. */
export function gifCapturePipeArgs(spec: Extract<PipeSpec, { kind: 'gif' }>, lossless: string): string[] {
  return [
    '-hide_banner', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${spec.width}x${spec.height}`, '-framerate', String(spec.fps), '-i', 'pipe:0',
    '-an', '-c:v', 'ffv1', '-pix_fmt', 'bgr0', '-f', 'matroska', ...PROGRESS, lossless
  ]
}

/** GIF, passada 2: paleta de 256 cores (estatística só do que muda entre quadros) em `palette` (PNG). */
export function gifPaletteArgs(lossless: string, palette: string): string[] {
  return ['-hide_banner', '-nostdin', '-y', '-i', lossless, '-vf', 'palettegen=stats_mode=diff', '-frames:v', '1', '-update', '1', '-c:v', 'png', '-f', 'image2', ...PROGRESS, palette]
}

/** GIF, passada 3: aplica a paleta (difusão sierra2_4a, só o retângulo que muda) → GIF em loop infinito. */
export function gifPaletteUseArgs(lossless: string, palette: string, out: string): string[] {
  return ['-hide_banner', '-nostdin', '-y', '-i', lossless, '-i', palette, '-lavfi', '[0:v][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle', '-loop', '0', '-f', 'gif', ...PROGRESS, out]
}

/** Só áudio: PCM f32le estéreo 48 kHz do stdin → `out`. */
export function audioPipeArgs(spec: Extract<PipeSpec, { kind: 'audio' }>, out: string): string[] {
  const input = ['-hide_banner', '-y', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0', '-vn']
  const kbps = `${spec.kbps ?? AUDIO_DEFAULT_KBPS}k`
  const codec =
    spec.format === 'wav'
      ? ['-c:a', 'pcm_s16le', '-f', 'wav']
      : spec.format === 'mp3'
        ? ['-c:a', 'libmp3lame', '-b:a', kbps, '-f', 'mp3']
        : ['-c:a', 'aac', '-b:a', kbps, '-movflags', '+faststart', '-f', 'ipod']
  return [...input, ...codec, ...PROGRESS, out]
}

/**
 * Conversão RGBA → YUV em BT.709 faixa limitada (a da exportação do WebCodecs) + marcação nos quadros: o ffmpeg 8
 * tira a cor do encoder dos quadros que saem do filtro, e sem o setparams primárias/transferência saem "unknown"
 * (as opções -color_* sozinhas não bastam).
 */
const X264_VF = 'scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv'

/**
 * Fallback libx264: quadros RGBA do stdin (+ PCM f32le estéreo 48 kHz de `audioFile`) → MP4 H.264 High yuv420p
 * em BT.709 faixa limitada (convertido pelo scale e marcado no fluxo), bitrate médio com teto 1,5× e buffer 2×,
 * GOP em quadros, AAC e faststart, direto em `out`.
 */
export function x264PipeArgs(spec: Extract<PipeSpec, { kind: 'x264' }>, out: string, audioFile: string | null): string[] {
  const audio = spec.audio && audioFile ? spec.audio : null
  const bps = spec.videoBitrate
  return [
    '-hide_banner', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${spec.width}x${spec.height}`, '-framerate', fpsRational(spec.fps), '-i', 'pipe:0',
    ...(audio ? ['-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', audioFile!] : []),
    '-map', '0:v', ...(audio ? ['-map', '1:a?'] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-vf', X264_VF,
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-b:v', String(bps), '-maxrate', String(Math.round(bps * 1.5)), '-bufsize', String(bps * 2), '-g', String(spec.keyFrameInterval),
    ...(audio ? ['-c:a', 'aac', '-b:a', `${audio.kbps}k`] : ['-an']),
    '-movflags', '+faststart', '-f', 'mp4', ...PROGRESS, out
  ]
}
