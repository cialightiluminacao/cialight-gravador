import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { basename, dirname, extname, join } from 'path'
import { existsSync, promises as fsp, renameSync, rmSync, statSync } from 'fs'
import { IPC, type GeneratedExt, type GeneratedMeta, type BarState, type ExportRequest, type OverlayActionEvent, type OverlayModePayload, type OverlayStrokeEvent, type RecordingPhaseContext } from '@shared/ipc'
import type { HotkeyAction, RecorderCommand, RecorderPhase, RecordingConfig, Session, Settings, Stroke } from '@shared/types'
import { getSettings, outputDir, rawDir, setSettings } from './settings/settingsStore'
import { listDisplays, listSources, sourceThumbnail } from './capture/sources'
import { selectCaptureSource } from './capture/displayMediaHandler'
import type { SessionStore } from './session/sessionStore'
import type { ProjectStore } from './project/projectStore'
import type { Asset } from '@shared/editor/project'
import type { AssetToCopy, BrandTemplate } from '@shared/editor/brand'
import { BrandStore, brandDirFor } from './brand/brandStore'
import { projectFromSession } from '@shared/editor/fromSession'
import { newId, newProjectId } from '@shared/editor/ids'
import { parseProject } from '@shared/editor/schema'
import { IngestQueue, assetFromInfo, type IngestInput } from './media/ingest'
import { findRelinkCandidates, relinkQuery } from './project/relinkSearch'
import { IMAGE_EXTENSIONS, probe } from './media/probe'
import { getRecorderWindow, showRecorder, displayIdOfWindow, setEditorMode } from './windows/recorderWindow'
import { hideBar, showBar, toggleBar, updateBar, isBarHiddenByUser } from './windows/barWindow'
import { hideOverlays, setOverlayMode, showOverlays, syncStrokesToOverlays } from './windows/overlayWindows'
import { setProtection } from './windows/protection'
import { broadcastCommand, getPhase, setBarState, setPhaseValue } from './recording/state'
import { applyHotkeys, getHotkeyStatus } from './hotkeys/globalShortcuts'
import { cachedEncoderProbe, probeEncoders } from './export/encoderProbe'
import { encoderFallbackChain } from '@shared/encoderCache'
import type { AudioProcessOpts } from '@shared/editor/audioProcess'
import { rnnoiseDir } from './export/ffmpegPath'
import { MissingModelError, missingModelMessage } from './media/audioProcess'
import { buildReviewAssets } from './export/reviewAssets'
import { runFfmpeg } from './export/ffmpegRunner'
import { normalizeFallbackSession } from './export/fallbackRemux'
import { cancelExportJob, startExportJob } from './export/exportJob'
import { saveTextFile } from './export/saveText'
import { EditorExportJobs, ExportCancelledError } from './export/editorExportJob'
import { decodeSrtBytes, encodeSrtFile, writeSrtBesideFile } from './captions/srtFiles'
import { sanitizeFileName } from '@shared/filenames'
import { check as updateCheck, download as updateDownload, getUpdateStatus, install as updateInstall } from './update/autoUpdater'
import { logsDir, log } from './log'
import { trayBalloon } from './tray'
import { ExportQueueStates, setExportCountsSource } from './quitGuard'

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
    encoders: () => encoderFallbackChain(cachedEncoderProbe()),
    rnnoiseDir,
    log
  })
  // só o editor (janela do gravador) mostra o progresso: barra e overlays ocultas não precisam dele
  ingest.on('progress', (j) => sendToRecorder(IPC.media.progress, j))
  // Escritor único do project.json: com o projeto aberto num editor, o renderer recebe o patch e o
  // aplica no próprio store (o autosave dele grava); salvar daqui disputaria com esse autosave e uma
  // das escritas se perderia. Sem nenhuma janela com o projeto aberto, o main aplica e salva.
  ingest.on('done', (projectId, assetId, patch) => {
    const owners = BrowserWindow.getAllWindows().filter((w) => !w.webContents.isDestroyed() && openProjects.get(w.webContents.id) === projectId)
    if (owners.length) {
      // o cache em memória recebe o patch já: o renderer passa a pedir o proxy novo (ex.: depois de reapontar) antes
      // do próximo autosave, e o protocolo media/ resolve pelo cache
      projects.cacheAssetPatch(projectId, assetId, patch)
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
  ipcMain.handle(IPC.project.duplicate, (_e, sourceId: string, p: unknown) => projects.duplicate(sourceId, parseProject(p)))
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

  // relink automático: status conferido no disco agora (o cache guarda o do carregamento/último relink)
  ipcMain.handle(IPC.project.findRelinks, async (_e, projectId: string, opts?: { extraRoots?: unknown }) => {
    const q = relinkQuery(projects.withMediaStatus(projects.cached(projectId)), Array.isArray(opts?.extraRoots) ? opts.extraRoots.filter((r): r is string => typeof r === 'string') : [])
    if (q.missing.length === 0) return []
    return findRelinkCandidates(q.missing, { otherAssetDirs: q.otherAssetDirs, extraRoots: q.extraRoots })
  })

  // ---- gravações em generated/ (narração), no padrão de session.write* ----
  const generatedOwners = new Set<number>()
  ipcMain.handle(IPC.project.writeGeneratedOpen, (e, projectId: string, base: string, ext: GeneratedExt, meta: GeneratedMeta) => {
    const wc = e.sender
    if (!generatedOwners.has(wc.id)) {
      // janela fechada, renderer caído ou recarregado: o arquivo fecha e o parcial é recuperado ao abrir o projeto
      generatedOwners.add(wc.id)
      const drop = (): void => projects.closeGeneratedWritesOf(wc.id)
      wc.once('destroyed', () => {
        drop()
        generatedOwners.delete(wc.id)
      })
      wc.on('render-process-gone', drop)
      wc.on('did-navigate', drop)
    }
    return projects.openGeneratedWrite(projectId, base, ext, meta, wc.id)
  })
  // handles só valem para a janela que os abriu
  ipcMain.handle(IPC.project.writeGenerated, (e, handle: number, data: Uint8Array, position: number) => projects.writeGenerated(handle, data, position, e.sender.id))
  ipcMain.handle(IPC.project.writeGeneratedMeta, (e, handle: number, meta: GeneratedMeta) => projects.setGeneratedMeta(handle, meta, e.sender.id))
  ipcMain.handle(IPC.project.writeGeneratedClose, (e, handle: number) => projects.closeGeneratedWrite(handle, e.sender.id))
  ipcMain.handle(IPC.project.generatedAsset, async (_e, projectId: string, rel: string, opts: { name: string; repair?: boolean }) => {
    if (typeof rel !== 'string' || !rel.startsWith('generated/')) throw new Error(`arquivo gerado inválido: ${rel}`)
    const path = projects.filePath(projectId, rel)
    if (opts?.repair) {
      // gravação interrompida: o último fragmento pode ter ficado pela metade — remux só do que é legível
      const tmp = `${path}.repair.m4a`
      try {
        await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', path, '-map', '0:a:0', '-c', 'copy', '-f', 'mp4', '-movflags', '+faststart', tmp], { label: 'recuperar narração' })
        renameSync(tmp, path)
      } catch (e) {
        rmSync(tmp, { force: true })
        log.warn(`recuperação de ${rel} em ${projectId}: remux falhou, usando o arquivo como está`, e)
      }
    }
    const info = await probe(path)
    if (info.kind !== 'audio' || !info.audio) throw new Error('o arquivo gravado não tem áudio legível')
    const asset: Asset = { id: newId('a_'), name: String(opts?.name || rel.slice('generated/'.length)), kind: 'audio', source: { type: 'generated', file: rel }, durationUs: info.durationUs, audio: info.audio, status: 'processing' }
    projects.cacheAssets(projectId, [asset])
    return asset
  })
  ipcMain.handle(IPC.project.pendingGenerated, (_e, projectId: string) => projects.pendingGenerated(projectId))
  ipcMain.handle(IPC.project.clearPendingGenerated, (e, projectId: string, rel: string, opts?: { discardFile?: boolean }) => projects.clearPendingGenerated(projectId, rel, { discardFile: !!opts?.discardFile }, e.sender.id))

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
  ipcMain.handle(IPC.media.enqueue, (_e, projectId: string, assetId: string, opts: { decodable: boolean; audioDecodable?: boolean; analyzeAudio?: boolean }) => {
    const a = projects.cached(projectId).assets.find((x) => x.id === assetId)
    if (!a) throw new Error(`Asset não encontrado: ${assetId}`)
    // mídia só de áudio: `decodable` é o da faixa de áudio
    const audioDecodable = a.kind === 'audio' ? !!opts?.decodable : opts?.audioDecodable !== false
    ingest.enqueue(projectId, {
      ...a,
      ...(a.video ? { video: { ...a.video, decodable: !!opts?.decodable } } : {}),
      ...(a.audio ? { audio: { ...a.audio, decodable: audioDecodable } } : {})
    }, { analyzeAudio: !!opts?.analyzeAudio })
  })
  ipcMain.handle(IPC.media.processAudio, (_e, projectId: string, assetId: string, opts: AudioProcessOpts) => {
    const a = projects.cached(projectId).assets.find((x) => x.id === assetId)
    if (!a) throw new Error(`Asset não encontrado: ${assetId}`)
    return ingest.processAudio(projectId, a, { denoise: !!opts?.denoise, normalize: !!opts?.normalize }).catch((e: unknown) => {
      throw e instanceof MissingModelError ? new Error(missingModelMessage(e, app.isPackaged)) : e
    })
  })
  ipcMain.handle(IPC.media.relink, async (_e, projectId: string, assetId: string, newPath: string) => {
    const a = projects.cached(projectId).assets.find((x) => x.id === assetId)
    if (!a) throw new Error(`Asset não encontrado: ${assetId}`)
    if (a.source.type !== 'file') throw new Error('Só mídia importada pode ser reapontada')
    const info = await probe(newPath)
    if (info.kind !== a.kind) throw new Error('O arquivo escolhido não é do mesmo tipo da mídia original')
    const fresh = assetFromInfo(a.id, newPath, statSync(newPath), info)
    // derivados do arquivo antigo deixam de valer (undefined explícito: o renderer aplica com updateAsset)
    const next: Asset = { ...fresh, name: a.name, proxy: undefined, intermediate: undefined, filmstrip: undefined, filmstripInfo: undefined, peaks: undefined, speech: undefined, loudness: undefined, processedAudio: undefined, error: undefined }
    // áudio pré-processado do arquivo antigo: para o que estiver rodando e apaga o cache (a impressão da fonte no nome já
    // impede reusar a versão errada; aqui é limpeza)
    ingest.cancelAudio(projectId, assetId)
    projects.removeProcessedAudio(projectId, assetId)
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
  // fila de exportações (renderer): estado por janela; a confirmação de saída conta rodando + na fila
  const queueStates = new ExportQueueStates()
  setExportCountsSource(() => queueStates.counts(editorExports.busy))
  const queueOwners = new Set<number>()
  const exportOwners = new Set<number>()
  /** Os jobs são da janela que os abriu: fechada, caída ou recarregada → cancelados (nada de parcial órfão). */
  const ownExport = (wc: Electron.WebContents): void => {
    if (!exportOwners.has(wc.id)) {
      exportOwners.add(wc.id)
      const drop = (): void => void editorExports.cancelOwnedBy(wc.id)
      wc.once('destroyed', () => {
        drop()
        exportOwners.delete(wc.id)
      })
      wc.on('render-process-gone', drop)
      wc.on('did-navigate', drop)
    }
  }
  ipcMain.handle(IPC.editorExport.open, (e, outputDir: string, fileName: string, opts?: { estimateBytes?: number; reserveSrt?: boolean }) => {
    ownExport(e.sender)
    return editorExports.open(outputDir, fileName, e.sender.id, Math.max(0, Number(opts?.estimateBytes) || 0), opts?.reserveSrt === true)
  })
  ipcMain.handle(IPC.editorExport.openPipe, (e, outputDir: string, fileName: string, spec: unknown, opts?: { estimateBytes?: number; reserveSrt?: boolean }) => {
    ownExport(e.sender)
    return editorExports.openPipe(outputDir, fileName, spec, e.sender.id, Math.max(0, Number(opts?.estimateBytes) || 0), opts?.reserveSrt === true)
  })
  /** Cancelamento esperado (usuário, janela fechada, saída): resposta { cancelled: true } e log de cancelamento, não erro. */
  const cancelAware = async <T>(jobId: string, p: Promise<T>): Promise<T | { cancelled: true }> => {
    try {
      return await p
    } catch (e) {
      if (!(e instanceof ExportCancelledError)) throw e
      log.info(`exportação do editor ${jobId}: chamada depois do cancelamento (cancelada)`)
      return { cancelled: true }
    }
  }
  // só a janela dona do job grava/finaliza (a mesma posse do open/cancel)
  ipcMain.handle(IPC.editorExport.pipeWrite, (e, jobId: string, data: Uint8Array) => cancelAware(jobId, editorExports.pipeWrite(jobId, data, e.sender.id)))
  ipcMain.handle(IPC.editorExport.pipeFinish, (e, jobId: string, opts?: { maxBytes?: number }) => {
    const wc = e.sender
    const maxBytes = Number(opts?.maxBytes)
    return cancelAware(
      jobId,
      editorExports.pipeFinish(jobId, {
        owner: wc.id,
        maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : undefined,
        onProgress: (fraction) => {
          if (!wc.isDestroyed()) wc.send(IPC.editorExport.finalizeProgress, { jobId, fraction })
        }
      })
    )
  })
  ipcMain.handle(IPC.editorExport.writeStill, (e, outputDir: string, fileName: string, png: Uint8Array) => {
    ownExport(e.sender)
    return editorExports.writeStill(outputDir, fileName, png, e.sender.id)
  })
  // capítulos (.txt): o diálogo abre sobre a janela que pediu
  ipcMain.handle(IPC.editorExport.saveText, (e, defaultPath: string, text: string) => {
    if (typeof defaultPath !== 'string' || typeof text !== 'string' || text.length > 1_000_000) throw new Error('Texto inválido')
    const w = BrowserWindow.fromWebContents(e.sender)
    return saveTextFile({ showSave: (opts) => (w ? dialog.showSaveDialog(w, opts) : dialog.showSaveDialog(opts)) }, defaultPath, text)
  })
  ipcMain.handle(IPC.editorExport.setQueueState, (e, state: { running: boolean; pending: number }) => {
    const wc = e.sender
    if (!queueOwners.has(wc.id)) {
      queueOwners.add(wc.id)
      // janela fechada, caída ou recarregada: a fila dela sumiu junto
      const drop = (): void => queueStates.drop(wc.id)
      wc.once('destroyed', () => {
        drop()
        queueOwners.delete(wc.id)
      })
      wc.on('render-process-gone', drop)
      wc.on('did-navigate', drop)
    }
    queueStates.set(wc.id, state)
  })
  ipcMain.handle(IPC.editorExport.write, (_e, jobId: string, data: Uint8Array, position: number) => cancelAware(jobId, editorExports.write(jobId, data, position)))
  ipcMain.handle(IPC.editorExport.close, (_e, jobId: string) => editorExports.close(jobId))
  ipcMain.handle(IPC.editorExport.finalize, (e, jobId: string, opts?: { durationUs?: number; maxBytes?: number }) => {
    const wc = e.sender
    return cancelAware(jobId, editorExports.finalize(jobId, {
      durationUs: opts?.durationUs,
      maxBytes: opts?.maxBytes,
      onProgress: (fraction) => {
        if (!wc.isDestroyed()) wc.send(IPC.editorExport.finalizeProgress, { jobId, fraction })
      }
    }))
  })
  ipcMain.handle(IPC.editorExport.cancel, (_e, jobId: string) => editorExports.cancel(jobId))
  // ---- modelos de marca ----
  // userData/brand-templates.json + brand-assets/ (nunca settings.json); em teste/QA, a pasta de teste (brandDirFor)
  const brand = new BrandStore(brandDirFor(process.env, app.getPath('userData')))
  ipcMain.handle(IPC.brand.list, () => brand.list())
  ipcMain.handle(IPC.brand.save, (_e, template: BrandTemplate, assetsToCopy: AssetToCopy[], projectId: string) => {
    // os arquivos vêm dos assets do projeto (nunca um caminho arbitrário do renderer): o caminho mandado só confere
    const p = projects.cached(projectId)
    const files = (Array.isArray(assetsToCopy) ? assetsToCopy : []).map((c) => {
      const a = p.assets.find((x) => x.id === c?.assetId)
      if (!a || a.source.type === 'session') throw new Error('Um arquivo do modelo não está no projeto; salve o projeto e tente de novo.')
      const expected = a.source.type === 'file' ? a.source.path : a.source.file
      if (c.sourcePath !== expected) throw new Error(`O arquivo “${a.name}” mudou no projeto; tente de novo.`)
      return { assetId: a.id, path: a.source.type === 'file' ? a.source.path : projects.filePath(p.id, a.source.file) }
    })
    return brand.save(template, files)
  })
  ipcMain.handle(IPC.brand.remove, (_e, id: string) => brand.remove(String(id)))
  ipcMain.handle(IPC.brand.rename, (_e, id: string, name: string) => brand.rename(String(id), String(name ?? '')))
  ipcMain.handle(IPC.brand.materialize, async (_e, templateId: string, projectId: string) => {
    projects.cached(projectId) // lança cedo se o projeto não existe
    const t = brand.get(String(templateId))
    const out: { assetId: string; asset: Asset }[] = []
    for (const a of t.assets) {
      // cópia própria do projeto (apagar o modelo não quebra nada); o mesmo modelo aplicado de novo reusa o arquivo
      const ext = extname(a.file).replace(/[^\w.]/g, '').slice(0, 10)
      const rel = `generated/brand-${t.id}-${a.id}${ext}`
      const dest = projects.filePath(projectId, rel)
      if (!existsSync(dest)) {
        await fsp.mkdir(dirname(dest), { recursive: true })
        const tmp = `${dest}.part`
        try {
          await fsp.copyFile(brand.assetPath(t.id, a.id), tmp)
          renameSync(tmp, dest)
        } catch (e) {
          rmSync(tmp, { force: true })
          throw new Error(`Não foi possível copiar “${a.name}” do modelo: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      const asset: Asset = { ...assetFromInfo(newId('a_'), dest, statSync(dest), await probe(dest)), name: a.name, source: { type: 'generated', file: rel } }
      out.push({ assetId: a.id, asset })
    }
    projects.cacheAssets(projectId, out.map((x) => x.asset))
    return out
  })

  // ---- legendas (SRT) ----
  // QA (só fora do pacote, com CIALIGHT_QA): CIALIGHT_QA_SRT_OPEN/CIALIGHT_QA_SRT_SAVE trocam os diálogos por caminhos
  // fixos de teste (test-out/) — o resto (leitura com detecção de codificação, gravação com BOM) é o caminho real
  const qaSrt = (k: 'CIALIGHT_QA_SRT_OPEN' | 'CIALIGHT_QA_SRT_SAVE'): string | undefined => (!app.isPackaged && process.env.CIALIGHT_QA ? process.env[k] || undefined : undefined)
  const SRT_MAX_BYTES = 20 * 1024 * 1024
  ipcMain.handle(IPC.captions.openSrt, async (e) => {
    let file = qaSrt('CIALIGHT_QA_SRT_OPEN')
    if (!file) {
      const w = BrowserWindow.fromWebContents(e.sender) ?? undefined
      const opts: Electron.OpenDialogOptions = { title: 'Importar legendas (SRT)', properties: ['openFile'], filters: [{ name: 'Legendas SRT', extensions: ['srt'] }] }
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths[0]) return null
      file = r.filePaths[0]
    }
    const st = await fsp.stat(file)
    if (st.size > SRT_MAX_BYTES) throw new Error('O arquivo é grande demais para ser um SRT (mais de 20 MB).')
    return { text: decodeSrtBytes(new Uint8Array(await fsp.readFile(file))), name: basename(file) }
  })
  ipcMain.handle(IPC.captions.saveSrt, async (e, text: string, defaultName: string) => {
    if (typeof text !== 'string') throw new Error('conteúdo inválido')
    let file = qaSrt('CIALIGHT_QA_SRT_SAVE')
    if (!file) {
      let name = sanitizeFileName(String(defaultName ?? '').trim()) || 'Legendas'
      if (!/\.srt$/i.test(name)) name = `${name}.srt`
      const w = BrowserWindow.fromWebContents(e.sender) ?? undefined
      const opts: Electron.SaveDialogOptions = { title: 'Exportar legendas (SRT)', defaultPath: join(outputDir(), name), filters: [{ name: 'Legendas SRT', extensions: ['srt'] }] }
      const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
      if (r.canceled || !r.filePath) return null
      file = r.filePath
    }
    await fsp.writeFile(file, encodeSrtFile(text))
    return file
  })
  ipcMain.handle(IPC.captions.writeSrtBeside, async (_e, videoPath: string, text: string) => {
    if (typeof text !== 'string') throw new Error('conteúdo inválido')
    // só ao lado de um vídeo que esta sessão acabou de exportar (nunca um caminho arbitrário vindo do renderer)
    if (!editorExports.isCompletedOutput(videoPath)) throw new Error('O arquivo .srt só pode ser gravado ao lado de um vídeo exportado agora.')
    // nunca sobrescreve: `<nome>.srt` existente → aviso (a exportação com reserveSrt já evita esse nome); um uso só
    const r = await writeSrtBesideFile(videoPath, text)
    if (r.path) editorExports.consumeCompletedOutput(videoPath)
    return r
  })

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
