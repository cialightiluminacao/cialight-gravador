import type { PipeSpec } from '@shared/ipc'

// Saídas por pipe da exportação do editor (GIF, só áudio): o pedido do renderer (PipeSpec) é validado aqui e
// vira argumentos do ffmpeg — o renderer nunca passa argumentos crus. Puro: testado em node.
//  GIF: passada 1 = RGBA cru do stdin → FFV1 sem perdas (temporário); 2 = palettegen (stats_mode=diff) →
//  paleta PNG temporária; 3 = paletteuse (sierra2_4a, diff_mode=rectangle) → .gif.part em loop infinito.
//  Tudo em RGB: nenhuma conversão YUV (sem matriz de cor no caminho; os pixels são os do compositor).
//  Áudio: PCM f32le estéreo 48 kHz do stdin → WAV (PCM 16 bits), MP3 (LAME) ou M4A (AAC + faststart).

export const GIF_MAX_FPS = 30
export const PIPE_MAX_DIM = 4096
export const AUDIO_DEFAULT_KBPS = 192
export const AUDIO_MIN_KBPS = 64
export const AUDIO_MAX_KBPS = 320

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
  throw new Error(INVALID)
}

/** Extensão do arquivo final. */
export function pipeExtension(spec: PipeSpec): 'gif' | 'wav' | 'mp3' | 'm4a' {
  return spec.kind === 'gif' ? 'gif' : spec.format
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
