import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { basename, extname, join } from 'path'
import { statSync } from 'fs'
import { IPC, type BarState, type ExportRequest, type OverlayActionEvent, type OverlayModePayload, type OverlayStrokeEvent, type RecordingPhaseContext } from '@shared/ipc'
import type { HotkeyAction, RecorderCommand, RecorderPhase, RecordingConfig, Session, Settings, Stroke } from '@shared/types'
import { getSettings, outputDir, rawDir, setSettings } from './settings/settingsStore'
import { listDisplays, listSources, sourceThumbnail } from './capture/sources'
import { selectCaptureSource } from './capture/displayMediaHandler'
import type { SessionStore } from './session/sessionStore'
import type { ProjectStore } from './project/projectStore'
import type { Asset } from '@shared/editor/project'
import { projectFromSession } from '@shared/editor/fromSession'
import { newId, newProjectId } from '@shared/editor/ids'
import { parseProject } from '@shared/editor/schema'
import { IngestQueue, assetFromInfo, type IngestInput } from './media/ingest'
import { IMAGE_EXTENSIONS, probe } from './media/probe'
import { getRecorderWindow, showRecorder, displayIdOfWindow, setEditorMode } from './windows/recorderWindow'
import { hideBar, showBar, toggleBar, updateBar, isBarHiddenByUser } from './windows/barWindow'
import { hideOverlays, setOverlayMode, showOverlays, syncStrokesToOverlays } from './windows/overlayWindows'
import { setProtection } from './windows/protection'
import { broadcastCommand, getPhase, setBarState, setPhaseValue } from './recording/state'
import { applyHotkeys, getHotkeyStatus } from './hotkeys/globalShortcuts'
import { cachedEncoderProbe, probeEncoders } from './export/encoderProbe'
import { buildReviewAssets } from './export/reviewAssets'
import { normalizeFallbackSession } from './export/fallbackRemux'
import { cancelExportJob, startExportJob } from './export/exportJob'
import { EditorExportJobs } from './export/editorExportJob'
import { check as updateCheck, download as updateDownload, getUpdateStatus, install as updateInstall } from './update/autoUpdater'
import { logsDir, log } from './log'
import { trayBalloon } from './tray'

const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'ts']
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus']

// Registra todos os handlers IPC. Mantém a UI (renderer) desacoplada dos módulos do main.

export function registerIpc(store: SessionStore, projects: ProjectStore): void {
  const sendToRecorder = (channel: string, ...args: unknown[]): void => {
    const w = getRecorderWindow()
    if (w && !w.webContents.isDestroyed()) w.webContents.send(channel, ...args)
  }
  const broadcastAll = (channel: string, ...args: unknown[]): void => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send(channel, ...args)
  }

  /** Sessão para o editor: a de fallback (vários arquivos, ex.: recuperada após queda) vira rec.mp4 antes. */
  const sessionForEditor = async (id: string): Promise<Session | null> => {
    let session = store.get(id)
    if (session?.files.fallback) {
      session = await normalizeFallbackSession(session, store.dirOf(id))
      store.save(session)
    }
    return session
  }

  // ---- ingestão de mídia ----
  // Projeto aberto em cada janela do editor (webContents.id → projectId|null).
  const openProjects = new Map<number, string | null>()
  const watchedContents = new Set<number>()
  const resolveIngestInput = (projectId: string, a: Asset): IngestInput => {
    switch (a.source.type) {
      case 'file':
        return { path: a.source.path }
      case 'generated':
        return { path: projects.filePath(projectId, a.source.file) }
      case 'session': {
        // rec.mp4 multi-faixa: índice por tipo vem de session.tracks; gravação do app dispensa proxy
        const tracks = store.get(a.source.sessionId)?.tracks
        const idx = tracks?.[a.source.stream] ?? 0
        const isVideo = a.source.stream === 'screen' || a.source.stream === 'webcam'
        return { path: store.filePath(a.source.sessionId, 'rec.mp4'), analyzeOnly: true, ...(isVideo ? { videoMap: `0:v:${idx}` } : { audioMap: `0:a:${idx}` }) }
      }
    }
  }
  const ingest = new IngestQueue({
    projectFile: (projectId, rel) => projects.filePath(projectId, rel),
    resolveInput: resolveIngestInput,
    // só lê o cache do probe de encoders (o probe grava settings.json); sem cache → libx264
    encoder: () => cachedEncoderProbe()?.preferred ?? 'libx264',
    log
  })
  ingest.on('progress', (j) => broadcastAll(IPC.media.progress, j))
  // Escritor único do project.json: com o projeto aberto num editor, o renderer recebe o patch e o
  // aplica no próprio store (o autosave dele grava); salvar daqui disputaria com esse autosave e uma
  // das escritas se perderia. Sem nenhuma janela com o projeto aberto, o main aplica e salva.
  ingest.on('done', (projectId, assetId, patch) => {
    const owners = BrowserWindow.getAllWindows().filter((w) => !w.webContents.isDestroyed() && openProjects.get(w.webContents.id) === projectId)
    if (owners.length) {
      for (const w of owners) w.webContents.send(IPC.media.done, { projectId, assetId, patch })
      return
    }
    try {
      projects.applyAssetPatch(projectId, assetId, patch, new Date().toISOString())
    } catch (e) {
      log.warn(`ingestão: não foi possível gravar o resultado de ${assetId} em ${projectId}`, e)
    }
  })

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
  ipcMain.handle(IPC.app.setEditorMode, (_e, on: boolean) => setEditorMode(!!on))
  ipcMain.handle(IPC.app.fileSizes, (_e, paths: string[]) =>
    paths.map((p) => {
      try {
        return statSync(p).size
      } catch {
        return null
      }
    })
  )

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
  ipcMain.handle(IPC.session.delete, (_e, id: string) => {
    // projetos do editor apontam para o rec.mp4/session.json da gravação: apagá-la os deixaria sem mídia
    const users = projects.sessionUsage().get(id) ?? []
    if (users.length) throw new Error(`A gravação é usada por ${users.length === 1 ? '1 projeto' : `${users.length} projetos`} do editor (${users.map((p) => p.name).join(', ')}). Exclua os projetos antes.`)
    return store.delete(id)
  })
  ipcMain.handle(IPC.session.usedBy, (_e, id: string) => projects.sessionUsage().get(id) ?? [])
  ipcMain.handle(IPC.session.prepareForEditor, (_e, id: string) => sessionForEditor(id))
  ipcMain.handle(IPC.session.openFolder, async (_e, id: string) => {
    await shell.openPath(store.dirOf(id))
  })
  ipcMain.handle(IPC.session.freeSpaceMB, () => store.freeSpaceMB())
  ipcMain.handle(IPC.session.unfinished, () => store.findUnfinished())
  ipcMain.handle(IPC.session.filePath, (_e, id: string, name: string) => store.filePath(id, name))

  // ---- project (editor) ----
  ipcMain.handle(IPC.project.list, () => projects.list())
  // parseProject lança "Projeto inválido: …" — nada inválido chega ao disco
  ipcMain.handle(IPC.project.create, (_e, p: unknown) => projects.create(parseProject(p)))
  ipcMain.handle(IPC.project.load, (_e, id: string) => projects.withMediaStatus(projects.load(id)))
  ipcMain.handle(IPC.project.save, (_e, p: unknown) => projects.save(parseProject(p)))
  ipcMain.handle(IPC.project.remove, (_e, id: string) => {
    ingest.cancel(id)
    return projects.remove(id)
  })
  ipcMain.handle(IPC.project.fromSession, async (_e, sessionId: string) => {
    const session = await sessionForEditor(sessionId)
    if (!session) throw new Error('Sessão não encontrada')
    const now = new Date()
    const d = new Date(session.createdAt)
    const p2 = (n: number): string => String(n).padStart(2, '0')
    const name = `Gravação ${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`
    const fade = getSettings().annotations.autoFadeSec
    const project = projectFromSession(session, { projectId: newProjectId(now), name, now: now.toISOString(), annotationsAutoFadeMs: fade ? fade * 1000 : null })
    projects.create(project)
    return project
  })
  ipcMain.handle(IPC.project.pickMedia, async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const opts: Electron.OpenDialogOptions = {
      title: 'Importar mídia',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Todos os arquivos de mídia', extensions: [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXTENSIONS] },
        { name: 'Vídeos', extensions: VIDEO_EXT },
        { name: 'Áudios', extensions: AUDIO_EXT },
        { name: 'Imagens', extensions: IMAGE_EXTENSIONS }
      ]
    }
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? [] : r.filePaths
  })

  // ---- media (ingestão do editor) ----
  ipcMain.handle(IPC.media.import, async (_e, projectId: string, paths: string[]) => {
    projects.cached(projectId) // lança cedo se o projeto não existe
    const assets: Asset[] = []
    for (const path of paths) {
      const id = newId('a_')
      // tamanho/mtime reais mesmo se o probe falhar: senão o próximo load marcaria o asset como 'missing'
      let st = { size: 0, mtimeMs: 0 }
      try {
        st = statSync(path)
        assets.push(assetFromInfo(id, path, st, await probe(path)))
      } catch (e) {
        log.warn(`importação de ${path} falhou`, e)
        const ext = extname(path).slice(1).toLowerCase()
        const kind = IMAGE_EXTENSIONS.includes(ext) ? 'image' : AUDIO_EXT.includes(ext) ? 'audio' : 'video'
        const source = { type: 'file' as const, path, size: st.size, mtimeMs: Math.round(st.mtimeMs) }
        assets.push({ id, name: basename(path), kind, source, durationUs: null, status: 'error', error: `Não foi possível ler o arquivo: ${e instanceof Error ? e.message : String(e)}` })
      }
    }
    projects.cacheAssets(projectId, assets)
    return assets
  })
  ipcMain.handle(IPC.media.enqueue, (_e, projectId: string, assetId: string, opts: { decodable: boolean }) => {
    const a = projects.cached(projectId).assets.find((x) => x.id === assetId)
    if (!a) throw new Error(`Asset não encontrado: ${assetId}`)
    ingest.enqueue(projectId, a.video ? { ...a, video: { ...a.video, decodable: !!opts?.decodable } } : a)
  })
  ipcMain.handle(IPC.media.relink, async (_e, projectId: string, assetId: string, newPath: string) => {
    const a = projects.cached(projectId).assets.find((x) => x.id === assetId)
    if (!a) throw new Error(`Asset não encontrado: ${assetId}`)
    if (a.source.type !== 'file') throw new Error('Só mídia importada pode ser reapontada')
    const info = await probe(newPath)
    if (info.kind !== a.kind) throw new Error('O arquivo escolhido não é do mesmo tipo da mídia original')
    const fresh = assetFromInfo(a.id, newPath, statSync(newPath), info)
    // derivados do arquivo antigo deixam de valer (undefined explícito: o renderer aplica com updateAsset)
    const next: Asset = { ...fresh, name: a.name, proxy: undefined, intermediate: undefined, filmstrip: undefined, filmstripInfo: undefined, peaks: undefined, error: undefined }
    projects.cacheAssets(projectId, [next])
    return next
  })
  ipcMain.handle(IPC.media.setOpenProject, (e, projectId: string | null) => {
    const wc = e.sender
    if (!watchedContents.has(wc.id)) {
      // janela fechada, renderer caído ou recarregado/navegado: ninguém mais aplica os patches
      watchedContents.add(wc.id)
      const forget = (): void => void openProjects.delete(wc.id)
      wc.once('destroyed', () => {
        forget()
        watchedContents.delete(wc.id)
      })
      wc.on('render-process-gone', forget)
      wc.on('did-navigate', forget)
    }
    openProjects.set(wc.id, projectId)
  })

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

  // ---- exportação do editor (arquivo .part → faststart) ----
  const editorExports = new EditorExportJobs()
  const exportOwners = new Set<number>()
  ipcMain.handle(IPC.editorExport.open, (e, outputDir: string, fileName: string, opts?: { estimateBytes?: number }) => {
    const wc = e.sender
    if (!exportOwners.has(wc.id)) {
      // janela fechada, renderer caído ou recarregado: o parcial não fica órfão
      exportOwners.add(wc.id)
      const drop = (): void => void editorExports.cancelOwnedBy(wc.id)
      wc.once('destroyed', () => {
        drop()
        exportOwners.delete(wc.id)
      })
      wc.on('render-process-gone', drop)
      wc.on('did-navigate', drop)
    }
    return editorExports.open(outputDir, fileName, wc.id, Math.max(0, Number(opts?.estimateBytes) || 0))
  })
  ipcMain.handle(IPC.editorExport.write, (_e, jobId: string, data: Uint8Array, position: number) => editorExports.write(jobId, data, position))
  ipcMain.handle(IPC.editorExport.close, (_e, jobId: string) => editorExports.close(jobId))
  ipcMain.handle(IPC.editorExport.finalize, (e, jobId: string, opts?: { durationUs?: number; maxBytes?: number }) => {
    const wc = e.sender
    return editorExports.finalize(jobId, {
      durationUs: opts?.durationUs,
      maxBytes: opts?.maxBytes,
      onProgress: (fraction) => {
        if (!wc.isDestroyed()) wc.send(IPC.editorExport.finalizeProgress, { jobId, fraction })
      }
    })
  })
  ipcMain.handle(IPC.editorExport.cancel, (_e, jobId: string) => editorExports.cancel(jobId))
  // saindo no meio de uma exportação/remux: interrompe, apaga os parciais e só então sai
  app.on('will-quit', (e) => {
    if (!editorExports.busy) return
    e.preventDefault()
    void editorExports.cancelOwnedBy(null).finally(() => app.quit())
  })

  // ---- export ----
  ipcMain.handle(IPC.export.run, (_e, req: ExportRequest) => {
    const { jobId } = startExportJob(req, store, (p) => sendToRecorder(IPC.export.progress, p))
    return { jobId }
  })
  ipcMain.handle(IPC.export.cancel, (_e, jobId: string) => cancelExportJob(jobId))
  ipcMain.handle(IPC.export.probeEncoders, async (_e, force: boolean) => {
    const r = await probeEncoders(force)
    broadcastAll(IPC.settings.changed, getSettings())
    return r
  })
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
