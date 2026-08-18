import { BrowserWindow, screen } from 'electron'
import type { OverlayModePayload } from '@shared/ipc'
import { IPC } from '@shared/ipc'
import type { DisplayInfo, Stroke } from '@shared/types'
import { loadPage, preloadPath } from './recorderWindow'
import { applyProtectionTo } from './protection'
import { log } from '../log'

// Uma overlay transparente por monitor gravado: contagem regressiva, borda
// "gravando", toasts e superfície de desenho. Click-through fora do modo
// desenho. Excluída da captura (os traços são compostos na exportação).

const overlays = new Map<string, BrowserWindow>()
let lastMode: OverlayModePayload = { mode: 'hidden' }

function createOverlay(d: DisplayInfo): BrowserWindow {
  const win = new BrowserWindow({
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    enableLargerThanScreen: true,
    webPreferences: { preload: preloadPath(), sandbox: false, backgroundThrottling: false, additionalArguments: ['--cialight-window=overlay', `--cialight-display=${d.id}`] }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  win.webContents.on('did-finish-load', () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.overlay.mode, lastMode)
  })
  loadPage(win, `overlay.html?displayId=${encodeURIComponent(d.id)}`)
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    // garante que cobre o display inteiro mesmo com DPI diferente
    win.setBounds(d.bounds)
    applyProtectionTo(win)
    win.showInactive()
  })
  win.on('closed', () => {
    for (const [id, w] of overlays) if (w === win) overlays.delete(id)
  })
  return win
}

export function showOverlays(displays: DisplayInfo[]): void {
  const wanted = new Set(displays.map((d) => d.id))
  for (const [id, w] of overlays) {
    if (!wanted.has(id)) {
      w.destroy()
      overlays.delete(id)
    }
  }
  for (const d of displays) {
    const existing = overlays.get(d.id)
    if (existing && !existing.isDestroyed()) {
      existing.setBounds(d.bounds)
      applyProtectionTo(existing)
      existing.showInactive()
      continue
    }
    overlays.set(d.id, createOverlay(d))
  }
  log.info(`overlays em: ${displays.map((d) => d.id).join(', ')}`)
}

export function hideOverlays(): void {
  lastMode = { mode: 'hidden' }
  for (const w of overlays.values()) {
    if (w.isDestroyed()) continue
    w.setIgnoreMouseEvents(true, { forward: true })
    w.setFocusable(false)
    w.hide()
  }
}

export function destroyOverlays(): void {
  for (const w of overlays.values()) if (!w.isDestroyed()) w.destroy()
  overlays.clear()
}

export function setOverlayMode(payload: OverlayModePayload): void {
  lastMode = payload
  for (const w of overlays.values()) {
    if (w.isDestroyed()) continue
    if (payload.mode === 'drawing') {
      w.setIgnoreMouseEvents(false)
      w.setFocusable(true)
      w.showInactive()
      w.focus()
    } else {
      w.setIgnoreMouseEvents(true, { forward: true })
      w.setFocusable(false)
      if (payload.mode === 'hidden') w.hide()
      else if (!w.isVisible()) w.showInactive()
    }
    if (!w.webContents.isLoading()) w.webContents.send(IPC.overlay.mode, payload)
  }
}

export function getOverlayMode(): OverlayModePayload {
  return lastMode
}

export function syncStrokesToOverlays(displayId: string | null, strokes: Stroke[]): void {
  for (const [id, w] of overlays) {
    if (displayId && id !== displayId) continue
    if (!w.isDestroyed() && !w.webContents.isLoading()) w.webContents.send(IPC.overlay.strokesSynced, strokes)
  }
}

export function overlayDisplayIds(): string[] {
  return [...overlays.keys()]
}

/** Recria overlays quando a geometria dos monitores muda durante a gravação. */
export function watchDisplayChanges(getDisplays: () => DisplayInfo[]): void {
  const rebuild = (): void => {
    if (overlays.size === 0) return
    const ids = overlayDisplayIds()
    const displays = getDisplays().filter((d) => ids.includes(d.id))
    destroyOverlays()
    if (displays.length) showOverlays(displays)
  }
  screen.on('display-metrics-changed', rebuild)
  screen.on('display-added', rebuild)
  screen.on('display-removed', rebuild)
}
