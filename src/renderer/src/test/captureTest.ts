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
    __captureTestCursorClick?: (r: { button: 'left' | 'right' | 'middle'; x: number; y: number }) => Promise<number | null>
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Cobre a janela com uma cor sólida (o main procura o "flash" no vídeo para medir relógio × PTS) e anima um canto. */
function flashLayer(): { set: (color: 'green' | 'black') => number; painted: { id: string; renderTime: number }[]; dispose: () => void } {
  const el = document.createElement('div')
  el.style.cssText = 'position:fixed;inset:0;background:#000;z-index:2147483647'
  const tick = document.createElement('div')
  tick.style.cssText = 'position:absolute;left:8px;top:8px;width:24px;height:24px;background:#888'
  el.appendChild(tick)
  document.body.appendChild(el)
  let raf = 0
  const loop = (t: number): void => {
    tick.style.transform = `translateX(${Math.round((t / 10) % 200)}px)`
    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)
  // Element Timing: renderTime = instante em que o texto novo foi apresentado na tela (separa a latência de pintura
  // da latência da captura na medição relógio × PTS)
  const painted: { id: string; renderTime: number }[] = []
  let obs: PerformanceObserver | null = null
  try {
    obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & { identifier?: string; renderTime?: number })[]) painted.push({ id: e.identifier ?? '', renderTime: e.renderTime ?? 0 })
    })
    obs.observe({ type: 'element', buffered: true })
  } catch {
    obs = null
  }
  let n = 0
  return {
    painted,
    set: (color) => {
      const t = document.createElement('div')
      t.setAttribute('elementtiming', `flash-${++n}`)
      t.textContent = `flash ${n}`
      t.style.cssText = 'position:absolute;right:8px;bottom:8px;color:#444;font:12px sans-serif'
      el.appendChild(t)
      el.style.background = color === 'green' ? '#00ff00' : '#000000'
      return performance.now()
    },
    dispose: () => {
      cancelAnimationFrame(raf)
      obs?.disconnect()
      el.remove()
    }
  }
}

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
    const layer = flashLayer()
    const flashes: { mediaMs: number; color: 'green' | 'black'; wallMs: number }[] = []
    report.flashPaints = layer.painted
    report.flashes = flashes
    const cursorClicks: { x: number; y: number; rendererMediaMs: number; mainMediaMs: number | null }[] = []
    report.cursorClicks = cursorClicks
    const primary = src.displays.find((d) => d.id === screen.displayId) ?? src.displays[0]
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
    // medição (F6): instante do 1º dado de mídia do Output (PTS 0, "synced-zero" do mediabunny) × início do relógio de
    // mídia — campos internos, só para o relatório do teste
    const internals = engine as unknown as { output?: { _firstMediaStreamTimestamp?: number | null }; recorder?: { clock: { startedAtMs: number } } }
    const clockVsPts = (): { clockStartMs: number | null; firstMediaMs: number | null } => {
      const sec = internals.output?._firstMediaStreamTimestamp ?? null
      return { clockStartMs: internals.recorder?.clock.startedAtMs ?? null, firstMediaMs: sec === null ? null : sec * 1000 }
    }
    await sleep(2000)
    engine.addPipKeyframe({ x: 0.05, y: 0.05, w: 0.2, h: DEFAULT_PIP.h, shape: 'rounded', visible: true })
    report.clockVsPts = clockVsPts()
    {
      const wallMs = layer.set('green')
      flashes.push({ mediaMs: engine.mediaTimeMs(), color: 'green', wallMs })
    }
    await sleep(1000)
    engine.pause()
    await sleep(2000)
    engine.resume()
    await sleep(1000)
    // clique sintético (F6) num ponto conhecido do monitor gravado: mesmo pipeline do main, sem input do SO
    if (primary && window.__captureTestCursorClick) {
      const x = Math.round(primary.bounds.x + primary.bounds.width * 0.3)
      const y = Math.round(primary.bounds.y + primary.bounds.height * 0.4)
      const rendererMediaMs = engine.mediaTimeMs()
      const mainMediaMs = await window.__captureTestCursorClick({ button: 'left', x, y })
      cursorClicks.push({ x, y, rendererMediaMs, mainMediaMs })
    }
    {
      const wallMs = layer.set('black')
      flashes.push({ mediaMs: engine.mediaTimeMs(), color: 'black', wallMs })
    }
    engine.setMicMuted(true)
    await sleep(1000)
    engine.setMicMuted(false)
    engine.upsertStroke({ id: 't1', tMs: engine.mediaTimeMs(), tool: 'arrow', points: [{ x: 0.2, y: 0.2, tMs: engine.mediaTimeMs() }, { x: 0.6, y: 0.6, tMs: engine.mediaTimeMs() + 300 }], color: '#ff3b30', width: 6 })
    await sleep(2000)
    const session = await engine.stop()
    layer.dispose()
    report.session = session
    report.expectedDurationMs = 7000
    send(true)
  } catch (e) {
    ;(report.errors as string[]).push(e instanceof Error ? `${e.name}: ${e.message}` : String(e))
    send(false)
  }
}
