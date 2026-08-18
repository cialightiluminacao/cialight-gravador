import type { IpcApi } from '@shared/ipc'
import type { RecordingConfig } from '@shared/types'
import { DEFAULT_PIP } from '@shared/defaults'
import { RecordingEngine } from '../engine/RecordingEngine'

// Teste de integração (CIALIGHT_TEST=capture): grava 9 s do monitor principal com
// loopback + microfone + câmera padrão (se houver), pausa 2 s no meio, move a PiP,
// e devolve a sessão ao main, que valida com ffprobe.

declare global {
  interface Window {
    __captureTestSend?: (r: unknown) => void
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function runCaptureTest(api: IpcApi): Promise<void> {
  const report: Record<string, unknown> = { warnings: [] as string[], errors: [] as string[] }
  const send = (ok: boolean): void => {
    // canal direto (não faz parte da IpcApi): o preload não o expõe, então usamos um evento customizado
    // que o main escuta via webContents 'ipc-message'? Não — usamos api.session.save + um marcador simples:
    window.__captureTestSend?.({ ok, report })
  }
  try {
    const src = await api.sources.list()
    const screen = src.screens.find((s) => src.displays.find((d) => d.id === s.displayId)?.isPrimary) ?? src.screens[0]
    if (!screen) throw new Error('nenhuma tela')
    const devices = await navigator.mediaDevices.enumerateDevices()
    const cam = devices.find((d) => d.kind === 'videoinput')
    const mic = devices.find((d) => d.kind === 'audioinput')
    const config: RecordingConfig = {
      source: { kind: 'screen', id: screen.id, name: screen.name, displayId: screen.displayId },
      quality: '1080p',
      fps: 30,
      countdownSec: 0,
      webcam: cam ? { deviceId: cam.deviceId, label: cam.label, mirrored: true } : null,
      mic: mic ? { deviceId: mic.deviceId, label: mic.label, echoCancellation: false, noiseSuppression: true, autoGainControl: true } : null,
      systemAudio: true,
      pipInitial: DEFAULT_PIP
    }
    report.config = config
    const engine = new RecordingEngine(api)
    engine.on((e) => {
      if (e.type === 'warning') (report.warnings as string[]).push(e.message)
      if (e.type === 'error') (report.errors as string[]).push(e.message)
    })
    const prepared = await engine.prepare(config)
    report.video = prepared.video
    report.hasCam = !!prepared.cam
    report.hasMic = !!prepared.mic
    report.hasSystem = !!prepared.systemAudioTrack
    await engine.start()
    await sleep(2000)
    engine.addPipKeyframe({ x: 0.05, y: 0.05, w: 0.2, h: DEFAULT_PIP.h, shape: 'rounded', visible: true })
    await sleep(1000)
    engine.pause()
    await sleep(2000)
    engine.resume()
    await sleep(1000)
    engine.setMicMuted(true)
    await sleep(1000)
    engine.setMicMuted(false)
    engine.upsertStroke({ id: 't1', tMs: engine.mediaTimeMs(), tool: 'arrow', points: [{ x: 0.2, y: 0.2, tMs: engine.mediaTimeMs() }, { x: 0.6, y: 0.6, tMs: engine.mediaTimeMs() + 300 }], color: '#ff3b30', width: 6 })
    await sleep(2000)
    const session = await engine.stop()
    report.session = session
    report.expectedDurationMs = 7000
    send(true)
  } catch (e) {
    ;(report.errors as string[]).push(e instanceof Error ? `${e.name}: ${e.message}` : String(e))
    send(false)
  }
}
