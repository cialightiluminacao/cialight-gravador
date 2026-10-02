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

import type { Asset, Project, Us } from './editor/project'

export type Unsubscribe = () => void

export interface ProjectSummary {
  id: string
  name: string
  updatedAt: string
  durationUs: Us
  thumb?: string
  originSessionId?: string
}

export type IngestStep = 'probe' | 'proxy' | 'intermediate' | 'filmstrip' | 'peaks' | 'speech' | 'loudness' | 'audioProcess'
/** Progresso de uma etapa da ingestão de um asset (0–100). `key`: chave do pré-processamento de áudio (step 'audioProcess'). */
export interface IngestJob { projectId: string; assetId: string; step: IngestStep; percent: number; key?: string }
/** Resultado da ingestão de um asset: patch para ops.updateAsset (caminhos relativos à pasta do projeto). */
export interface IngestDone { projectId: string; assetId: string; patch: Partial<Asset> }

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
    /** Tamanho em bytes de arquivos (null se não existir). */
    fileSizes(paths: string[]): Promise<(number | null)[]>
    /** Editor: maximiza a janela ao entrar (on) e restaura o tamanho anterior ao sair. */
    setEditorMode(on: boolean): Promise<void>
    /** Caminho no disco de um File arrastado do Explorer (webUtils.getPathForFile); '' se não houver. */
    pathForFile(file: File): string
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
    /** Envia à Lixeira; lança se algum projeto do editor usa a gravação (ver usedBy). */
    delete(id: string): Promise<void>
    /** Projetos do editor que dependem da gravação (origem, mídia ou anotações). */
    usedBy(id: string): Promise<{ id: string; name: string }[]>
    /** Sessão pronta para o editor: gravação de fallback (MediaRecorder) é remuxada em rec.mp4 antes. */
    prepareForEditor(id: string): Promise<Session | null>
    openFolder(id: string): Promise<void>
    freeSpaceMB(): Promise<number>
    unfinished(): Promise<Session[]>
    /** URL servida pelo protocolo cialight-file:// (streaming com Range). */
    fileUrl(id: string, name: string): string
    filePath(id: string, name: string): Promise<string>
  }
  project: {
    list(): Promise<ProjectSummary[]>
    create(p: Project): Promise<void>
    load(id: string): Promise<Project>
    save(p: Project): Promise<void>
    remove(id: string): Promise<void>
    /** Lê a sessão no main, converte com projectFromSession, cria o projeto e o retorna. */
    fromSession(sessionId: string): Promise<Project>
    /** Diálogo de abrir arquivos de mídia (multi-seleção); [] se cancelado. */
    pickMedia(): Promise<string[]>
  }
  /**
   * Ingestão de mídia do editor. Fluxo: `import` (probe no main; vídeos/áudios voltam com status
   * 'processing' e já ficam resolvíveis em cialight-file://media/<projectId>/<assetId>?v=original)
   * → renderer adiciona os assets ao projeto, testa `canDecode` e chama `enqueue` com `decodable`
   * → `onProgress` por etapa → `onDone` com o patch, que o renderer aplica (ops.updateAsset) e salva.
   */
  media: {
    import(projectId: string, paths: string[]): Promise<Asset[]>
    /**
     * decodable: faixa de vídeo (ou a de áudio, em mídia só de áudio); audioDecodable: faixa de áudio de um vídeo (ausente = sim).
     * analyzeAudio: só fala + loudness de um asset já pronto (sem probe/proxy); falha não altera o status.
     */
    enqueue(projectId: string, assetId: string, opts: { decodable: boolean; audioDecodable?: boolean; analyzeAudio?: boolean }): Promise<void>
    /**
     * Redução de ruído e/ou normalização (−16 LUFS) da faixa de áudio do asset, em cache por (asset, parâmetros) em
     * generated/. Resolve com a chave pronta quando o arquivo existe (na hora, se já estava em cache); o renderer
     * acrescenta a chave a `asset.processedAudio`. Progresso por `onProgress` (step 'audioProcess', com `key`).
     */
    processAudio(projectId: string, assetId: string, opts: { denoise: boolean; normalize: boolean }): Promise<{ key: string; rel: string }>
    /** Novo caminho para um asset de arquivo (ausente/movido): devolve o asset atualizado com status 'processing'; o renderer aplica e chama `enqueue`. */
    relink(projectId: string, assetId: string, newPath: string): Promise<Asset>
    /**
     * Projeto aberto nesta janela (null ao fechar). Enquanto aberto, o renderer é o único escritor
     * do project.json e recebe `onDone`; sem janela com o projeto aberto, o main aplica e salva.
     */
    setOpenProject(projectId: string | null): Promise<void>
    onProgress(cb: (j: IngestJob) => void): Unsubscribe
    onDone(cb: (d: IngestDone) => void): Unsubscribe
  }
  editor: {
    /**
     * Main → editor antes de fechar a janela/sair com o editor aberto: o callback grava tudo o que estiver
     * pendente (transação aberta, autosave) e solta o projeto; o preload responde ao main ao terminar.
     */
    onFlushRequest(cb: () => Promise<void>): Unsubscribe
  }
  /**
   * Arquivo da exportação do editor: `open` cria `<pasta>/<nome>.mp4.part` (nome livre: " (2)", " (3)"…;
   * com `estimateBytes`, exige estimativa × 2,1 livres), `write` grava bytes por posição, `close` fecha,
   * `finalize` fecha + remuxa com faststart no nome final (apaga o .part; com `maxBytes`, saída maior é
   * apagada e volta `oversize`) e `cancel` apaga o parcial (interrompendo o remux, se houver). Uma por vez.
   */
  editorExport: {
    open(outputDir: string, fileName: string, opts?: { estimateBytes?: number }): Promise<{ jobId: string; path: string }>
    write(jobId: string, data: Uint8Array, position: number): Promise<void>
    close(jobId: string): Promise<void>
    finalize(jobId: string, opts?: { durationUs?: number; maxBytes?: number }): Promise<{ path: string; size: number; oversize?: boolean; warning?: string }>
    cancel(jobId: string): Promise<void>
    /** Progresso do remux (0–1) do job em finalização. */
    onFinalizeProgress(cb: (p: { jobId: string; fraction: number }) => void): Unsubscribe
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
    displayIdOfThisWindow: 'app:displayIdOfThisWindow',
    fileSizes: 'app:fileSizes',
    setEditorMode: 'app:setEditorMode'
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
    usedBy: 'session:usedBy',
    prepareForEditor: 'session:prepareForEditor',
    openFolder: 'session:openFolder',
    freeSpaceMB: 'session:freeSpaceMB',
    unfinished: 'session:unfinished',
    filePath: 'session:filePath'
  },
  project: {
    list: 'project:list',
    create: 'project:create',
    load: 'project:load',
    save: 'project:save',
    remove: 'project:remove',
    fromSession: 'project:fromSession',
    pickMedia: 'project:pickMedia'
  },
  media: {
    import: 'media:import',
    enqueue: 'media:enqueue',
    processAudio: 'media:processAudio',
    relink: 'media:relink',
    setOpenProject: 'media:setOpenProject',
    progress: 'media:progress',
    done: 'media:done'
  },
  editor: { flush: 'editor:flush', flushed: 'editor:flushed' },
  editorExport: {
    open: 'editorExport:open',
    write: 'editorExport:write',
    close: 'editorExport:close',
    finalize: 'editorExport:finalize',
    cancel: 'editorExport:cancel',
    finalizeProgress: 'editorExport:finalizeProgress'
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
/** Hosts reservados do protocolo (os demais hosts são sessionIds): media/<projectId>/<assetId>?v=..., project/<projectId>/<rel>. */
export const FILE_HOST_MEDIA = 'media'
export const FILE_HOST_PROJECT = 'project'
