import { BrowserWindow, shell } from 'electron'
import { join } from 'path'

export function rendererUrl(page: string): { url?: string; file?: string } {
  if (process.env.ELECTRON_RENDERER_URL) return { url: `${process.env.ELECTRON_RENDERER_URL}/${page}` }
  return { file: join(__dirname, `../renderer/${page}`) }
}

export function loadPage(win: BrowserWindow, page: string): void {
  const target = rendererUrl(page)
  if (target.url) void win.loadURL(target.url)
  else void win.loadFile(target.file!)
}

export function createRecorderWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'CiaLight Gravador',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false
    }
  })
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  loadPage(win, 'index.html')
  return win
}
