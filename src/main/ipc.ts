import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { join } from 'path'
import { IPC, type BarState, type ExportRequest, type OverlayActionEvent, type OverlayModePayload, type OverlayStrokeEvent, type RecordingPhaseContext } from '@shared/ipc'
import type { HotkeyAction, RecorderCommand, RecorderPhase, RecordingConfig, Session, Settings, Stroke } from '@shared/types'
import { getSettings, outputDir, rawDir, setSettings } from './settings/settingsStore'
import { listDisplays, listSources, sourceThumbnail } from './capture/sources'
import { selectCaptureSource } from './capture/displayMediaHandler'
import type { SessionStore } from './session/sessionStore'
import { getRecorderWindow, showRecorder, displayIdOfWindow } from './windows/recorderWindow'
import { hideBar, showBar, toggleBar, updateBar, isBarHiddenByUser } from './windows/barWindow'
import { hideOverlays, setOverlayMode, showOverlays, syncStrokesToOverlays } from './windows/overlayWindows'
import { setProtection } from './windows/protection'
import { broadcastCommand, getPhase, setBarState, setPhaseValue } from './recording/state'
import { applyHotkeys, getHotkeyStatus } from './hotkeys/globalShortcuts'
import { probeEncoders } from './export/encoderProbe'
import { buildReviewAssets } from './export/reviewAssets'
import { normalizeFallbackSession } from './export/fallbackRemux'
import { cancelExportJob, startExportJob } from './export/exportJob'
import { check as updateCheck, download as updateDownload, getUpdateStatus, install as updateInstall } from './update/autoUpdater'
import { logsDir, log } from './log'
import { trayBalloon } from './tray'

// Registra todos os handlers IPC. Mantém a UI (renderer) desacoplada dos módulos do main.

export function registerIpc(store: SessionStore): void {
  const sendToRecorder = (channel: string, ...args: unknown[]): void => {
    const w = getRecorderWindow()
    if (w && !w.webContents.isDestroyed()) w.webContents.send(channel, ...args)
  }
  const broadcastAll = (channel: string, ...args: unknown[]): void => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send(channel, ...args)
  }

  // ---- app ----
  ipcMain.handle(IPC.app.info, () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    isPackaged: app.isPackaged,
    paths: { output: outputDir(), raw: rawDir(), logs: logsDir(), userData: app.getPath('userData') }
  }))
  ipcMain.handle(IPC.app.openExternal, (_e, url: string) => {
    if (/^(https?:|ms-settings:)/.test(url)) return shell.openExternal(url)
    return Promise.resolve()
  })
  ipcMain.handle(IPC.app.showItemInFolder, (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle(IPC.app.openPath, async (_e, p: string) => {
    await shell.openPath(p)
  })
  ipcMain.handle(IPC.app.copyText, (_e, t: string) => clipboard.writeText(t))
  ipcMain.handle(IPC.app.copyFile, (_e, p: string) => {
    // CF_HDROP simplificado: o Explorer aceita "FileNameW" (UTF-16LE terminado em \0)
    clipboard.writeBuffer('FileNameW', Buffer.from(p + '\0', 'ucs2'))
  })
  ipcMain.handle(IPC.app.showRecorder, () => showRecorder())
  ipcMain.handle(IPC.app.minimize, () => getRecorderWindow()?.minimize())
  ipcMain.handle(IPC.app.hideToTray, () => {
    getRecorderWindow()?.hide()
    trayBalloon('CiaLight Gravador', 'Continua em execução na bandeja. Clique no ícone para abrir.')
  })
  ipcMain.handle(IPC.app.quit, () => app.quit())
  ipcMain.handle(IPC.app.displayIdOfThisWindow, (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    return w ? displayIdOfWindow(w) : null
  })

  // ---- settings ----
  ipcMain.handle(IPC.settings.get, () => getSettings())
  ipcMain.handle(IPC.settings.set, (_e, patch: Partial<Settings>) => {
    const next = setSettings(patch)
    broadcastAll(IPC.settings.changed, next)
    return next
  })
  ipcMain.handle(IPC.settings.pickFolder, async (e, current: string | null) => {
    const w = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const r = await dialog.showOpenDialog(w!, { properties: ['openDirectory', 'createDirectory'], defaultPath: current ?? undefined, title: 'Escolher pasta' })
    return r.canceled ? null : r.filePaths[0] ?? null
  })

  // ---- sources / capture ----
  ipcMain.handle(IPC.sources.list, () => listSources())
  ipcMain.handle(IPC.sources.thumbnail, (_e, id: string, w: number, h: number) => sourceThumbnail(id, w, h))
  ipcMain.handle(IPC.capture.select, (_e, sourceId: string, systemAudio: boolean) => selectCaptureSource(sourceId, systemAudio))

  // ---- session ----
  ipcMain.handle(IPC.session.create, (_e, config: RecordingConfig, sessionId: string) => {
    const displays = listDisplays()
    const d = config.source.displayId ? displays.find((x) => x.id === config.source.displayId) : undefined
    const bounds = d?.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
    return store.create(config, sessionId, { bounds, scaleFactor: d?.scaleFactor ?? 1, video: { width: 0, height: 0, fps: config.fps, codec: '', bitrate: 0 } })
  })
  ipcMain.handle(IPC.session.writeOpen, (_e, sessionId: string, name: string) => store.openWrite(sessionId, name))
  ipcMain.handle(IPC.session.write, (_e, handle: number, data: Uint8Array, position: number) => store.write(handle, data, position))
  ipcMain.handle(IPC.session.writeClose, (_e, handle: number) => store.closeWrite(handle))
  ipcMain.handle(IPC.session.save, (_e, session: Session) => store.save(session))
  ipcMain.handle(IPC.session.get, (_e, id: string) => store.get(id))
  ipcMain.handle(IPC.session.list, () => store.list())
  ipcMain.handle(IPC.session.delete, (_e, id: string) => store.delete(id))
  ipcMain.handle(IPC.session.openFolder, async (_e, id: string) => {
    await shell.openPath(store.dirOf(id))
  })
  ipcMain.handle(IPC.session.freeSpaceMB, () => store.freeSpaceMB())
  ipcMain.handle(IPC.session.unfinished, () => store.findUnfinished())
  ipcMain.handle(IPC.session.filePath, (_e, id: string, name: string) => store.filePath(id, name))

  // ---- recording (fase, barra, comandos) ----
  ipcMain.handle(IPC.recording.setPhase, (_e, phase: RecorderPhase, ctx?: RecordingPhaseContext) => {
    const prev = getPhase()
    setPhaseValue(phase)
    const displays = listDisplays()
    const targets = (ctx?.displayIds ?? []).map((id) => displays.find((d) => d.id === id)).filter((d): d is NonNullable<typeof d> => !!d)
    switch (phase) {
      case 'countdown': {
        setProtection(true)
        if (targets.length) showOverlays(targets)
        setOverlayMode({ mode: 'countdown', count: ctx?.countdownSec ?? 3, targetRect: ctx?.targetRect ?? null, sourceKind: ctx?.sourceKind, sourceName: ctx?.sourceName })
        break
      }
      case 'recording': {
        setProtection(true)
        if (targets.length) showOverlays(targets)
        setOverlayMode({ mode: 'idle', paused: false, targetRect: ctx?.targetRect ?? null, sourceKind: ctx?.sourceKind, sourceName: ctx?.sourceName })
        const barTarget = targets[0] ?? displays.find((d) => d.isPrimary) ?? displays[0]
        if (barTarget && !(prev === 'paused' && isBarHiddenByUser())) showBar(barTarget, null)
        break
      }
      case 'paused': {
        setOverlayMode({ mode: 'idle', paused: true, targetRect: ctx?.targetRect ?? null, sourceKind: ctx?.sourceKind, sourceName: ctx?.sourceName })
        break
      }
      case 'stopping':
      case 'review':
      case 'idle': {
        setOverlayMode({ mode: 'hidden' })
        hideOverlays()
        hideBar()
        setProtection(false)
        break
      }
    }
    log.info(`fase: ${prev} → ${phase}`)
  })
  ipcMain.on(IPC.recording.barUpdate, (_e, state: BarState) => {
    setBarState(state)
    updateBar(state)
  })
  ipcMain.on(IPC.recording.sendCommand, (_e, cmd: RecorderCommand) => {
    if (cmd === 'toggleBar') {
      toggleBar()
      return
    }
    if (cmd === 'showRecorder') {
      showRecorder()
      return
    }
    broadcastCommand(cmd)
  })

  // ---- overlay ----
  ipcMain.handle(IPC.overlay.setMode, (_e, payload: OverlayModePayload) => setOverlayMode(payload))
  ipcMain.on(IPC.overlay.emitStroke, (_e, evt: OverlayStrokeEvent) => sendToRecorder(IPC.overlay.stroke, evt))
  ipcMain.on(IPC.overlay.emitAction, (_e, evt: OverlayActionEvent) => sendToRecorder(IPC.overlay.action, evt))
  ipcMain.on(IPC.overlay.syncStrokes, (_e, displayId: string, strokes: Stroke[]) => syncStrokesToOverlays(displayId || null, strokes))

  // ---- bar ----
  ipcMain.on(IPC.bar.setPosition, () => {
    /* posição é persistida no evento 'moved' da janela */
  })

  // ---- export ----
  ipcMain.handle(IPC.export.run, (_e, req: ExportRequest) => {
    const { jobId } = startExportJob(req, store, (p) => sendToRecorder(IPC.export.progress, p))
    return { jobId }
  })
  ipcMain.handle(IPC.export.cancel, (_e, jobId: string) => cancelExportJob(jobId))
  ipcMain.handle(IPC.export.probeEncoders, (_e, force: boolean) => probeEncoders(force))
  ipcMain.handle(IPC.export.reviewAssets, async (_e, sessionId: string) => {
    let session = store.get(sessionId)
    if (!session) throw new Error('Sessão não encontrada')
    const dir = store.dirOf(sessionId)
    if (session.files.fallback) {
      session = await normalizeFallbackSession(session, dir)
      store.save(session)
    }
    const assets = await buildReviewAssets(session, dir, (percent) => sendToRecorder(IPC.export.reviewAssetsProgress, { sessionId, percent }))
    session.files.proxy = 'preview.mp4'
    if (assets.webcam) session.files.webcam = 'webcam.mp4'
    if (assets.thumbs.length) session.files.thumbs = 'thumbs'
    if (assets.waveform) session.files.waveform = 'wave.png'
    if (!session.durationMs) session.durationMs = assets.durationMs
    store.save(session)
    return assets
  })

  // ---- hotkeys ----
  ipcMain.handle(IPC.hotkeys.apply, (_e, map: Record<HotkeyAction, string | null>) => {
    const status = applyHotkeys(map)
    broadcastAll(IPC.hotkeys.statusChanged, status)
    return status
  })
  ipcMain.handle(IPC.hotkeys.status, () => getHotkeyStatus())

  // ---- update ----
  ipcMain.handle(IPC.update.check, (_e, manual: boolean) => updateCheck(manual))
  ipcMain.handle(IPC.update.download, () => updateDownload())
  ipcMain.handle(IPC.update.install, () => updateInstall())
  ipcMain.handle(IPC.update.status, () => getUpdateStatus())

  void join
}
