import { BrowserWindow } from 'electron'
import { getSettings } from '../settings/settingsStore'
import { log } from '../log'

// WDA_EXCLUDEFROMCAPTURE: janelas do app somem de qualquer captura de tela
// (Win10 2004+). setOpacity(1.0) antes é o workaround do electron#47834.
// Só durante contagem/gravação; opção desligável (acesso remoto RustDesk/RDP
// deixa de ver as janelas protegidas).

let active = false

export function applyProtectionTo(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  try {
    win.setOpacity(1.0)
    win.setContentProtection(active && getSettings().protectWindows)
  } catch (e) {
    log.warn('setContentProtection falhou', e)
  }
}

export function setProtection(on: boolean): void {
  active = on
  for (const w of BrowserWindow.getAllWindows()) applyProtectionTo(w)
  log.info(`proteção das janelas: ${on ? 'ligada' : 'desligada'} (settings.protectWindows=${getSettings().protectWindows})`)
}

export function isProtectionActive(): boolean {
  return active
}
