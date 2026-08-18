import { create } from 'zustand'
import type { AppInfo, HotkeyStatus, SourcesList, UpdateStatus } from '@shared/ipc'
import type { CaptureSource, PipKeyframe, RecorderPhase, RecordingConfig, Session, Settings } from '@shared/types'
import { DEFAULT_PIP, DEFAULT_SETTINGS } from '@shared/defaults'

// Estado global do renderer do gravador (zustand). O engine e o controller ficam
// fora do store (singletons em app/recordingController.ts); aqui só dados de UI.

export type Screen = 'prepare' | 'recording' | 'review' | 'settings' | 'history'

export interface DevicesState {
  cameras: MediaDeviceInfo[]
  mics: MediaDeviceInfo[]
  ready: boolean
}

export interface LiveState {
  elapsedMs: number
  bytes: number
  micMuted: boolean
  camOn: boolean
  annotating: boolean
  micLevel: number
  systemLevel: number
}

export interface AppState {
  screen: Screen
  returnScreen: Screen
  appInfo: AppInfo | null
  settings: Settings
  settingsLoaded: boolean
  sources: SourcesList | null
  sourcesLoading: boolean
  selectedSource: CaptureSource | null
  devices: DevicesState
  pipDraft: PipKeyframe
  phase: RecorderPhase
  live: LiveState
  warnings: string[]
  reviewSession: Session | null
  hotkeyStatus: HotkeyStatus[]
  updateStatus: UpdateStatus | null
  recoverable: Session[]

  setScreen: (s: Screen) => void
  goBack: () => void
  setAppInfo: (i: AppInfo) => void
  setSettings: (s: Settings) => void
  setSources: (s: SourcesList | null) => void
  setSourcesLoading: (b: boolean) => void
  setSelectedSource: (s: CaptureSource | null) => void
  setDevices: (d: DevicesState) => void
  setPipDraft: (p: PipKeyframe) => void
  setPhase: (p: RecorderPhase) => void
  setLive: (patch: Partial<LiveState>) => void
  pushWarning: (w: string) => void
  clearWarnings: () => void
  setReviewSession: (s: Session | null) => void
  setHotkeyStatus: (h: HotkeyStatus[]) => void
  setUpdateStatus: (u: UpdateStatus | null) => void
  setRecoverable: (s: Session[]) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  screen: 'prepare',
  returnScreen: 'prepare',
  appInfo: null,
  settings: DEFAULT_SETTINGS,
  settingsLoaded: false,
  sources: null,
  sourcesLoading: false,
  selectedSource: null,
  devices: { cameras: [], mics: [], ready: false },
  pipDraft: DEFAULT_PIP,
  phase: 'idle',
  live: { elapsedMs: 0, bytes: 0, micMuted: false, camOn: true, annotating: false, micLevel: 0, systemLevel: 0 },
  warnings: [],
  reviewSession: null,
  hotkeyStatus: [],
  updateStatus: null,
  recoverable: [],

  setScreen: (s) => set((st) => ({ screen: s, returnScreen: s === 'settings' || s === 'history' ? (st.screen === 'settings' || st.screen === 'history' ? st.returnScreen : st.screen) : st.returnScreen })),
  goBack: () => set((st) => ({ screen: st.returnScreen })),
  setAppInfo: (appInfo) => set({ appInfo }),
  setSettings: (settings) => set({ settings, settingsLoaded: true }),
  setSources: (sources) => set({ sources }),
  setSourcesLoading: (sourcesLoading) => set({ sourcesLoading }),
  setSelectedSource: (selectedSource) => set({ selectedSource }),
  setDevices: (devices) => set({ devices }),
  setPipDraft: (pipDraft) => set({ pipDraft }),
  setPhase: (phase) => set({ phase }),
  setLive: (patch) => set({ live: { ...get().live, ...patch } }),
  pushWarning: (w) => set((st) => ({ warnings: st.warnings.includes(w) ? st.warnings : [...st.warnings, w] })),
  clearWarnings: () => set({ warnings: [] }),
  setReviewSession: (reviewSession) => set({ reviewSession }),
  setHotkeyStatus: (hotkeyStatus) => set({ hotkeyStatus }),
  setUpdateStatus: (updateStatus) => set({ updateStatus }),
  setRecoverable: (recoverable) => set({ recoverable })
}))

/** Monta a RecordingConfig a partir do estado atual (fonte, settings, dispositivos). */
export function buildRecordingConfig(st: Pick<AppState, 'settings' | 'selectedSource' | 'devices' | 'pipDraft'>): RecordingConfig | null {
  const src = st.selectedSource
  if (!src) return null
  const s = st.settings
  const cam = s.devices.cameraOn ? (st.devices.cameras.find((c) => c.deviceId === s.devices.cameraId) ?? st.devices.cameras[0] ?? null) : null
  const mic = s.devices.micOn ? (st.devices.mics.find((m) => m.deviceId === s.devices.micId) ?? st.devices.mics[0] ?? null) : null
  return {
    source: { kind: src.kind, id: src.id, name: src.name, displayId: src.displayId },
    quality: s.quality,
    fps: s.fps,
    countdownSec: s.countdownSec,
    webcam: cam ? { deviceId: cam.deviceId, label: cam.label || 'Câmera', mirrored: s.pip.mirrored } : null,
    mic: mic
      ? {
          deviceId: mic.deviceId,
          label: mic.label || 'Microfone',
          echoCancellation: s.devices.micMode === 'speakers',
          noiseSuppression: true,
          autoGainControl: true
        }
      : null,
    systemAudio: s.devices.systemAudioOn,
    pipInitial: { ...st.pipDraft, tMs: 0, visible: !!cam }
  }
}
