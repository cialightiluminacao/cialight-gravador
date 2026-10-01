import type { EncoderProbe, HotkeyAction, HwEncoder, PipKeyframe, Quality, Settings } from './types'

export const SETTINGS_VERSION = 1 as const

export const DEFAULT_HOTKEYS: Record<HotkeyAction, string | null> = {
  toggleRecord: 'CommandOrControl+Shift+F9',
  pauseResume: 'CommandOrControl+Shift+F10',
  cancel: 'CommandOrControl+Shift+F11',
  toggleBar: 'CommandOrControl+Shift+F12',
  restart: 'CommandOrControl+Shift+F8',
  annotate: 'CommandOrControl+Shift+F5',
  arrow: 'CommandOrControl+Shift+F6',
  clearAnnotations: 'CommandOrControl+Shift+F7',
  muteMic: 'CommandOrControl+Shift+F1',
  toggleCamera: 'CommandOrControl+Shift+F2'
}

export const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  toggleRecord: 'Iniciar / parar gravação',
  pauseResume: 'Pausar / retomar',
  cancel: 'Cancelar gravação',
  toggleBar: 'Mostrar / ocultar barra flutuante',
  restart: 'Reiniciar gravação',
  annotate: 'Anotar (caneta)',
  arrow: 'Anotar (seta)',
  clearAnnotations: 'Apagar todas as anotações',
  muteMic: 'Silenciar / ativar microfone',
  toggleCamera: 'Ligar / desligar câmera'
}

/** PiP padrão: canto inferior direito, círculo com 20 % da largura (h em fração da altura para 16:9). */
export const DEFAULT_PIP: PipKeyframe = { tMs: 0, x: 0.76, y: 0.62, w: 0.2, h: (0.2 * 16) / 9, shape: 'circle', visible: true }

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  devices: { cameraId: null, micId: null, cameraOn: true, micOn: true, systemAudioOn: true, micMode: 'headset' },
  quality: '1080p',
  fps: 30,
  countdownSec: 3,
  startSound: true,
  pip: { x: DEFAULT_PIP.x, y: DEFAULT_PIP.y, w: DEFAULT_PIP.w, h: DEFAULT_PIP.h, shape: 'circle', mirrored: true },
  hotkeys: { ...DEFAULT_HOTKEYS },
  outputDir: null,
  rawDir: null,
  protectWindows: true,
  clickHighlight: false,
  annotations: { color: '#ff3b30', width: 6, autoFadeSec: null },
  rawRetentionDays: 30,
  lastEncoderProbe: null,
  lastSource: null,
  barPositions: {}
}

export interface QualityPreset {
  /** null = usar dimensões da fonte. */
  width: number | null
  height: number | null
  /** bitrate base a 30 fps (bps). */
  bitrate: number
  label: string
}

export const QUALITY_PRESETS: Record<Quality, QualityPreset> = {
  '720p': { width: 1280, height: 720, bitrate: 6e6, label: '720p' },
  '1080p': { width: 1920, height: 1080, bitrate: 12e6, label: '1080p' },
  '1440p': { width: 2560, height: 1440, bitrate: 20e6, label: '1440p' },
  native: { width: null, height: null, bitrate: 12e6, label: 'Nativa' }
}

/** Fator de bitrate para 60 fps. */
export const FPS60_BITRATE_FACTOR = 1.66
export const WEBCAM_BITRATE = 5e6
export const AUDIO_BITRATE = 160e3
export const KEYFRAME_INTERVAL_SEC = 1
export const FRAGMENT_DURATION_SEC = 1

export const MIN_FREE_SPACE_MB = 2048
export const LOW_SPACE_WARN_MB = 1024
export const LOW_SPACE_STOP_MB = 300

export const ENCODER_LABELS: Record<HwEncoder, string> = {
  h264_nvenc: 'NVIDIA NVENC (hardware)',
  h264_qsv: 'Intel Quick Sync (hardware)',
  h264_amf: 'AMD AMF (hardware)',
  h264_mf: 'Media Foundation (hardware/Windows)',
  libx264: 'libx264 (software)'
}

export const DEFAULT_ENCODER_PROBE: EncoderProbe = { gpuKey: 'unknown', probedAt: '', available: ['libx264'], preferred: 'libx264' }
