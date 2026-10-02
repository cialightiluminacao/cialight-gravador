// Cálculos puros dos formatos extras da exportação (GIF curto, quadro PNG, só áudio): tamanhos, limites,
// estimativas, blocos de áudio e nomes. Sem DOM: testado em node. Os pipelines ficam em formatExport.ts.
import { planAudio } from '@shared/editor/audioPlan'
import type { Project, Us } from '@shared/editor/project'
import { fileNameFromTitle } from '@shared/filenames'
import type { PipeSpec } from '@shared/ipc'
import { frameCount } from './exportPlan'

/** Formato escolhido no diálogo de exportação. */
export type ExportFormat = 'video' | 'gif' | 'png' | 'audio'
export type AudioFormat = 'wav' | 'mp3' | 'm4a'

const MiB = 1024 * 1024
const even = (v: number): number => Math.max(2, Math.round(v / 2) * 2)
const evenFloor = (v: number): number => Math.max(2, Math.floor(v / 2) * 2)
const mbLabel = (b: number): string => `${(b / MiB).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`

// ---------------------------------------------------------------- GIF

export const GIF_WIDTHS = [320, 480, 640] as const
export const GIF_FPS = [10, 12, 15] as const
export const GIF_DEFAULT_WIDTH = 480
export const GIF_DEFAULT_FPS = 12
/** GIF é para trechos curtos: acima disso, bloqueio. */
export const GIF_MAX_US = 30_000_000
/** Acima disso a estimativa vira aviso. */
export const GIF_WARN_BYTES = 15 * MiB
/** Heurística do tamanho (bytes por pixel por quadro). */
const GIF_BYTES_PER_PX = 0.08

type CanvasSize = Pick<Project['canvas'], 'width' | 'height'>

/** Larguras oferecidas: 320/480/640 até a largura do projeto (projeto mais estreito: só a dele). */
export function gifWidthOptions(canvas: CanvasSize): number[] {
  const max = evenFloor(canvas.width)
  const out = GIF_WIDTHS.filter((w) => w <= max)
  return out.length ? [...out] : [max]
}

/** Tamanho do GIF: largura (nunca acima da do projeto) e altura pela proporção do projeto, pares. */
export function gifSize(width: number, canvas: CanvasSize): { width: number; height: number } {
  const w = Math.min(evenFloor(width), evenFloor(canvas.width))
  return { width: w, height: even((w * canvas.height) / canvas.width) }
}

/** Estimativa aproximada (bytes) = w·h·fps·duração·0,08. */
export function gifEstimateBytes(w: number, h: number, fps: number, durationUs: Us): number {
  return Math.round(w * h * fps * (Math.max(0, durationUs) / 1e6) * GIF_BYTES_PER_PX)
}

/** Espaço em disco durante a exportação: o temporário sem perdas (limitado ao RGBA cru) + o GIF. */
export function gifDiskBytes(w: number, h: number, fps: number, fromUs: Us, toUs: Us): number {
  return frameCount(fromUs, toUs, fps) * w * h * 4 + gifEstimateBytes(w, h, fps, toUs - fromUs)
}

export function validateGif(w: number, h: number, fps: number, durationUs: Us): { blocker: string | null; warnings: string[] } {
  if (!(durationUs > 0)) return { blocker: 'A linha do tempo está vazia.', warnings: [] }
  if (durationUs > GIF_MAX_US) return { blocker: 'GIF limitado a 30 s — use I/O para escolher um trecho', warnings: [] }
  const est = gifEstimateBytes(w, h, fps, durationUs)
  const warnings = est > GIF_WARN_BYTES ? [`GIF grande: cerca de ${mbLabel(est)} (estimativa aproximada). Diminua a largura, o fps ou o trecho.`] : []
  return { blocker: null, warnings }
}

export function gifPipeSpec(width: number, height: number, fps: number): PipeSpec {
  return { kind: 'gif', width, height, fps, loop: true }
}

// ---------------------------------------------------------------- só áudio

export const AUDIO_SR = 48_000
/** Taxa do mp3/m4a. */
export const AUDIO_ONLY_KBPS = 192
/** Blocos de 100 ms, a mesma grade do áudio da exportação de vídeo (mixer determinístico ⇒ mesmo PCM). */
export const AUDIO_BLOCK_FRAMES = AUDIO_SR / 10
export const AUDIO_BLOCK_US = 100_000

export const AUDIO_FORMATS: readonly { id: AudioFormat; label: string; hint: string }[] = [
  { id: 'wav', label: 'WAV', hint: 'PCM 16 bits · 48 kHz · sem perdas' },
  { id: 'mp3', label: 'MP3', hint: `${AUDIO_ONLY_KBPS} kbps` },
  { id: 'm4a', label: 'M4A (AAC)', hint: `AAC ${AUDIO_ONLY_KBPS} kbps` }
]

/** Quadros de áudio (48 kHz) do trecho: round(duração·48 kHz), exato. */
export function audioFrameCount(fromUs: Us, toUs: Us): number {
  return Math.max(0, Math.round(((toUs - fromUs) * AUDIO_SR) / 1e6))
}

/** Blocos [fromUs, frames] a pedir ao mixer, em ordem a partir do início do trecho; o último é encurtado. */
export function audioBlocks(fromUs: Us, toUs: Us): { fromUs: Us; frames: number }[] {
  const total = audioFrameCount(fromUs, toUs)
  const out: { fromUs: Us; frames: number }[] = []
  for (let k = 0; k * AUDIO_BLOCK_FRAMES < total; k++) out.push({ fromUs: fromUs + k * AUDIO_BLOCK_US, frames: Math.min(AUDIO_BLOCK_FRAMES, total - k * AUDIO_BLOCK_FRAMES) })
  return out
}

/** Tamanho estimado: WAV = 2 canais × 16 bits por quadro + cabeçalho; mp3/m4a pela taxa. */
export function audioEstimateBytes(format: AudioFormat, durationUs: Us): number {
  if (format === 'wav') return audioFrameCount(0, durationUs) * 4 + 44
  return Math.round(((AUDIO_ONLY_KBPS * 1000) / 8) * (Math.max(0, durationUs) / 1e6))
}

export function audioPipeSpec(format: AudioFormat): PipeSpec {
  return format === 'wav' ? { kind: 'audio', format, sampleRate: 48000, channels: 2 } : { kind: 'audio', format, sampleRate: 48000, channels: 2, kbps: AUDIO_ONLY_KBPS }
}

/** Projeto sem nada audível (sem áudio, tudo mudo/desativado): não há o que exportar. */
export function audioOnlyBlocker(p: Project): string | null {
  return planAudio(p).every((s) => s.mode === 'mute') ? 'Não há áudio para exportar' : null
}

// ---------------------------------------------------------------- quadro PNG

/** Nome padrão do quadro: "<projeto> - 00m12s.png" (com hora: "1h02m03s"). */
export function stillFileName(projectName: string, tUs: Us): string {
  const t = Math.max(0, Math.floor(tUs / 1e6))
  const h = Math.floor(t / 3600)
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0')
  const s = String(t % 60).padStart(2, '0')
  return `${fileNameFromTitle(projectName.trim()) || 'Vídeo'} - ${h ? `${h}h` : ''}${m}m${s}s.png`
}
