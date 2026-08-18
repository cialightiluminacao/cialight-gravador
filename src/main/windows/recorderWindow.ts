import { BrowserWindow, shell, screen } from 'electron'
import { join } from 'path'
import { getPhase } from '../recording/state'
import { log } from '../log'

let recorderWin: BrowserWindow | null = null
let quitting = false

export function rendererUrl(page: string): { url?: string; file?: string; query?: string } {
  const [file, query] = page.split('?')
  if (process.env.ELECTRON_RENDERER_URL) return { url: `${process.env.ELECTRON_RENDERER_URL}/${page}` }
  return { file: join(__dirname, `../renderer/${file}`), query }
}

export function loadPage(win: BrowserWindow, page: string): void {
  const target = rendererUrl(page)
  if (target.url) void win.loadURL(target.url)
  else void win.loadFile(target.file!, target.query ? { search: `?${target.query}` } : undefined)
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
    }
  })
  win.on('closed', () => {
    recorderWin = null
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

export function displayIdOfWindow(win: BrowserWindow): string {
  const b = win.getBounds()
  const d = screen.getDisplayMatching(b)
  return String(d.id)
}
