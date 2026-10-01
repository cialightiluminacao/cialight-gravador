import { BrowserWindow, ipcMain, shell, screen } from 'electron'
import { IPC } from '@shared/ipc'
import { join } from 'path'
import { getPhase } from '../recording/state'
import { log } from '../log'

let recorderWin: BrowserWindow | null = null
let quitting = false

export function rendererUrl(page: string): { url?: string; file?: string; query?: string; hash?: string } {
  const [path, hash] = page.split('#')
  const [file, query] = path.split('?')
  if (process.env.ELECTRON_RENDERER_URL) return { url: `${process.env.ELECTRON_RENDERER_URL}/${page}` }
  return { file: join(__dirname, `../renderer/${file}`), query, hash }
}

export function loadPage(win: BrowserWindow, page: string): void {
  const target = rendererUrl(page)
  if (target.url) void win.loadURL(target.url)
  else void win.loadFile(target.file!, target.query || target.hash ? { ...(target.query ? { search: `?${target.query}` } : {}), ...(target.hash ? { hash: target.hash } : {}) } : undefined)
}

export function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}

export function setQuitting(v: boolean): void {
  quitting = v
}

export function getRecorderWindow(): BrowserWindow | null {
  return recorderWin && !recorderWin.isDestroyed() ? recorderWin : null
}

export function createRecorderWindow(): BrowserWindow {
  const existing = getRecorderWindow()
  if (existing) return existing
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'CiaLight Gravador',
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0d12', symbolColor: '#c8c9cf', height: 40 },
    webPreferences: {
      preload: preloadPath(),
      sandbox: false,
      backgroundThrottling: false,
      additionalArguments: ['--cialight-window=recorder']
    }
  })
  recorderWin = win
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Durante gravação/contagem, fechar = esconder (a gravação continua em segundo plano).
  win.on('close', (e) => {
    const phase = getPhase()
    if (!quitting && (phase === 'recording' || phase === 'paused' || phase === 'countdown' || phase === 'stopping')) {
      e.preventDefault()
      win.hide()
      log.info('janela do gravador escondida durante a gravação')
      return
    }
    // editor aberto: grava o pendente antes de fechar (depois do flush este handler deixa passar)
    if (editorNeedsFlush()) {
      e.preventDefault()
      void flushEditor().then(() => {
        if (!win.isDestroyed()) win.close()
      })
    }
  })
  win.on('closed', () => {
    recorderWin = null
    // a próxima janela começa fora do editor
    editorOn = false
    editorFlushed = false
    preEditor = null
  })
  loadPage(win, 'index.html')
  return win
}

export function showRecorder(): void {
  const win = createRecorderWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** Move a janela do gravador para o display indicado (usado quando ela estiver no monitor gravado e houver outro). */
export function moveRecorderToDisplay(displayId: string): void {
  const win = getRecorderWindow()
  if (!win) return
  const d = screen.getAllDisplays().find((x) => String(x.id) === displayId)
  if (!d) return
  const b = win.getBounds()
  const x = d.workArea.x + Math.max(0, Math.round((d.workArea.width - b.width) / 2))
  const y = d.workArea.y + Math.max(0, Math.round((d.workArea.height - b.height) / 2))
  win.setPosition(x, y)
}

// Editor: janela maximizada enquanto ele estiver aberto; ao sair, volta ao tamanho/posição de antes
// (se o usuário já tinha maximizado, continua maximizada).
let preEditor: { bounds: Electron.Rectangle; maximized: boolean } | null = null
let editorOn = false
let editorFlushed = false // flush do fechamento em curso já feito
let flushing: Promise<void> | null = null
let flushSeq = 0
const EDITOR_FLUSH_TIMEOUT_MS = 2000

/** O editor está aberto e ainda não salvou o pendente para o fechamento em curso. */
export function editorNeedsFlush(): boolean {
  return editorOn && !editorFlushed && !!getRecorderWindow()
}

/**
 * Pede ao editor (renderer) que grave tudo o que estiver pendente; resolve com a confirmação ou após
 * 2 s (renderer travado/caído). Chamadas simultâneas compartilham o mesmo pedido.
 */
export function flushEditor(): Promise<void> {
  const win = getRecorderWindow()
  if (!win || !editorOn || editorFlushed) return Promise.resolve()
  if (!flushing) {
    flushing = new Promise<void>((resolve) => {
      const id = ++flushSeq
      const done = (): void => {
        clearTimeout(timer)
        ipcMain.removeListener(IPC.editor.flushed, onAck)
        editorFlushed = true
        flushing = null
        resolve()
      }
      const onAck = (_e: Electron.IpcMainEvent, ackId: number): void => {
        if (ackId === id) done()
      }
      const timer = setTimeout(() => {
        log.warn('editor: sem resposta ao pedido de salvar antes de fechar (2 s); fechando assim mesmo')
        done()
      }, EDITOR_FLUSH_TIMEOUT_MS)
      ipcMain.on(IPC.editor.flushed, onAck)
      win.webContents.send(IPC.editor.flush, id)
    })
  }
  return flushing
}

export function setEditorMode(on: boolean): void {
  editorOn = on
  if (on) editorFlushed = false
  const win = getRecorderWindow()
  if (!win) return
  if (on) {
    if (!preEditor) preEditor = { bounds: win.getNormalBounds(), maximized: win.isMaximized() }
    if (!win.isMaximized()) win.maximize()
    return
  }
  const prev = preEditor
  preEditor = null
  if (!prev || prev.maximized) return
  if (win.isMaximized()) win.unmaximize()
  win.setBounds(prev.bounds)
}

export function displayIdOfWindow(win: BrowserWindow): string {
  const b = win.getBounds()
  const d = screen.getDisplayMatching(b)
  return String(d.id)
}
