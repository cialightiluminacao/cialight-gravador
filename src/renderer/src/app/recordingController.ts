import type { BarState, OverlayActionEvent, OverlayStrokeEvent } from '@shared/ipc'
import type { PipKeyframe, RecorderCommand, RecordingConfig, Session, Stroke, StrokeTool } from '@shared/types'
import { MIN_FREE_SPACE_MB } from '@shared/defaults'
import { RecordingEngine, type PreparedStreams } from '../engine/RecordingEngine'
import { buildRecordingConfig, useAppStore } from './store'
import { toast } from 'sonner'

// Orquestra o fluxo de gravação no renderer: prepara → contagem → grava → para → revisão.
// Fonte de verdade da fase (espelhada no main via api.recording.setPhase).
// Singleton: importado por telas e pelo App.

const api = window.api
export const engine = new RecordingEngine(api)

const store = useAppStore
let barTimer: ReturnType<typeof setInterval> | null = null
let countdownAbort: AbortController | null = null
let lastConfig: RecordingConfig | null = null
let annotating = false
let annotateTool: StrokeTool = 'pen'
let currentDisplayIds: string[] = []
let targetRect: { x: number; y: number; width: number; height: number } | null = null
const srcCtx = (): { sourceKind: 'screen' | 'window'; sourceName: string } => ({ sourceKind: lastConfig?.source.kind ?? 'screen', sourceName: lastConfig?.source.name ?? '' })
let levelMeter: LevelMeter | null = null
let unsubs: (() => void)[] = []
const PIP_CORNERS: [number, number][] = [
  [0.76, 0.62],
  [0.04, 0.62],
  [0.04, 0.04],
  [0.76, 0.04]
]
const PIP_SIZES = [0.16, 0.2, 0.28]
let pipCycle = 0

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new Error('aborted'))
    })
  })

function setPhase(p: ReturnType<typeof store.getState>['phase']): void {
  store.getState().setPhase(p)
}

/** Medidor de nível (AnalyserNode) fora do caminho de gravação. */
class LevelMeter {
  private ctx = new AudioContext()
  private analysers: { name: 'mic' | 'system'; an: AnalyserNode; buf: Uint8Array<ArrayBuffer> }[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  constructor(streams: PreparedStreams) {
    const add = (name: 'mic' | 'system', track: MediaStreamTrack | null | undefined): void => {
      if (!track) return
      const src = this.ctx.createMediaStreamSource(new MediaStream([track]))
      const an = this.ctx.createAnalyser()
      an.fftSize = 512
      an.smoothingTimeConstant = 0.6
      src.connect(an)
      this.analysers.push({ name, an, buf: new Uint8Array(an.fftSize) })
    }
    add('mic', streams.mic?.getAudioTracks()[0])
    add('system', streams.systemAudioTrack)
    this.timer = setInterval(() => {
      const patch: Partial<{ micLevel: number; systemLevel: number }> = {}
      for (const a of this.analysers) {
        a.an.getByteTimeDomainData(a.buf)
        let sum = 0
        for (let i = 0; i < a.buf.length; i++) {
          const v = (a.buf[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / a.buf.length)
        const level = Math.min(1, rms * 3.2)
        if (a.name === 'mic') patch.micLevel = level
        else patch.systemLevel = level
      }
      store.getState().setLive(patch)
    }, 80)
  }
  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    void this.ctx.close().catch(() => {})
    store.getState().setLive({ micLevel: 0, systemLevel: 0 })
  }
}

function barState(): BarState {
  const st = store.getState()
  return {
    phase: st.phase,
    elapsedMs: engine.mediaTimeMs(),
    bytes: engine.bytesWritten,
    micMuted: engine.isMicMuted,
    camOn: engine.isCameraOn,
    hasCam: !!engine.prepared?.cam,
    hasMic: !!engine.prepared?.mic,
    annotating
  }
}

function pushBar(): void {
  const st = store.getState()
  st.setLive({ elapsedMs: engine.mediaTimeMs(), bytes: engine.bytesWritten, micMuted: engine.isMicMuted, camOn: engine.isCameraOn, annotating })
  api.recording.barUpdate(barState())
}

async function preflight(config: RecordingConfig): Promise<string | null> {
  const free = await api.session.freeSpaceMB().catch(() => Number.POSITIVE_INFINITY)
  if (free < MIN_FREE_SPACE_MB) return `Espaço em disco insuficiente (${Math.round(free)} MB livres; mínimo ${MIN_FREE_SPACE_MB} MB).`
  if (!config.source.id) return 'Escolha um monitor ou uma janela para gravar.'
  return null
}

function displaysForConfig(config: RecordingConfig): string[] {
  const st = store.getState()
  const displays = st.sources?.displays ?? []
  if (config.source.kind === 'screen' && config.source.displayId) return [config.source.displayId]
  // modo janela: overlay/barra no monitor principal (não sabemos onde a janela está)
  const primary = displays.find((d) => d.isPrimary)
  return primary ? [primary.id] : displays.map((d) => d.id).slice(0, 1)
}

export async function startRecording(config: RecordingConfig): Promise<void> {
  const st = store.getState()
  if (st.phase !== 'idle' && st.phase !== 'review') return
  const problem = await preflight(config)
  if (problem) {
    toast.error(problem)
    return
  }
  lastConfig = config
  st.clearWarnings()
  st.setReviewSession(null)
  try {
    unsubs.push(engine.on((e) => {
      if (e.type === 'warning') {
        st.pushWarning(e.message)
        toast.warning(e.message)
      } else if (e.type === 'error') {
        toast.error(e.message)
        if (e.fatal) void finishAfterStop()
      } else if (e.type === 'bytes') {
        st.setLive({ bytes: e.bytes, elapsedMs: e.elapsedMs })
      }
    }))
    const prepared = await engine.prepare(config)
    currentDisplayIds = displaysForConfig(config)
    targetRect = null
    setPhase('countdown')
    await api.recording.setPhase('countdown', { displayIds: currentDisplayIds, countdownSec: config.countdownSec, targetRect, ...srcCtx() })
    st.setScreen('recording')
    levelMeter = new LevelMeter(prepared)
    // contagem regressiva (a overlay mostra os números; o gravador espelha)
    countdownAbort = new AbortController()
    try {
      for (let n: number = config.countdownSec; n > 0; n--) {
        await api.overlay.setMode({ mode: 'countdown', count: n, targetRect, ...srcCtx() })
        if (config.countdownSec > 0 && st.settings.startSound) beep(n === 1 ? 880 : 660, 90)
        await sleep(1000, countdownAbort.signal)
      }
    } catch {
      // cancelado durante a contagem
      await abortPrepared()
      return
    }
    countdownAbort = null
    await engine.start()
    setPhase('recording')
    await api.recording.setPhase('recording', { displayIds: currentDisplayIds, targetRect, ...srcCtx() })
    if (config.countdownSec > 0 && st.settings.startSound) beep(1040, 120)
    barTimer = setInterval(pushBar, 500)
    pushBar()
  } catch (e) {
    const err = e as Error
    console.error(err)
    if (err?.name === 'NotAllowedError') toast.error('Permissão negada para capturar a tela ou os dispositivos. Verifique as configurações de privacidade do Windows.')
    else toast.error(`Não foi possível iniciar a gravação: ${err?.message ?? String(e)}`)
    await abortPrepared()
  }
}

async function abortPrepared(): Promise<void> {
  cleanupLive()
  try {
    engine.releasePrepared()
    if (engine.phase !== 'idle') await engine.cancel()
  } catch {
    /* ignore */
  }
  setPhase('idle')
  await api.recording.setPhase('idle')
  store.getState().setScreen('prepare')
}

function cleanupLive(): void {
  if (barTimer) clearInterval(barTimer)
  barTimer = null
  levelMeter?.dispose()
  levelMeter = null
  for (const u of unsubs) u()
  unsubs = []
  annotating = false
  targetRect = null
}

export function pauseRecording(): void {
  if (store.getState().phase !== 'recording') return
  engine.pause()
  setPhase('paused')
  void api.recording.setPhase('paused', { displayIds: currentDisplayIds, targetRect, ...srcCtx() })
  pushBar()
}

export function resumeRecording(): void {
  if (store.getState().phase !== 'paused') return
  engine.resume()
  setPhase('recording')
  void api.recording.setPhase('recording', { displayIds: currentDisplayIds, targetRect, ...srcCtx() })
  pushBar()
}

export async function stopRecording(): Promise<Session | null> {
  const phase = store.getState().phase
  if (phase === 'countdown') {
    countdownAbort?.abort()
    return null
  }
  if (phase !== 'recording' && phase !== 'paused') return null
  if (annotating) void setAnnotating(false)
  setPhase('stopping')
  await api.recording.setPhase('stopping')
  cleanupLive()
  let session: Session | null = null
  try {
    session = await engine.stop()
  } catch (e) {
    toast.error(`Falha ao encerrar a gravação: ${(e as Error).message}`)
  }
  await finishAfterStop(session)
  return session
}

async function finishAfterStop(session?: Session | null): Promise<void> {
  const st = store.getState()
  const s = session ?? engine.session
  cleanupLive()
  if (s) {
    st.setReviewSession(s)
    setPhase('review')
    await api.recording.setPhase('review')
    st.setScreen('review')
  } else {
    setPhase('idle')
    await api.recording.setPhase('idle')
    st.setScreen('prepare')
  }
}

export async function cancelRecording(): Promise<void> {
  const phase = store.getState().phase
  if (phase === 'countdown') {
    countdownAbort?.abort()
    return
  }
  if (phase !== 'recording' && phase !== 'paused') return
  if (annotating) void setAnnotating(false)
  setPhase('stopping')
  await api.recording.setPhase('stopping')
  cleanupLive()
  await engine.cancel()
  setPhase('idle')
  await api.recording.setPhase('idle')
  store.getState().setScreen('prepare')
  toast('Gravação cancelada e descartada.')
}

export async function restartRecording(): Promise<void> {
  const cfg = lastConfig
  await cancelRecording()
  if (cfg) await startRecording(cfg)
}

export function toggleMic(): void {
  engine.setMicMuted(!engine.isMicMuted)
  pushBar()
  toast(engine.isMicMuted ? 'Microfone silenciado' : 'Microfone ativado', { duration: 1200 })
}

export function toggleCamera(): void {
  engine.setCameraOn(!engine.isCameraOn)
  pushBar()
}

export function setPip(k: Omit<PipKeyframe, 'tMs'>): void {
  const phase = store.getState().phase
  if (phase === 'recording' || phase === 'paused' || phase === 'countdown') engine.addPipKeyframe(k)
  store.getState().setPipDraft({ ...k, tMs: 0 })
}

export function cyclePip(): void {
  const cur = engine.currentPip ?? store.getState().pipDraft
  pipCycle = (pipCycle + 1) % (PIP_CORNERS.length * PIP_SIZES.length)
  const corner = PIP_CORNERS[pipCycle % PIP_CORNERS.length]
  const size = PIP_SIZES[Math.floor(pipCycle / PIP_CORNERS.length)]
  const h = (size * 16) / 9
  const x = corner[0] <= 0.5 ? corner[0] : 1 - 0.04 - size
  const y = corner[1] <= 0.5 ? corner[1] : 1 - 0.06 - h
  setPip({ x, y, w: size, h, shape: cur.shape, visible: cur.visible })
}

/* ---------- anotações ---------- */
export function isAnnotating(): boolean {
  return annotating
}

export async function setAnnotating(on: boolean, tool: StrokeTool = annotateTool): Promise<void> {
  const st = store.getState()
  const phase = st.phase
  if (on && phase !== 'recording' && phase !== 'paused') return
  if (on && lastConfig?.source.kind === 'window') {
    toast('As anotações na tela estão disponíveis ao gravar um monitor.', { description: 'Em modo janela, o Windows não permite desenhar sobre a janela capturada.' })
    return
  }
  annotating = on
  annotateTool = tool
  const a = st.settings.annotations
  if (on) await api.overlay.setMode({ mode: 'drawing', tool, color: a.color, width: a.width, autoFadeSec: a.autoFadeSec, targetRect, ...srcCtx() })
  else await api.overlay.setMode({ mode: 'idle', paused: phase === 'paused', targetRect, ...srcCtx() })
  st.setLive({ annotating: on })
  pushBar()
}

export function toggleAnnotate(tool: StrokeTool = 'pen'): void {
  if (annotating && annotateTool === tool) void setAnnotating(false)
  else void setAnnotating(true, tool)
}

export function clearAnnotations(): void {
  engine.clearStrokes()
  api.overlay.syncStrokes('', [])
}

function onOverlayStroke(evt: OverlayStrokeEvent): void {
  // converte instantes de parede da overlay em tempo de mídia
  const stroke: Stroke = {
    ...evt.stroke,
    tMs: engine.mediaTimeAt(evt.stroke.tMs),
    points: evt.stroke.points.map((p) => ({ ...p, tMs: engine.mediaTimeAt(p.tMs) }))
  }
  engine.upsertStroke(stroke)
}

function onOverlayAction(evt: OverlayActionEvent): void {
  if (evt.action === 'undo') {
    engine.undoLastStroke()
    api.overlay.syncStrokes('', engine.visibleStrokes())
  } else if (evt.action === 'clear') {
    clearAnnotations()
  } else if (evt.action === 'exit') {
    void setAnnotating(false)
  } else if (evt.action === 'setTool' && evt.tool) {
    annotateTool = evt.tool
  }
}

/* ---------- comandos vindos do main (atalhos, barra, bandeja) ---------- */
export function handleCommand(cmd: RecorderCommand): void {
  const st = store.getState()
  switch (cmd) {
    case 'toggleRecord': {
      if (st.phase === 'idle' || st.phase === 'review') {
        const cfg = st.screen === 'prepare' || st.screen === 'review' || st.screen === 'history' || st.screen === 'settings' ? buildConfigFromStore() : null
        if (cfg) void startRecording(cfg)
        else toast.error('Escolha uma fonte de gravação primeiro.')
      } else void stopRecording()
      break
    }
    case 'pause':
      pauseRecording()
      break
    case 'resume':
      resumeRecording()
      break
    case 'pauseResume':
      if (st.phase === 'recording') pauseRecording()
      else if (st.phase === 'paused') resumeRecording()
      break
    case 'stop':
      void stopRecording()
      break
    case 'cancel':
      void cancelRecording()
      break
    case 'restart':
      void restartRecording()
      break
    case 'muteMic':
      toggleMic()
      break
    case 'toggleCamera':
      toggleCamera()
      break
    case 'cyclePip':
      cyclePip()
      break
    case 'annotate':
      toggleAnnotate('pen')
      break
    case 'arrow':
      toggleAnnotate('arrow')
      break
    case 'clearAnnotations':
      clearAnnotations()
      break
    case 'showRecorder':
      void api.app.showRecorder()
      break
    case 'toggleBar':
      // tratado no main
      break
  }
}

function buildConfigFromStore(): RecordingConfig | null {
  return buildRecordingConfig(store.getState())
}

let wired = false
export function wireController(): void {
  if (wired) return
  wired = true
  api.recording.onCommand(handleCommand)
  api.overlay.onStroke(onOverlayStroke)
  api.overlay.onAction(onOverlayAction)
}

/* ---------- som de contagem (WebAudio, curto) ---------- */
let beepCtx: AudioContext | null = null
function beep(freq: number, ms: number): void {
  try {
    beepCtx ??= new AudioContext()
    const o = beepCtx.createOscillator()
    const g = beepCtx.createGain()
    o.type = 'sine'
    o.frequency.value = freq
    g.gain.value = 0.0001
    o.connect(g).connect(beepCtx.destination)
    const t = beepCtx.currentTime
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000)
    o.start(t)
    o.stop(t + ms / 1000 + 0.02)
  } catch {
    /* sem áudio */
  }
}
