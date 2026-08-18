import { app, Menu, nativeImage, Tray } from 'electron'
import { join } from 'path'
import type { RecorderPhase } from '@shared/types'
import { broadcastCommand, getPhase, onPhase } from './recording/state'
import { showRecorder } from './windows/recorderWindow'
import { log } from './log'

// Ícone na bandeja: estado (ocioso/gravando/pausado), menu de ações rápidas.

let tray: Tray | null = null
let onOpenSettings: (() => void) | null = null
let onCheckUpdate: (() => void) | null = null
let onQuit: (() => void) | null = null

function iconFor(phase: RecorderPhase): Electron.NativeImage {
  const name = phase === 'recording' || phase === 'countdown' || phase === 'stopping' ? 'tray-rec' : phase === 'paused' ? 'tray-pause' : 'tray'
  const base = app.isPackaged ? join(process.resourcesPath, 'icons') : join(app.getAppPath(), 'resources', 'icons')
  const img = nativeImage.createFromPath(join(base, `${name}.png`))
  return img.isEmpty() ? nativeImage.createEmpty() : img
}

function buildMenu(phase: RecorderPhase): Menu {
  const active = phase === 'recording' || phase === 'paused' || phase === 'countdown'
  return Menu.buildFromTemplate([
    { label: 'Mostrar gravador', click: () => showRecorder() },
    { type: 'separator' },
    {
      label: active ? 'Parar gravação' : 'Iniciar gravação',
      accelerator: 'Ctrl+Shift+F9',
      enabled: phase !== 'stopping',
      click: () => broadcastCommand('toggleRecord')
    },
    { label: phase === 'paused' ? 'Retomar' : 'Pausar', enabled: phase === 'recording' || phase === 'paused', click: () => broadcastCommand('pauseResume') },
    { label: 'Cancelar gravação', enabled: active, click: () => broadcastCommand('cancel') },
    { type: 'separator' },
    { label: 'Configurações', click: () => onOpenSettings?.() },
    { label: 'Verificar atualização', click: () => onCheckUpdate?.() },
    { type: 'separator' },
    { label: 'Sair', click: () => onQuit?.() }
  ])
}

export function createTray(handlers: { openSettings: () => void; checkUpdate: () => void; quit: () => void }): Tray {
  onOpenSettings = handlers.openSettings
  onCheckUpdate = handlers.checkUpdate
  onQuit = handlers.quit
  tray = new Tray(iconFor('idle'))
  tray.setToolTip('CiaLight Gravador')
  tray.setContextMenu(buildMenu('idle'))
  tray.on('click', () => showRecorder())
  onPhase((phase) => {
    if (!tray) return
    tray.setImage(iconFor(phase))
    tray.setContextMenu(buildMenu(phase))
    tray.setToolTip(phase === 'recording' ? 'CiaLight Gravador — gravando' : phase === 'paused' ? 'CiaLight Gravador — pausado' : 'CiaLight Gravador')
  })
  log.info('bandeja criada')
  return tray
}

export function trayBalloon(title: string, content: string): void {
  tray?.displayBalloon({ title, content, iconType: 'info' })
}

export function refreshTrayMenu(): void {
  tray?.setContextMenu(buildMenu(getPhase()))
}
