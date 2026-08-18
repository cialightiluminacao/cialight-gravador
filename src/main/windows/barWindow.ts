import { BrowserWindow, screen } from 'electron'
import type { BarState } from '@shared/ipc'
import { IPC } from '@shared/ipc'
import type { DisplayInfo } from '@shared/types'
import { getSettings, setSettings } from '../settings/settingsStore'
import { loadPage, preloadPath } from './recorderWindow'
import { applyProtectionTo } from './protection'
import { log } from '../log'

// Barra flutuante de controles: pílula sempre-no-topo no monitor gravado,
// excluída da captura, arrastável (-webkit-app-region: drag no renderer).

export const BAR_WIDTH = 460
export const BAR_HEIGHT = 64

let barWin: BrowserWindow | null = null
let currentDisplayId: string | null = null
let hiddenByUser = false

function getBar(): BrowserWindow | null {
  return barWin && !barWin.isDestroyed() ? barWin : null
}

function defaultPosition(d: DisplayInfo): { x: number; y: number } {
  return {
    x: d.workArea.x + Math.round((d.workArea.width - BAR_WIDTH) / 2),
    y: d.workArea.y + d.workArea.height - BAR_HEIGHT - 16
  }
}

function clampToDisplay(pos: { x: number; y: number }, d: DisplayInfo): { x: number; y: number } {
  return {
    x: Math.min(Math.max(pos.x, d.workArea.x), d.workArea.x + d.workArea.width - BAR_WIDTH),
    y: Math.min(Math.max(pos.y, d.workArea.y), d.workArea.y + d.workArea.height - BAR_HEIGHT)
  }
}

export function showBar(display: DisplayInfo, state: BarState | null): void {
  currentDisplayId = display.id
  hiddenByUser = false
  const saved = getSettings().barPositions[display.id]
  const pos = clampToDisplay(saved ?? defaultPosition(display), display)
  let win = getBar()
  if (!win) {
    win = new BrowserWindow({
      x: pos.x,
      y: pos.y,
      width: BAR_WIDTH,
      height: BAR_HEIGHT,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      show: false,
      focusable: false,
      webPreferences: { preload: preloadPath(), sandbox: false, backgroundThrottling: false, additionalArguments: ['--cialight-window=bar'] }
    })
    barWin = win
    win.setAlwaysOnTop(true, 'screen-saver')
    win.on('moved', () => {
      const w = getBar()
      if (!w || !currentDisplayId) return
      const [x, y] = w.getPosition()
      setSettings({ barPositions: { ...getSettings().barPositions, [currentDisplayId]: { x, y } } })
    })
    win.on('closed', () => {
      barWin = null
    })
    win.webContents.on('did-finish-load', () => {
      const w = getBar()
      if (w && state) w.webContents.send(IPC.bar.state, state)
    })
    loadPage(win, 'bar.html')
    win.once('ready-to-show', () => {
      const w = getBar()
      if (!w) return
      applyProtectionTo(w)
      w.showInactive()
    })
  } else {
    win.setPosition(pos.x, pos.y)
    applyProtectionTo(win)
    win.showInactive()
    if (state) win.webContents.send(IPC.bar.state, state)
  }
  log.info(`barra flutuante no display ${display.id} em ${pos.x},${pos.y}`)
}

export function hideBar(): void {
  getBar()?.hide()
}

export function destroyBar(): void {
  const w = getBar()
  if (w) w.destroy()
  barWin = null
}

export function toggleBar(): void {
  const w = getBar()
  if (!w) return
  if (w.isVisible()) {
    w.hide()
    hiddenByUser = true
  } else {
    w.showInactive()
    hiddenByUser = false
  }
}

export function isBarHiddenByUser(): boolean {
  return hiddenByUser
}

export function updateBar(state: BarState): void {
  const w = getBar()
  if (w && !w.webContents.isLoading()) w.webContents.send(IPC.bar.state, state)
}

export function barDisplay(): DisplayInfo | null {
  const w = getBar()
  if (!w) return null
  const d = screen.getDisplayMatching(w.getBounds())
  const all = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  const i = all.findIndex((x) => x.id === d.id)
  return { id: String(d.id), label: `Monitor ${i + 1}`, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor, isPrimary: d.id === primary.id, index: i }
}
