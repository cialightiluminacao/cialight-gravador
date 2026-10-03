// Cadeia de codificadores da exportação de vídeo (pura). Cada falha do codificador ANTES do 1º pacote (ou o H.264
// do WebCodecs indisponível no tamanho) passa ao próximo passo:
//   HEVC (hardware) → H.264 hardware → H.264 software → libx264 por pipe (codificador de reserva) → erro.
// Falha depois do 1º pacote não entra aqui (mostra a causa real; o parcial é apagado).
import type { PipeSpec } from '@shared/ipc'
import type { HwPref } from '../engine/protocol'
import { audioBlocks } from './formatPlan'
import type { VideoCodecChoice } from './exportPresets'

export type EncodeStep = { kind: 'webcodecs'; codec: VideoCodecChoice; hw: HwPref } | { kind: 'x264' }

/** Codec string informado no resultado quando o vídeo sai pelo codificador de reserva. */
export const X264_VIDEO_CODEC = 'avc1 (libx264)'
/** Aviso da tela de concluído quando o vídeo sai pelo codificador de reserva. */
export const X264_FALLBACK_WARNING = 'Exportado com o codificador de reserva (mais lento)'

export function firstEncodeStep(codec: VideoCodecChoice): EncodeStep {
  return { kind: 'webcodecs', codec, hw: 'prefer-hardware' }
}

/** Próximo passo depois de uma falha do codificador antes do 1º pacote; null = não há mais para onde ir. */
export function nextEncodeStep(step: EncodeStep): EncodeStep | null {
  if (step.kind === 'x264') return null
  if (step.codec === 'hevc') return { kind: 'webcodecs', codec: 'h264', hw: 'prefer-hardware' }
  if (step.hw === 'prefer-hardware') return { kind: 'webcodecs', codec: 'h264', hw: 'prefer-software' }
  return { kind: 'x264' }
}

/** O passo precisa checar se o H.264 do WebCodecs existe no tamanho (canEncodeVideo) antes de tentar? */
export function needsAvcCheck(step: EncodeStep): boolean {
  return step.kind === 'webcodecs' && step.codec === 'h264' && step.hw === 'prefer-software'
}

/** Limites do pedido x264 que o main aceita (pipeSpec.ts). */
const X264_MIN_BPS = 100_000
const X264_MAX_BPS = 200_000_000
const AAC_MIN_KBPS = 32
const AAC_MAX_KBPS = 512

/**
 * Pedido do fallback libx264: quadros no tamanho/fps de saída, bitrate do pedido, GOP = intervalo de quadros-chave
 * em quadros e, com áudio, o total exato de amostras dos blocos do mixer (a mesma grade da exportação de vídeo).
 */
export function x264PipeSpec(
  req: { width: number; height: number; fps: number; fromUs: number; toUs: number; videoBitrate: number; audioBitrate: number; keyFrameIntervalS: number },
  hasAudio: boolean
): Extract<PipeSpec, { kind: 'x264' }> {
  const samples = hasAudio ? audioBlocks(req.fromUs, req.toUs).reduce((n, b) => n + b.frames, 0) : 0
  const kbps = Math.min(AAC_MAX_KBPS, Math.max(AAC_MIN_KBPS, Math.round(req.audioBitrate / 1000)))
  return {
    kind: 'x264',
    width: req.width,
    height: req.height,
    fps: req.fps,
    videoBitrate: Math.min(X264_MAX_BPS, Math.max(X264_MIN_BPS, Math.round(req.videoBitrate))),
    keyFrameInterval: Math.max(1, Math.round(req.keyFrameIntervalS * req.fps)),
    audio: samples > 0 ? { kbps, samples } : null
  }
}
