import { app, Notification } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { existsSync } from 'fs'
import { join } from 'path'
import type { UpdateStatus } from '@shared/ipc'
import { log } from '../log'
import { showRecorder } from '../windows/recorderWindow'

// Auto-update via GitHub Releases (repo público → sem token no cliente).
// Download manual (autoDownload=false) para o usuário decidir; instala ao sair
// (autoInstallOnAppQuit) ou no botão "Reiniciar e atualizar". Nunca durante gravação.

const CHECK_INTERVAL_MS = 60 * 60 * 1000
const FIRST_CHECK_DELAY_MS = 10_000

let status: UpdateStatus = { state: 'idle', currentVersion: app.getVersion() }
let onStatus: ((s: UpdateStatus) => void) | null = null
let isRecording: () => boolean = () => false
let timer: NodeJS.Timeout | null = null
let initialized = false
let manualCheck = false

function emit(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch, currentVersion: app.getVersion() }
  onStatus?.(status)
}

function notesOf(info: UpdateInfo): string | undefined {
  if (!info.releaseNotes) return undefined
  if (typeof info.releaseNotes === 'string') return info.releaseNotes
  return info.releaseNotes.map((n) => (typeof n === 'string' ? n : n.note ?? '')).join('\n')
}

export function initAutoUpdater(opts: { isRecording: () => boolean; onStatus: (s: UpdateStatus) => void }): void {
  if (initialized) return
  initialized = true
  isRecording = opts.isRecording
  onStatus = opts.onStatus

  autoUpdater.logger = log
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false

  // Em dev, permite testar contra uma release real com dev-app-update.yml + CIALIGHT_UPDATE_TEST=1
  if (!app.isPackaged) {
    const devCfg = join(app.getAppPath(), 'dev-app-update.yml')
    if (process.env.CIALIGHT_UPDATE_TEST === '1' && existsSync(devCfg)) {
      autoUpdater.forceDevUpdateConfig = true
      log.info('auto-update em modo de teste (dev-app-update.yml)')
    } else {
      log.info('auto-update desativado em dev')
      return
    }
  }

  autoUpdater.on('checking-for-update', () => emit({ state: 'checking', error: undefined }))
  autoUpdater.on('update-available', (info) => emit({ state: 'available', version: info.version, notes: notesOf(info), percent: 0 }))
  autoUpdater.on('update-not-available', () => emit({ state: 'not-available', version: undefined }))
  autoUpdater.on('download-progress', (p) => emit({ state: 'downloading', percent: Math.round(p.percent), bytesTotal: p.total }))
  autoUpdater.on('update-downloaded', (info) => {
    emit({ state: 'downloaded', version: info.version, notes: notesOf(info), percent: 100 })
    if (Notification.isSupported()) {
      const n = new Notification({ title: 'CiaLight Gravador', body: `Versão ${info.version} pronta para instalar. Clique para abrir.` })
      n.on('click', () => showRecorder())
      n.show()
    }
  })
  autoUpdater.on('error', (e) => {
    log.warn('auto-update erro', e)
    // checagens automáticas falham silenciosamente (sem internet, sem release ainda);
    // só a verificação manual mostra o erro na UI
    if (manualCheck || status.state === 'downloading') emit({ state: 'error', error: e?.message ?? String(e) })
    else emit({ state: 'idle', error: undefined })
  })

  setTimeout(() => void check(false), FIRST_CHECK_DELAY_MS)
  timer = setInterval(() => void check(false), CHECK_INTERVAL_MS)
}

export async function check(manual: boolean): Promise<void> {
  if (!initialized) return
  if (isRecording()) {
    log.info('check de update adiado: gravando')
    return
  }
  if (status.state === 'downloading' || status.state === 'downloaded') return
  manualCheck = manual
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    if (manual) emit({ state: 'error', error: e instanceof Error ? e.message : String(e) })
    else emit({ state: 'idle' })
  } finally {
    manualCheck = false
  }
}

export async function download(): Promise<void> {
  if (!initialized) return
  if (status.state !== 'available') return
  emit({ state: 'downloading', percent: 0 })
  try {
    await autoUpdater.downloadUpdate()
  } catch (e) {
    emit({ state: 'error', error: e instanceof Error ? e.message : String(e) })
  }
}

export function install(): void {
  if (status.state !== 'downloaded') return
  if (isRecording()) {
    emit({ state: 'downloaded', error: 'Termine a gravação antes de atualizar.' })
    return
  }
  log.info('quitAndInstall')
  setImmediate(() => autoUpdater.quitAndInstall(true, true))
}

export function getUpdateStatus(): UpdateStatus {
  return { ...status, currentVersion: app.getVersion() }
}

export function stopUpdater(): void {
  if (timer) clearInterval(timer)
  timer = null
}
