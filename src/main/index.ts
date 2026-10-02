import { app, BrowserWindow, dialog, powerMonitor, shell } from 'electron'
import { IPC } from '@shared/ipc'
import { registerFileProtocolScheme, installFileProtocol } from './fileProtocol'
import { runSpike } from './spike/spikeMain'
import { runEditorSpike } from './spike/editorSpikeMain'
import { createRecorderWindow, editorNeedsFlush, flushEditor, getRecorderWindow, setQuitting, showRecorder } from './windows/recorderWindow'
import { installDisplayMediaHandler } from './capture/displayMediaHandler'
import { listDisplays } from './capture/sources'
import { dirname, join } from 'path'
import { existsSync } from 'fs'
import { SessionStore } from './session/sessionStore'
import { ProjectStore } from './project/projectStore'
import { getSettings, outputDir, rawDir } from './settings/settingsStore'
import { sweepStaleParts, type SweepTarget } from './maintenance/partSweep'
import { runWhenIdle } from './maintenance/whenIdle'
import { hasActiveExportJobs } from './export/exportJob'
import { cachedEncoderProbe, probeEncoders } from './export/encoderProbe'
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
import { createQaEditorFixture } from './qaEditorFixture'
import { confirmQuit, createQuitGuard, isEditorExportBusy, setAppQuitGuard, type QuitReason } from './quitGuard'

// Bootstrap do processo principal.

const MAINTENANCE_DELAY_MS = 15_000
/** Gravando/exportando, o probe de encoders da manutenção espera e confere de novo neste intervalo. */
const MAINTENANCE_RETRY_MS = 60_000

app.setAppUserModelId('com.cialight.gravador')
registerFileProtocolScheme()

// Editor: decoders WebCodecs inativos não devem ser recuperados pelo Chromium (o DecoderPool ainda
// recria por precaução). Vale para o app normal; o spike F0 pode medir sem a flag (CIALIGHT_SPIKE_NOFLAG).
// Spikes de medição: só fora do pacote (o instalador não leva as páginas deles)
const spikeMode = app.isPackaged ? undefined : process.env.CIALIGHT_SPIKE
const reclaimFlag = !(spikeMode === 'editor' && process.env.CIALIGHT_SPIKE_NOFLAG)
if (reclaimFlag) app.commandLine.appendSwitch('disable-features', 'ReclaimInactiveWebCodecs')

// Teste da narração (CIALIGHT_TEST=editor-narration, só fora do pacote; scripts/qa/editor-f3-narration.mjs): microfone
// falso do Chromium (o WAV de CIALIGHT_FAKE_AUDIO, se houver; senão o bipe padrão) sem pedir permissão, e o app normal
// para o script CDP conduzir. Nunca no app normal.
const narrationTest = !app.isPackaged && process.env.CIALIGHT_TEST === 'editor-narration'
if (narrationTest) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
  if (process.env.CIALIGHT_FAKE_AUDIO) app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.CIALIGHT_FAKE_AUDIO)
}

// QA/testes rodam em paralelo (várias instâncias): sem lock nesses modos
const gotLock = process.env.CIALIGHT_SHOT || process.env.CIALIGHT_TEST || (process.env.CIALIGHT_QA && !app.isPackaged) || spikeMode === 'editor' ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showRecorder())

  const QUIT_DIALOG: Record<QuitReason, { buttons: string[]; message: string; detail: string }> = {
    recording: {
      buttons: ['Continuar gravando', 'Sair e descartar'],
      message: 'Há uma gravação em andamento.',
      detail: 'Se sair agora, a gravação bruta fica salva até o último segundo gravado e pode ser recuperada na próxima abertura.'
    },
    export: {
      buttons: ['Continuar exportando', 'Sair e cancelar'],
      message: 'Há uma exportação do editor em andamento.',
      detail: 'Se sair agora, a exportação é cancelada e o arquivo parcial é apagado.'
    }
  }
  setAppQuitGuard(
    createQuitGuard({
      isRecording: isRecordingActive,
      isExporting: isEditorExportBusy,
      enabled: () => !process.env.CIALIGHT_TEST,
      ask: (reason) => {
        const d = QUIT_DIALOG[reason]
        // sem janela-mãe: gravando, a janela do gravador pode estar oculta (e o diálogo junto)
        return dialog.showMessageBoxSync({ type: 'warning', buttons: d.buttons, defaultId: 0, cancelId: 0, title: 'CiaLight Gravador', message: d.message, detail: d.detail }) === 1
      }
    })
  )

  app.whenReady().then(async () => {
    log.info(`CiaLight Gravador ${app.getVersion()} — Electron ${process.versions.electron}, Chromium ${process.versions.chrome}`)
    if (spikeMode === 'editor') {
      void runEditorSpike(reclaimFlag)
      return
    }
    if (spikeMode) {
      void runSpike()
      return
    }

    const store = new SessionStore({ rawRoot: rawDir, trash: (p) => shell.trashItem(p), log })
    // Projetos ficam ao lado dos brutos (<brutos>\..\Projetos); calculado a cada uso porque rawDir pode mudar nas Configurações.
    const projects = new ProjectStore({
      projectsRoot: () => join(dirname(rawDir()), 'Projetos'),
      trash: (p) => shell.trashItem(p),
      log,
      // assets de gravação: sem o rec.mp4 (gravação apagada) o editor mostra "mídia indisponível"
      sessionMediaExists: (id) => {
        try {
          return existsSync(store.filePath(id, 'rec.mp4'))
        } catch {
          return false
        }
      },
      // impressão digital da fonte do áudio processado dos assets de gravação
      sessionMediaFile: (id) => store.filePath(id, 'rec.mp4')
    })
    installFileProtocol(store, projects)
    installDisplayMediaHandler()
    registerIpc(store, projects)

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

    if (process.env.CIALIGHT_TEST && !narrationTest) {
      await runIntegrationTest(process.env.CIALIGHT_TEST, store, projects)
      return
    }

    // QA visual do editor (fora do pacote): projeto de teste com mídia gerada; abrir com __navigate('editor:<id>')
    if (process.env.CIALIGHT_QA === 'editor-fixture' && !app.isPackaged) {
      await createQaEditorFixture(projects, join(app.getAppPath(), 'test-out')).catch((e) => log.error('QA: falha ao criar o projeto de teste', e))
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
      // manutenção fora do caminho de abertura (o app já está na tela)
      setTimeout(() => void runMaintenance(), MAINTENANCE_DELAY_MS)
    })

    /**
     * Manutenção adiada: limpeza de brutos antigos (nunca as gravações que algum projeto do editor usa),
     * .part com mais de 1 dia (proxies/cache dos projetos e exportação na pasta de saída) e o probe de
     * encoders quando o cache não vale mais (probe antigo, sem a validação com os argumentos reais) — este só
     * com o app ocioso: o encode-teste disputa a GPU com a gravação e as exportações (v1 e editor).
     */
    const runMaintenance = async (): Promise<void> => {
      const days = getSettings().rawRetentionDays
      if (days) {
        try {
          const used = projects.sessionUsage()
          const n = await store.cleanupOld(days, (id) => used.has(id))
          if (n) log.info(`limpeza: ${n} sessão(ões) antigas enviadas à lixeira`)
        } catch (e) {
          log.warn('limpeza de brutos falhou', e)
        }
      }
      try {
        const targets: SweepTarget[] = [{ dir: outputDir(), kind: 'export' }]
        for (const dir of projects.projectDirs()) targets.push({ dir: join(dir, 'proxies'), kind: 'ingest' }, { dir: join(dir, 'cache'), kind: 'ingest' })
        const removed = await sweepStaleParts(targets, { log })
        if (removed.length) log.info(`limpeza: ${removed.length} temporário(s) .part antigo(s) apagado(s)`)
      } catch (e) {
        log.warn('limpeza de temporários falhou', e)
      }
      if (!cachedEncoderProbe() && !process.env.CIALIGHT_SHOT && !process.env.CIALIGHT_QA) {
        let told = false
        await runWhenIdle(
          async () => {
            if (cachedEncoderProbe()) return // uma exportação v1 já fez o probe enquanto esperávamos
            await probeEncoders(false).catch((e) => log.warn('probe de encoders falhou', e))
          },
          {
            isBusy: () => isRecordingActive() || isEditorExportBusy() || hasActiveExportJobs(),
            retryMs: MAINTENANCE_RETRY_MS,
            onPostpone: () => {
              if (!told) log.info('probe de encoders adiado: gravação ou exportação em andamento')
              told = true
            }
          }
        )
      }
    }

    powerMonitor.on('shutdown', () => {
      log.warn('desligamento do sistema durante execução')
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createRecorderWindow()
    })
  })

  app.on('before-quit', (e) => {
    // gravação/exportação em andamento: pergunta uma vez por saída (o flush do editor e o cancelamento
    // da exportação refazem o app.quit() e passam por aqui de novo)
    if (!confirmQuit()) {
      e.preventDefault()
      return
    }
    // editor aberto: grava o pendente (transação, autosave) e só então sai de verdade
    if (editorNeedsFlush()) {
      e.preventDefault()
      void flushEditor().then(() => app.quit())
      return
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
