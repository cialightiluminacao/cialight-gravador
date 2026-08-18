// Definições dos presets de exportação (spec §7.2, tabela de presets).
// Fonte única de verdade para UI (títulos), buildFfmpegArgs (parâmetros) e estimativas.

import type { ExportPresetId } from '../types'

export interface PresetDef {
  id: ExportPresetId
  title: string
  subtitle: string
  /** 'mp4' = um único arquivo; 'multi' = vários arquivos (preset separado). */
  container: 'mp4' | 'multi'
  /** Perfil H.264 (null quando o vídeo é copiado sem re-encode). */
  videoProfile: 'main' | 'high' | null
  /** Altura máxima de saída (null = nativa). */
  maxHeight: number | null
  /** FPS máximo de saída (null = nativo). */
  maxFps: number | null
  /** CRF do libx264 (null quando não há re-encode). */
  crf: number | null
  /** Qualidade constante equivalente nos encoders de hardware (-cq / -global_quality). */
  hwCq: number | null
  /** Bitrate de áudio em kbps (AAC); no preset separado é o PCM 16 bits 48 kHz estéreo. */
  audioKbps: number
  /** B-frames (-bf). WhatsApp exige 0. */
  bFrames: number
  /** Intervalo entre keyframes em segundos (gop = gopSeconds × fps de saída). */
  gopSeconds: number
  supportsTargetSize: boolean
  supportsReels: boolean
  /** Vídeo copiado (-c:v copy) em vez de re-encodificado. */
  copyVideo: boolean
}

/** kbps do PCM s16le 48 kHz estéreo (16 × 48000 × 2 / 1000). */
export const PCM_S16LE_48K_STEREO_KBPS = 1536

export const PRESETS: Record<ExportPresetId, PresetDef> = {
  small: {
    id: 'small',
    title: 'WhatsApp / e-mail',
    subtitle: 'pequeno',
    container: 'mp4',
    videoProfile: 'main',
    maxHeight: 720,
    maxFps: 30,
    crf: 28,
    hwCq: 30,
    audioKbps: 96,
    bFrames: 0,
    gopSeconds: 2,
    supportsTargetSize: true,
    supportsReels: false,
    copyVideo: false
  },
  high: {
    id: 'high',
    title: 'YouTube / Drive / Instagram',
    subtitle: 'alta',
    container: 'mp4',
    videoProfile: 'high',
    maxHeight: null,
    maxFps: null,
    crf: 20,
    hwCq: 23,
    audioKbps: 192,
    bFrames: 2,
    gopSeconds: 0.5,
    supportsTargetSize: false,
    supportsReels: true,
    copyVideo: false
  },
  max: {
    id: 'max',
    title: 'Tutorial interno',
    subtitle: 'máxima',
    container: 'mp4',
    videoProfile: 'high',
    maxHeight: null,
    maxFps: null,
    crf: 17,
    hwCq: 19,
    audioKbps: 256,
    bFrames: 2,
    gopSeconds: 2,
    supportsTargetSize: false,
    supportsReels: false,
    copyVideo: false
  },
  separate: {
    id: 'separate',
    title: 'Edição posterior',
    subtitle: 'separado',
    container: 'multi',
    videoProfile: null,
    maxHeight: null,
    maxFps: null,
    crf: null,
    hwCq: null,
    audioKbps: PCM_S16LE_48K_STEREO_KBPS,
    bFrames: 0,
    gopSeconds: 0,
    supportsTargetSize: false,
    supportsReels: false,
    copyVideo: true
  },
  cutOnly: {
    id: 'cutOnly',
    title: 'Só cortar',
    subtitle: 'rápido',
    container: 'mp4',
    videoProfile: null,
    maxHeight: null,
    maxFps: null,
    crf: null,
    hwCq: null,
    audioKbps: 192,
    bFrames: 0,
    gopSeconds: 0,
    supportsTargetSize: false,
    supportsReels: false,
    copyVideo: true
  }
}

/** Ordem de exibição na UI de revisão. */
export const PRESET_ORDER: ExportPresetId[] = ['small', 'high', 'max', 'separate', 'cutOnly']
