import { app, BrowserWindow, dialog, powerMonitor, shell } from 'electron'
import { IPC } from '@shared/ipc'
import { registerFileProtocolScheme, installFileProtocol } from './fileProtocol'
import { runSpike } from './spike/spikeMain'
import { runEditorSpike } from './spike/editorSpikeMain'
import { createRecorderWindow, getRecorderWindow, setQuitting, showRecorder } from './windows/recorderWindow'
import { installDisplayMediaHandler } from './capture/displayMediaHandler'
import { listDisplays } from './capture/sources'
import { SessionStore } from './session/sessionStore'
import { getSettings, rawDir } from './settings/settingsStore'
import { registerIpc } from './ipc'
import { applyHotkeys, onHotkeyStatus, unregisterAllHotkeys } from './hotkeys/globalShortcuts'
import { createTray } from './tray'
import { initAutoUpdater, check as updateCheck, stopUpdater } from './update/autoUpdater'
import { isRecordingActive, setCommandSink, setPhaseValue } from './recording/state'
import { setProtection } from './windows/protection'
import { destroyOverlays, watchDisplayChanges } from './windows/overlayWindows'
import { destroyBar } from './windows/barWindow'
import { log } from './log'
import { runIntegrationTest } from './testMode'

// Bootstrap do processo principal.

app.setAppUserModelId('com.cialight.gravador')
registerFileProtocolScheme()

// Spike F0 do editor: decoders WebCodecs inativos não são recuperados pelo Chromium.
const editorSpikeFlag = process.env.CIALIGHT_SPIKE === 'editor' && !process.env.CIALIGHT_SPIKE_NOFLAG
if (editorSpikeFlag) app.commandLine.appendSwitch('disable-features', 'ReclaimInactiveWebCodecs')

// QA/testes rodam em paralelo (várias instâncias): sem lock nesses modos
const gotLock = process.env.CIALIGHT_SHOT || process.env.CIALIGHT_TEST || process.env.CIALIGHT_SPIKE === 'editor' ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showRecorder())

  app.whenReady().then(async () => {
    log.info(`CiaLight Gravador ${app.getVersion()} — Electron ${process.versions.electron}, Chromium ${process.versions.chrome}`)
    if (process.env.CIALIGHT_SPIKE === 'editor') {
      void runEditorSpike(editorSpikeFlag)
      return
    }
    if (process.env.CIALIGHT_SPIKE) {
      void runSpike()
      return
    }

    const store = new SessionStore({ rawRoot: rawDir, trash: (p) => shell.trashItem(p), log })
    installFileProtocol(store)
    installDisplayMediaHandler()
    registerIpc(store)

    setCommandSink((cmd) => {
      const w = getRecorderWindow()
      if (!w) {
        // sem janela (fechada em idle): recria e reenvia quando carregar
        const nw = createRecorderWindow()
        nw.webContents.once('did-finish-load', () => nw.webContents.send(IPC.recording.command, cmd))
        return
      }
      w.webContents.send(IPC.recording.command, cmd)
    })

    if (process.env.CIALIGHT_TEST) {
      await runIntegrationTest(process.env.CIALIGHT_TEST, store)
      return
    }

    const win = createRecorderWindow()
    createTray({
      openSettings: () => {
        showRecorder()
        void getRecorderWindow()?.webContents.executeJavaScript('window.__navigate && window.__navigate("settings")', true).catch(() => {})
      },
      checkUpdate: () => void updateCheck(true),
      quit: () => app.quit()
    })
    onHotkeyStatus((s) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send(IPC.hotkeys.statusChanged, s)
    })
    applyHotkeys(getSettings().hotkeys)
    watchDisplayChanges(listDisplays)
    initAutoUpdater({
      isRecording: isRecordingActive,
      onStatus: (s) => {
        for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send(IPC.update.statusChanged, s)
      }
    })

    // QA visual: CIALIGHT_SHOT=<arquivo.png> [CIALIGHT_SCREEN=settings|history] captura a janela e sai
    if (process.env.CIALIGHT_SHOT) {
      const size = /^(\d+)x(\d+)$/.exec(process.env.CIALIGHT_SHOT_SIZE ?? '')
      if (size) win.setSize(Number(size[1]), Number(size[2]))
      win.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          if (process.env.CIALIGHT_SCREEN) await win.webContents.executeJavaScript(`window.__navigate && window.__navigate(${JSON.stringify(process.env.CIALIGHT_SCREEN)})`, true).catch(() => {})
          await new Promise((r) => setTimeout(r, 1200))
          const img = await win.webContents.capturePage()
          const { writeFileSync } = await import('fs')
          writeFileSync(process.env.CIALIGHT_SHOT!, img.toPNG())
          log.info(`screenshot salvo em ${process.env.CIALIGHT_SHOT}`)
          if (process.env.CIALIGHT_SHOT_QUIT !== '0') app.exit(0)
          // QA contínua: CIALIGHT_SHOT_EVERY=<ms> captura periodicamente (nome-N.png) enquanto o app roda
          const every = Number(process.env.CIALIGHT_SHOT_EVERY ?? 0)
          if (every > 0) {
            let n = 0
            setInterval(async () => {
              const w = getRecorderWindow()
              if (!w || w.isDestroyed()) return
              try {
                const shot = await w.webContents.capturePage()
                writeFileSync(process.env.CIALIGHT_SHOT!.replace(/\.png$/i, `-${++n}.png`), shot.toPNG())
              } catch (e) {
                log.warn('screenshot periódico falhou', e)
              }
            }, every)
          }
        }, 2500)
      })
    }

    // Recuperação de sessões interrompidas
    win.webContents.once('did-finish-load', () => {
      const unfinished = store.findUnfinished()
      if (unfinished.length) {
        log.info(`sessões interrompidas: ${unfinished.map((s) => s.id).join(', ')}`)
        win.webContents.send(IPC.recording.recover, unfinished)
      }
      // limpeza de brutos antigos
      const days = getSettings().rawRetentionDays
      if (days) void store.cleanupOld(days).then((n) => n && log.info(`limpeza: ${n} sessão(ões) antigas enviadas à lixeira`))
    })

    powerMonitor.on('shutdown', () => {
      log.warn('desligamento do sistema durante execução')
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createRecorderWindow()
    })
  })

  app.on('before-quit', (e) => {
    if (isRecordingActive() && !process.env.CIALIGHT_TEST) {
      const r = dialog.showMessageBoxSync({
        type: 'warning',
        buttons: ['Continuar gravando', 'Sair e descartar'],
        defaultId: 0,
        cancelId: 0,
        title: 'CiaLight Gravador',
        message: 'Há uma gravação em andamento.',
        detail: 'Se sair agora, a gravação bruta fica salva até o último segundo gravado e pode ser recuperada na próxima abertura.'
      })
      if (r === 0) {
        e.preventDefault()
        return
      }
    }
    setQuitting(true)
    setPhaseValue('idle')
    setProtection(false)
    unregisterAllHotkeys()
    stopUpdater()
    destroyOverlays()
    destroyBar()
  })

  app.on('window-all-closed', () => {
    // fecha o app quando a janela principal é fechada em modo ocioso (barra/overlay não contam: são destruídas junto)
    if (!isRecordingActive()) app.quit()
  })
}
