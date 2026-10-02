import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { FILE_PROTOCOL, IPC, type IpcApi } from '@shared/ipc'

// API tipada exposta ao renderer (contextIsolation ON). Cada janela recebe o
// mesmo preload; `windowKind` diz qual é (recorder | bar | overlay | spike).

const argKind = process.argv.find((a) => a.startsWith('--cialight-window='))?.split('=')[1]
const kind = (argKind === 'bar' || argKind === 'overlay' || argKind === 'spike' ? argKind : 'recorder') as ReturnType<IpcApi['app']['windowKind']>
const argDisplay = process.argv.find((a) => a.startsWith('--cialight-display='))?.split('=')[1] ?? null

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: IpcApi = {
  app: {
    info: () => ipcRenderer.invoke(IPC.app.info),
    openExternal: (url) => ipcRenderer.invoke(IPC.app.openExternal, url),
    showItemInFolder: (p) => ipcRenderer.invoke(IPC.app.showItemInFolder, p),
    openPath: (p) => ipcRenderer.invoke(IPC.app.openPath, p),
    copyText: (t) => ipcRenderer.invoke(IPC.app.copyText, t),
    copyFile: (p) => ipcRenderer.invoke(IPC.app.copyFile, p),
    showRecorder: () => ipcRenderer.invoke(IPC.app.showRecorder),
    minimize: () => ipcRenderer.invoke(IPC.app.minimize),
    hideToTray: () => ipcRenderer.invoke(IPC.app.hideToTray),
    quit: () => ipcRenderer.invoke(IPC.app.quit),
    windowKind: () => kind,
    displayIdOfThisWindow: async () => argDisplay ?? (await ipcRenderer.invoke(IPC.app.displayIdOfThisWindow)),
    fileSizes: (paths) => ipcRenderer.invoke(IPC.app.fileSizes, paths),
    setEditorMode: (on) => ipcRenderer.invoke(IPC.app.setEditorMode, on),
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    }
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settings.get),
    set: (patch) => ipcRenderer.invoke(IPC.settings.set, patch),
    pickFolder: (current) => ipcRenderer.invoke(IPC.settings.pickFolder, current),
    onChange: (cb) => on(IPC.settings.changed, cb)
  },
  sources: {
    list: () => ipcRenderer.invoke(IPC.sources.list),
    thumbnail: (id, w, h) => ipcRenderer.invoke(IPC.sources.thumbnail, id, w, h)
  },
  capture: {
    select: (sourceId, systemAudio) => ipcRenderer.invoke(IPC.capture.select, sourceId, systemAudio)
  },
  session: {
    create: (config, sessionId) => ipcRenderer.invoke(IPC.session.create, config, sessionId),
    writeOpen: (sessionId, name) => ipcRenderer.invoke(IPC.session.writeOpen, sessionId, name),
    write: (handle, data, position) => ipcRenderer.invoke(IPC.session.write, handle, data, position),
    writeClose: (handle) => ipcRenderer.invoke(IPC.session.writeClose, handle),
    save: (session) => ipcRenderer.invoke(IPC.session.save, session),
    get: (id) => ipcRenderer.invoke(IPC.session.get, id),
    list: () => ipcRenderer.invoke(IPC.session.list),
    delete: (id) => ipcRenderer.invoke(IPC.session.delete, id),
    usedBy: (id) => ipcRenderer.invoke(IPC.session.usedBy, id),
    prepareForEditor: (id) => ipcRenderer.invoke(IPC.session.prepareForEditor, id),
    openFolder: (id) => ipcRenderer.invoke(IPC.session.openFolder, id),
    freeSpaceMB: () => ipcRenderer.invoke(IPC.session.freeSpaceMB),
    unfinished: () => ipcRenderer.invoke(IPC.session.unfinished),
    fileUrl: (id, name) => `${FILE_PROTOCOL}://${encodeURIComponent(id)}/${encodeURIComponent(name)}`,
    filePath: (id, name) => ipcRenderer.invoke(IPC.session.filePath, id, name)
  },
  project: {
    list: () => ipcRenderer.invoke(IPC.project.list),
    create: (p) => ipcRenderer.invoke(IPC.project.create, p),
    load: (id) => ipcRenderer.invoke(IPC.project.load, id),
    save: (p) => ipcRenderer.invoke(IPC.project.save, p),
    remove: (id) => ipcRenderer.invoke(IPC.project.remove, id),
    duplicate: (sourceId, p) => ipcRenderer.invoke(IPC.project.duplicate, sourceId, p),
    fromSession: (sessionId) => ipcRenderer.invoke(IPC.project.fromSession, sessionId),
    pickMedia: () => ipcRenderer.invoke(IPC.project.pickMedia),
    writeGeneratedOpen: (projectId, base, ext, meta) => ipcRenderer.invoke(IPC.project.writeGeneratedOpen, projectId, base, ext, meta),
    writeGenerated: (handle, data, position) => ipcRenderer.invoke(IPC.project.writeGenerated, handle, data, position),
    writeGeneratedMeta: (handle, meta) => ipcRenderer.invoke(IPC.project.writeGeneratedMeta, handle, meta),
    writeGeneratedClose: (handle) => ipcRenderer.invoke(IPC.project.writeGeneratedClose, handle),
    generatedAsset: (projectId, rel, opts) => ipcRenderer.invoke(IPC.project.generatedAsset, projectId, rel, opts),
    pendingGenerated: (projectId) => ipcRenderer.invoke(IPC.project.pendingGenerated, projectId),
    clearPendingGenerated: (projectId, rel, opts) => ipcRenderer.invoke(IPC.project.clearPendingGenerated, projectId, rel, opts)
  },
  media: {
    import: (projectId, paths) => ipcRenderer.invoke(IPC.media.import, projectId, paths),
    enqueue: (projectId, assetId, opts) => ipcRenderer.invoke(IPC.media.enqueue, projectId, assetId, opts),
    processAudio: (projectId, assetId, opts) => ipcRenderer.invoke(IPC.media.processAudio, projectId, assetId, opts),
    relink: (projectId, assetId, newPath) => ipcRenderer.invoke(IPC.media.relink, projectId, assetId, newPath),
    setOpenProject: (projectId) => ipcRenderer.invoke(IPC.media.setOpenProject, projectId),
    onProgress: (cb) => on(IPC.media.progress, cb),
    onDone: (cb) => on(IPC.media.done, cb)
  },
  editor: {
    onFlushRequest: (cb) =>
      on<number>(IPC.editor.flush, (id) => {
        void cb()
          .catch(() => {})
          .finally(() => ipcRenderer.send(IPC.editor.flushed, id))
      })
  },
  editorExport: {
    open: (outputDir, fileName, opts) => ipcRenderer.invoke(IPC.editorExport.open, outputDir, fileName, opts),
    write: (jobId, data, position) => ipcRenderer.invoke(IPC.editorExport.write, jobId, data, position),
    close: (jobId) => ipcRenderer.invoke(IPC.editorExport.close, jobId),
    finalize: (jobId, opts) => ipcRenderer.invoke(IPC.editorExport.finalize, jobId, opts),
    cancel: (jobId) => ipcRenderer.invoke(IPC.editorExport.cancel, jobId),
    onFinalizeProgress: (cb) => on(IPC.editorExport.finalizeProgress, cb),
    openPipe: (outputDir, fileName, spec, opts) => ipcRenderer.invoke(IPC.editorExport.openPipe, outputDir, fileName, spec, opts),
    pipeWrite: (jobId, data) => ipcRenderer.invoke(IPC.editorExport.pipeWrite, jobId, data),
    pipeFinish: (jobId) => ipcRenderer.invoke(IPC.editorExport.pipeFinish, jobId),
    writeStill: (outputDir, fileName, png) => ipcRenderer.invoke(IPC.editorExport.writeStill, outputDir, fileName, png),
    saveText: (defaultPath, text) => ipcRenderer.invoke(IPC.editorExport.saveText, defaultPath, text),
    setQueueState: (state) => ipcRenderer.invoke(IPC.editorExport.setQueueState, state)
  },
  recording: {
    setPhase: (phase, ctx) => ipcRenderer.invoke(IPC.recording.setPhase, phase, ctx),
    barUpdate: (state) => ipcRenderer.send(IPC.recording.barUpdate, state),
    sendCommand: (cmd) => ipcRenderer.send(IPC.recording.sendCommand, cmd),
    onCommand: (cb) => on(IPC.recording.command, cb),
    onRecover: (cb) => on(IPC.recording.recover, cb)
  },
  overlay: {
    setMode: (payload) => ipcRenderer.invoke(IPC.overlay.setMode, payload),
    onMode: (cb) => on(IPC.overlay.mode, cb),
    emitStroke: (evt) => ipcRenderer.send(IPC.overlay.emitStroke, evt),
    onStroke: (cb) => on(IPC.overlay.stroke, cb),
    emitAction: (evt) => ipcRenderer.send(IPC.overlay.emitAction, evt),
    onAction: (cb) => on(IPC.overlay.action, cb),
    syncStrokes: (displayId, strokes) => ipcRenderer.send(IPC.overlay.syncStrokes, displayId, strokes),
    onSyncStrokes: (cb) => on(IPC.overlay.strokesSynced, cb)
  },
  bar: {
    onState: (cb) => on(IPC.bar.state, cb),
    setPosition: (x, y) => ipcRenderer.send(IPC.bar.setPosition, x, y)
  },
  export: {
    run: (req) => ipcRenderer.invoke(IPC.export.run, req),
    cancel: (jobId) => ipcRenderer.invoke(IPC.export.cancel, jobId),
    onProgress: (cb) => on(IPC.export.progress, cb),
    probeEncoders: (force) => ipcRenderer.invoke(IPC.export.probeEncoders, force),
    reviewAssets: (sessionId) => ipcRenderer.invoke(IPC.export.reviewAssets, sessionId),
    onReviewAssetsProgress: (cb) => on(IPC.export.reviewAssetsProgress, cb)
  },
  hotkeys: {
    apply: (map) => ipcRenderer.invoke(IPC.hotkeys.apply, map),
    status: () => ipcRenderer.invoke(IPC.hotkeys.status),
    onStatus: (cb) => on(IPC.hotkeys.statusChanged, cb)
  },
  update: {
    check: (manual) => ipcRenderer.invoke(IPC.update.check, manual),
    download: () => ipcRenderer.invoke(IPC.update.download),
    install: () => ipcRenderer.invoke(IPC.update.install),
    status: () => ipcRenderer.invoke(IPC.update.status),
    onStatus: (cb) => on(IPC.update.statusChanged, cb)
  }
}

// API do spike (só quando o app roda em CIALIGHT_SPIKE=1) — mantida em objeto separado.
const spike = {
  getSources: (): Promise<unknown[]> => ipcRenderer.invoke('spike:getSources'),
  chooseSource: (id: string, wantAudio: boolean): Promise<void> => ipcRenderer.invoke('spike:chooseSource', id, wantAudio),
  openWrite: (name: string): Promise<number> => ipcRenderer.invoke('spike:openWrite', name),
  write: (handle: number, data: Uint8Array, position: number): Promise<void> => ipcRenderer.invoke('spike:write', handle, data, position),
  closeWrite: (handle: number): Promise<void> => ipcRenderer.invoke('spike:closeWrite', handle),
  log: (msg: string): void => {
    ipcRenderer.send('spike:log', msg)
  },
  captureThumb: (name: string): Promise<string> => ipcRenderer.invoke('spike:captureThumb', name),
  protect: (on: boolean): Promise<void> => ipcRenderer.invoke('spike:protect', on),
  setOverlayInteractive: (on: boolean): Promise<void> => ipcRenderer.invoke('spike:overlayInteractive', on),
  cpu: (): Promise<{ percentCPUUsage: number }> => ipcRenderer.invoke('spike:cpu'),
  done: (report: unknown): Promise<unknown> => ipcRenderer.invoke('spike:done', report),
  osClickOverlay: (): Promise<void> => ipcRenderer.invoke('spike:osClickOverlay'),
  playSound: (): Promise<void> => ipcRenderer.invoke('spike:playSound'),
  testHotkeyNotepad: (): Promise<void> => ipcRenderer.invoke('spike:testHotkeyNotepad'),
  requestGestureStart: (): Promise<void> => ipcRenderer.invoke('spike:requestGestureStart'),
  onHotkey: (cb: () => void): (() => void) => on('spike:hotkey', cb),
  onOverlayEvent: (cb: (msg: string) => void): (() => void) => on('spike:overlayEvent', cb),
  overlayReport: (msg: string): void => {
    ipcRenderer.send('spike:overlayReport', msg)
  }
}

export type SpikeApi = typeof spike

contextBridge.exposeInMainWorld('api', api)
contextBridge.exposeInMainWorld('spikeApi', spike)
// canal do teste de integração de captura (só quando CIALIGHT_TEST está definido)
if (process.env.CIALIGHT_TEST) {
  contextBridge.exposeInMainWorld('__captureTestSend', (r: unknown) => ipcRenderer.send('test:result', r))
}
