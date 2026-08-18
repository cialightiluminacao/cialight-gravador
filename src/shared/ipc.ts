// Contrato IPC entre renderer (via preload) e main. O preload implementa `IpcApi`
// e o main registra os handlers com os mesmos nomes de canal (`IPC`).
import type {
  CaptureSource,
  DisplayInfo,
  EncoderProbe,
  ExportOptions,
  HotkeyAction,
  RecorderCommand,
  RecorderPhase,
  RecordingConfig,
  Session,
  SessionSummary,
  Settings,
  Stroke,
  StrokeTool
} from './types'

export type Unsubscribe = () => void

export interface SourcesList {
  displays: DisplayInfo[]
  screens: CaptureSource[]
  windows: CaptureSource[]
}

export interface BarState {
  phase: RecorderPhase
  elapsedMs: number
  bytes: number
  micMuted: boolean
  camOn: boolean
  hasCam: boolean
  hasMic: boolean
  annotating: boolean
}

export type ExportStage = 'prepare' | 'compose' | 'encode' | 'pass1' | 'pass2' | 'assets' | 'done' | 'error' | 'cancelled'

export interface ExportProgress {
  jobId: string
  stage: ExportStage
  /** 0–100 do job inteiro. */
  percent: number
  message?: string
  outputs?: string[]
  error?: string
}

export interface ExportRequest {
  sessionId: string
  options: ExportOptions
  /** Caminho absoluto de composed.mp4 gerado no renderer (ou null quando não há composição). */
  composedFile: string | null
}

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  notes?: string
  percent?: number
  bytesTotal?: number
  error?: string
  currentVersion: string
}

export interface HotkeyStatus {
  action: HotkeyAction
  accelerator: string | null
  registered: boolean
  problems: string[]
}

export type OverlayMode = 'hidden' | 'idle' | 'countdown' | 'drawing'

export interface OverlayModePayload {
  mode: OverlayMode
  count?: number
  tool?: StrokeTool
  color?: string
  width?: number
  paused?: boolean
  autoFadeSec?: number | null
  /** Retângulo (px do display) da janela gravada em modo janela; null = display inteiro. */
  targetRect?: { x: number; y: number; width: number; height: number } | null
  /** Modo janela: a borda não faz sentido (mostra só a pílula com o nome da janela). */
  sourceKind?: 'screen' | 'window'
  sourceName?: string
}

export interface OverlayStrokeEvent {
  displayId: string
  stroke: Stroke
  final: boolean
  /** performance.now() da overlay no evento — o recorder converte para tempo de mídia. */
  atPerfMs: number
}

export type OverlayAction = 'undo' | 'clear' | 'exit' | 'setTool' | 'setColor'

export interface OverlayActionEvent {
  action: OverlayAction
  tool?: StrokeTool
  color?: string
}

export interface ReviewAssets {
  proxy: string
  webcam: string | null
  thumbs: string[]
  waveform: string | null
  keyframesSec: number[]
  durationMs: number
}

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  isPackaged: boolean
  paths: { output: string; raw: string; logs: string; userData: string }
}

export interface RecordingPhaseContext {
  /** Displays onde overlays/barra devem aparecer (id do display gravado). */
  displayIds?: string[]
  /** Em modo janela: retângulo da janela alvo (px de tela). */
  targetRect?: { x: number; y: number; width: number; height: number } | null
  countdownSec?: number
  sourceKind?: 'screen' | 'window'
  sourceName?: string
}

export interface IpcApi {
  app: {
    info(): Promise<AppInfo>
    openExternal(url: string): Promise<void>
    showItemInFolder(path: string): Promise<void>
    openPath(path: string): Promise<void>
    copyText(text: string): Promise<void>
    copyFile(path: string): Promise<void>
    showRecorder(): Promise<void>
    minimize(): Promise<void>
    hideToTray(): Promise<void>
    quit(): Promise<void>
    windowKind(): 'recorder' | 'bar' | 'overlay' | 'spike'
    displayIdOfThisWindow(): Promise<string | null>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    pickFolder(current: string | null): Promise<string | null>
    onChange(cb: (s: Settings) => void): Unsubscribe
  }
  sources: {
    list(): Promise<SourcesList>
    thumbnail(id: string, width: number, height: number): Promise<string | null>
  }
  capture: {
    select(sourceId: string, systemAudio: boolean): Promise<void>
  }
  session: {
    create(config: RecordingConfig, sessionId: string): Promise<{ dir: string; session: Session }>
    writeOpen(sessionId: string, name: string): Promise<number>
    write(handle: number, data: Uint8Array, position: number): Promise<void>
    writeClose(handle: number): Promise<void>
    save(session: Session): Promise<void>
    get(id: string): Promise<Session | null>
    list(): Promise<SessionSummary[]>
    delete(id: string): Promise<void>
    openFolder(id: string): Promise<void>
    freeSpaceMB(): Promise<number>
    unfinished(): Promise<Session[]>
    /** URL servida pelo protocolo cialight-file:// (streaming com Range). */
    fileUrl(id: string, name: string): string
    filePath(id: string, name: string): Promise<string>
  }
  recording: {
    setPhase(phase: RecorderPhase, ctx?: RecordingPhaseContext): Promise<void>
    barUpdate(state: BarState): void
    /** Barra/bandeja/atalhos → main → recorder. */
    sendCommand(cmd: RecorderCommand): void
    onCommand(cb: (cmd: RecorderCommand) => void): Unsubscribe
    onRecover(cb: (sessions: Session[]) => void): Unsubscribe
  }
  overlay: {
    setMode(payload: OverlayModePayload): Promise<void>
    onMode(cb: (p: OverlayModePayload) => void): Unsubscribe
    emitStroke(evt: OverlayStrokeEvent): void
    onStroke(cb: (evt: OverlayStrokeEvent) => void): Unsubscribe
    emitAction(evt: OverlayActionEvent): void
    onAction(cb: (evt: OverlayActionEvent) => void): Unsubscribe
    /** Recorder → overlays: estado dos traços (para desfazer/apagar espelharem). */
    syncStrokes(displayId: string, strokes: Stroke[]): void
    onSyncStrokes(cb: (strokes: Stroke[]) => void): Unsubscribe
  }
  bar: {
    onState(cb: (s: BarState) => void): Unsubscribe
    setPosition(x: number, y: number): void
  }
  export: {
    run(req: ExportRequest): Promise<{ jobId: string }>
    cancel(jobId: string): Promise<void>
    onProgress(cb: (p: ExportProgress) => void): Unsubscribe
    probeEncoders(force: boolean): Promise<EncoderProbe>
    reviewAssets(sessionId: string): Promise<ReviewAssets>
    onReviewAssetsProgress(cb: (p: { sessionId: string; percent: number }) => void): Unsubscribe
  }
  hotkeys: {
    apply(map: Record<HotkeyAction, string | null>): Promise<HotkeyStatus[]>
    status(): Promise<HotkeyStatus[]>
    onStatus(cb: (s: HotkeyStatus[]) => void): Unsubscribe
  }
  update: {
    check(manual: boolean): Promise<void>
    download(): Promise<void>
    install(): Promise<void>
    status(): Promise<UpdateStatus>
    onStatus(cb: (s: UpdateStatus) => void): Unsubscribe
  }
}

/** Nomes de canal (invoke/send/on). */
export const IPC = {
  app: {
    info: 'app:info',
    openExternal: 'app:openExternal',
    showItemInFolder: 'app:showItemInFolder',
    openPath: 'app:openPath',
    copyText: 'app:copyText',
    copyFile: 'app:copyFile',
    showRecorder: 'app:showRecorder',
    minimize: 'app:minimize',
    hideToTray: 'app:hideToTray',
    quit: 'app:quit',
    displayIdOfThisWindow: 'app:displayIdOfThisWindow'
  },
  settings: { get: 'settings:get', set: 'settings:set', pickFolder: 'settings:pickFolder', changed: 'settings:changed' },
  sources: { list: 'sources:list', thumbnail: 'sources:thumbnail' },
  capture: { select: 'capture:select' },
  session: {
    create: 'session:create',
    writeOpen: 'session:writeOpen',
    write: 'session:write',
    writeClose: 'session:writeClose',
    save: 'session:save',
    get: 'session:get',
    list: 'session:list',
    delete: 'session:delete',
    openFolder: 'session:openFolder',
    freeSpaceMB: 'session:freeSpaceMB',
    unfinished: 'session:unfinished',
    filePath: 'session:filePath'
  },
  recording: {
    setPhase: 'recording:setPhase',
    barUpdate: 'recording:barUpdate',
    sendCommand: 'recording:sendCommand',
    command: 'recording:command',
    recover: 'recording:recover'
  },
  overlay: {
    setMode: 'overlay:setMode',
    mode: 'overlay:mode',
    emitStroke: 'overlay:emitStroke',
    stroke: 'overlay:stroke',
    emitAction: 'overlay:emitAction',
    action: 'overlay:action',
    syncStrokes: 'overlay:syncStrokes',
    strokesSynced: 'overlay:strokesSynced'
  },
  bar: { state: 'bar:state', setPosition: 'bar:setPosition' },
  export: {
    run: 'export:run',
    cancel: 'export:cancel',
    progress: 'export:progress',
    probeEncoders: 'export:probeEncoders',
    reviewAssets: 'export:reviewAssets',
    reviewAssetsProgress: 'export:reviewAssetsProgress'
  },
  hotkeys: { apply: 'hotkeys:apply', status: 'hotkeys:status', statusChanged: 'hotkeys:statusChanged' },
  update: { check: 'update:check', download: 'update:download', install: 'update:install', status: 'update:status', statusChanged: 'update:statusChanged' }
} as const

export const FILE_PROTOCOL = 'cialight-file'
