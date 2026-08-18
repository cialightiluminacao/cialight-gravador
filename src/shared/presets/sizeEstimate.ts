// Estimativas de tamanho: por preset (tela de revisão) e ao vivo (barra flutuante).
// Tudo em kbps (kbit/s) e MB = kbit × s / 8192.

import type { PresetDef } from './presets'

/**
 * Tabela de bitrates típicos de vídeo (kbps) para gravação de tela H.264 nos presets:
 *
 * | Preset  | Regra                                                                  |
 * |---------|------------------------------------------------------------------------|
 * | small   | 1400 (saída sempre ≤ 720p30, CRF 28 com maxrate 1500k)                  |
 * | high    | 720p 5000 · 1080p 9000 · 1440p+ 16000; a 60 fps × 4/3 (1080p60 = 12000)|
 * | max     | high × 1,6 (CRF 17)                                                     |
 * | cutOnly | bitrate medido da gravação (measuredKbps) ou 5000 quando desconhecido  |
 * | separate| idem cutOnly (vídeo copiado)                                            |
 */
export const SMALL_KBPS = 1400
export const HIGH_KBPS_BY_HEIGHT: { maxHeight: number; kbps: number }[] = [
  { maxHeight: 720, kbps: 5000 },
  { maxHeight: 1080, kbps: 9000 },
  { maxHeight: Number.POSITIVE_INFINITY, kbps: 16000 }
]
export const HIGH_FPS60_FACTOR = 4 / 3
export const MAX_OVER_HIGH_FACTOR = 1.6
export const COPY_FALLBACK_KBPS = 5000

function highKbps(srcHeight: number, srcFps: number): number {
  const row = HIGH_KBPS_BY_HEIGHT.find((r) => srcHeight <= r.maxHeight) ?? HIGH_KBPS_BY_HEIGHT[HIGH_KBPS_BY_HEIGHT.length - 1]
  return row.kbps * (srcFps > 30 ? HIGH_FPS60_FACTOR : 1)
}

/** Bitrate típico de vídeo (kbps) do preset para a fonte informada. */
export function typicalVideoKbps(preset: PresetDef, srcHeight: number, srcFps: number, measuredKbps?: number | null): number {
  switch (preset.id) {
    case 'small':
      return SMALL_KBPS
    case 'high':
      return highKbps(srcHeight, srcFps)
    case 'max':
      return highKbps(srcHeight, srcFps) * MAX_OVER_HIGH_FACTOR
    case 'separate':
    case 'cutOnly':
      return measuredKbps != null && measuredKbps > 0 ? measuredKbps : COPY_FALLBACK_KBPS
  }
}

/** Converte kbps × duração em MB. */
export function kbpsToMB(kbps: number, durationMs: number): number {
  if (!(durationMs > 0)) return 0
  return (kbps * (durationMs / 1000)) / 8192
}

/**
 * Estimativa do tamanho final (MB) para o preset.
 * separate: pior caso = vídeo em tela.mp4 + combinado.mkv (2×) e dois WAV PCM (mic + sistema).
 */
export function estimateOutputMB(
  preset: PresetDef,
  durationMs: number,
  srcHeight: number,
  srcFps: number,
  measuredKbps?: number | null
): number {
  const video = typicalVideoKbps(preset, srcHeight, srcFps, measuredKbps)
  const total = preset.id === 'separate' ? 2 * video + 2 * preset.audioKbps : video + preset.audioKbps
  return kbpsToMB(total, durationMs)
}

export interface LiveEstimate {
  /** MB já gravados. */
  mbSoFar: number
  /** Bitrate médio até agora (kbps). */
  kbps: number
  /** Projeção para `totalMs` (null quando não informado). */
  mbProjected: number | null
}

/** Estimativa ao vivo a partir dos bytes gravados e do tempo decorrido. */
export function estimateLiveMB(bytesWritten: number, elapsedMs: number, totalMs?: number): LiveEstimate {
  const mbSoFar = bytesWritten / 1048576
  const kbps = elapsedMs > 0 ? (bytesWritten * 8) / 1024 / (elapsedMs / 1000) : 0
  const mbProjected = totalMs != null && totalMs > 0 && elapsedMs > 0 ? kbpsToMB(kbps, totalMs) : null
  return { mbSoFar, kbps, mbProjected }
}
