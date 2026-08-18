// Tipos de domínio compartilhados entre main, preload e renderer.
// Coordenadas da PiP e dos traços são NORMALIZADAS (0–1) em relação ao frame da tela.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayInfo {
  id: string
  label: string
  bounds: Rect
  workArea: Rect
  scaleFactor: number
  isPrimary: boolean
  index: number
}

export type SourceKind = 'screen' | 'window'

export interface CaptureSource {
  id: string
  kind: SourceKind
  name: string
  displayId?: string
  thumbnailDataUrl?: string
  appIconDataUrl?: string
}

export type PipShape = 'circle' | 'rounded'

export interface PipKeyframe {
  tMs: number
  x: number
  y: number
  w: number
  h: number
  shape: PipShape
  visible: boolean
}

export type StrokeTool = 'pen' | 'line' | 'arrow'

export interface StrokePoint {
  x: number
  y: number
  tMs: number
}

export interface Stroke {
  id: string
  tMs: number
  tool: StrokeTool
  points: StrokePoint[]
  color: string
  width: number
  erasedAtMs?: number
}

export type Quality = '720p' | '1080p' | '1440p' | 'native'
export type Fps = 30 | 60
export type CountdownSec = 0 | 3 | 5

export type SessionState = 'recording' | 'stopped' | 'finalized' | 'aborted'

export interface SessionSource {
  kind: SourceKind
  id: string
  name: string
  displayId?: string
  bounds: Rect
  scaleFactor: number
}

export interface Session {
  version: 1
  id: string
  createdAt: string
  state: SessionState
  source: SessionSource
  video: { width: number; height: number; fps: number; codec: string; bitrate: number }
  webcam?: { deviceId: string; label: string; width: number; height: number; mirrored: boolean }
  mic?: { deviceId: string; label: string; echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean }
  systemAudio: boolean
  /** Índices das faixas dentro de rec.mp4 (v:N para vídeo, a:N para áudio). */
  tracks: { screen: 0; webcam?: 1; mic?: 0 | 1; system?: 0 | 1 }
  durationMs?: number
  /** Pausas em tempo real (ms desde o início da gravação). */
  pauses: { startMs: number; endMs: number }[]
  pip: PipKeyframe[]
  strokes: Stroke[]
  clearEvents: { tMs: number }[]
  markers: { tMs: number; label?: string }[]
  engine: 'webcodecs' | 'mediarecorder'
  files: {
    rec: string
    proxy?: string
    webcam?: string
    thumbs?: string
    waveform?: string
    /** Só no fallback MediaRecorder (arquivos por faixa). */
    fallback?: { screen: string; webcam?: string; mic?: string; system?: string }
  }
  bytes?: number
}

export interface SessionSummary {
  id: string
  createdAt: string
  state: SessionState
  durationMs: number | null
  bytes: number
  hasWebcam: boolean
  sourceName: string
  thumb: string | null
}

export type HotkeyAction =
  | 'toggleRecord'
  | 'pauseResume'
  | 'cancel'
  | 'toggleBar'
  | 'restart'
  | 'annotate'
  | 'arrow'
  | 'clearAnnotations'
  | 'muteMic'
  | 'toggleCamera'

export type MicMode = 'headset' | 'speakers'

export type HwEncoder = 'h264_nvenc' | 'h264_qsv' | 'h264_mf' | 'libx264'

export interface EncoderProbe {
  gpuKey: string
  probedAt: string
  available: HwEncoder[]
  preferred: HwEncoder
}

export interface PipSettings {
  x: number
  y: number
  w: number
  h: number
  shape: PipShape
  mirrored: boolean
}

export interface Settings {
  version: 1
  devices: {
    cameraId: string | null
    micId: string | null
    cameraOn: boolean
    micOn: boolean
    systemAudioOn: boolean
    micMode: MicMode
  }
  quality: Quality
  fps: Fps
  countdownSec: CountdownSec
  startSound: boolean
  pip: PipSettings
  hotkeys: Record<HotkeyAction, string | null>
  /** null = padrão (Vídeos\CiaLight Gravador). */
  outputDir: string | null
  /** null = padrão (Vídeos\CiaLight Gravador\Brutos). */
  rawDir: string | null
  protectWindows: boolean
  clickHighlight: boolean
  annotations: { color: string; width: number; autoFadeSec: number | null }
  rawRetentionDays: number | null
  lastEncoderProbe: EncoderProbe | null
  lastSource: { kind: SourceKind; id: string; name: string } | null
  barPositions: Record<string, { x: number; y: number }>
}

export type ExportPresetId = 'small' | 'high' | 'max' | 'separate' | 'cutOnly'
export type AudioMode = 'mix' | 'micOnly' | 'systemOnly' | 'separate'

export interface ExportOptions {
  presetId: ExportPresetId
  trimStartMs: number
  trimEndMs: number | null
  includeWebcam: boolean
  includeAnnotations: boolean
  audioMode: AudioMode
  micOffsetMs: number
  targetSizeMB: 64 | 20 | null
  reels: boolean
  outputDir: string
  fileName: string
  pipOverride: PipKeyframe[] | null
}

export interface RecordingConfig {
  source: { kind: SourceKind; id: string; name: string; displayId?: string }
  quality: Quality
  fps: Fps
  countdownSec: CountdownSec
  webcam: { deviceId: string; label: string; mirrored: boolean } | null
  mic: { deviceId: string; label: string; echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean } | null
  systemAudio: boolean
  pipInitial: PipKeyframe
}

export type RecorderPhase = 'idle' | 'countdown' | 'recording' | 'paused' | 'stopping' | 'review'

export type RecorderCommand =
  | 'toggleRecord'
  | 'pause'
  | 'resume'
  | 'pauseResume'
  | 'stop'
  | 'cancel'
  | 'restart'
  | 'toggleBar'
  | 'annotate'
  | 'arrow'
  | 'clearAnnotations'
  | 'muteMic'
  | 'toggleCamera'
  | 'cyclePip'
  | 'showRecorder'
