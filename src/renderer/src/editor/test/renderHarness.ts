import { ALL_FORMATS, Input, UrlSource, VideoSampleSink } from 'mediabunny'
import type { RenderOut } from '../engine/protocol'
import { RenderClient } from '../engine/RenderClient'
import { mediaUrlsFor } from '../engine/mediaUrls'
import { AudioClient } from '../engine/audio/AudioClient'
import { PlaybackController } from '../engine/PlaybackController'
import { useEditorStore } from '../state/editorStore'
import { createEditorEngine } from '../ui/editorEngine'
import { effectsCheck } from './effectsHarness'
import { stretchCheck } from './stretchHarness'
import { speedCheck } from './speedHarness'
import { zoomCheck } from './zoomHarness'
import { autoZoomCheck } from './autoZoomHarness'
import { followCheck } from './followHarness'
import { animCheck } from './animHarness'
import { reframeCheck } from './reframeHarness'
import { cursorFxCheck } from './cursorFxHarness'
import { trackingCheck } from './trackingHarness'

// Teste de integração do render (CIALIGHT_TEST=editor-render), rota index.html#editor-test/<projectId>?out=<pasta>:
// monta só o RenderClient sobre um canvas 1920×1080, pede quadros e devolve leituras de pixels ao
// main, que valida (editorTestMode.ts).

declare global {
  interface Window {
    __captureTestSend?: (r: unknown) => void
  }
}

const W = 1920
const H = 1080

export async function runRenderHarness(projectId: string, outDir: string | null = null): Promise<void> {
  const report: Record<string, unknown> = { errors: [] as string[] }
  const errors = report.errors as string[]
  let ok = false
  try {
    report.stretch = await stretchCheck()
    const project = await window.api.project.load(projectId)
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    canvas.style.width = '480px'
    document.body.appendChild(canvas)
    const client = new RenderClient(canvas, { width: W, height: H, dpr: 1 })
    client.onMessage((m) => {
      if (m.t === 'error') errors.push(m.message)
    })
    await client.ready
    client.setProject(project, mediaUrlsFor(project, 'preview'), true)

    const px = async (x: number, y: number): Promise<number[]> => [...(await client.readPixels(x, y, 1, 1))]
    const region = (x: number, y: number, s: number): Promise<Uint8Array> => client.readPixels(x - s / 2, y - s / 2, s, s)

    const first = await client.requestFrame(1_000_000, false)
    report.first = first
    report.pixels = {
      circleCenter: await px(1680, 135),
      boxCorner: await px(1550, 5),
      missing: await px(240, 945),
      corrupt: await px(720, 945),
      stroke: await px(1056, 324),
      webcam: await px(1680, 945)
    }
    const at1s = await region(W / 2, H / 2, 200)
    report.videoMean = mean(at1s)

    // reprodução sequencial (iterador) e seek
    const seq: RenderOut[] = []
    for (let i = 1; i <= 5; i++) seq.push(await client.requestFrame(1_000_000 + i * 33_333, true))
    report.sequential = seq
    report.seek = await client.requestFrame(2_500_000, false)
    report.videoDiff = meanAbsDiff(at1s, await region(W / 2, H / 2, 200))

    // fonte com rotação 90 nos metadados (3–5 s, sozinha): contain num canvas 16:9 → 607,5×1080 centrado
    const rotFrame = await client.requestFrame(4_000_000, false)
    report.rotated = {
      frame: rotFrame,
      pillarLeft: await px(300, 540),
      pillarRight: await px(1600, 540),
      topLeft: await px(800, 270),
      topRight: await px(1100, 270),
      bottomLeft: await px(800, 810),
      bottomRight: await px(1100, 810)
    }
    report.rotationDiag = await rotationDiag(mediaUrlsFor(project, 'export').a_rot?.original)

    // vários pedidos sem esperar: o worker coalesce, todos resolvem
    const burst = await Promise.all([0, 1, 2, 3, 4].map((i) => client.requestFrame(500_000 + i * 100_000, false)))
    report.burst = burst.map((r) => r.t)

    report.playback = await playbackCheck(client, project)
    client.dispose()
    report.watchdog = await watchdogCheck(project)
    report.effects = await effectsCheck()
    report.zoom = await zoomCheck(outDir)
    report.autoZoom = await autoZoomCheck()
    report.follow = await followCheck(outDir)
    report.anim = await animCheck(outDir)
    report.reframe = await reframeCheck(outDir)
    report.cursorFx = await cursorFxCheck(outDir)
    report.tracking = await trackingCheck(outDir)
    // por último: decodificação 1080p contínua (a CPU desta máquina estrangula depois de alguns segundos de carga)
    report.speed = await speedCheck()
    ok = true
  } catch (e) {
    errors.push(e instanceof Error ? (e.stack ?? e.message) : String(e))
  }
  window.__captureTestSend?.({ ok, report })
}

/**
 * Reprodução real por 2 s a partir de 0,5 s (AudioContext como relógio): faixa de áudio com senoide de
 * 1 kHz na faixa a:1 do arquivo (a:0 é silêncio, então nível > 0 prova a escolha da faixa).
 * Deriva = relógio do áudio (clockUs) no instante em que chega cada quadro renderizado − tUs do quadro;
 * taxa = avanço do relógio do áudio × tempo real em 2 s (após o aquecimento do dispositivo).
 */
async function playbackCheck(client: RenderClient, project: Awaited<ReturnType<typeof window.api.project.load>>): Promise<Record<string, unknown>> {
  const audio = new AudioClient()
  const audioErrors: string[] = []
  audio.onError((m) => audioErrors.push(m))
  audio.setProject(project, mediaUrlsFor(project, 'preview'), true)
  useEditorStore.getState().open(project)
  useEditorStore.getState().setPlayhead(500_000)
  const ctl = new PlaybackController(client, audio, useEditorStore)
  const drifts: number[] = []
  let frames = 0
  const off = client.onMessage((m) => {
    const c = ctl.clockUs
    if (m.t !== 'rendered' || c === null) return
    frames++
    drifts.push(c - m.tUs)
  })
  const peak = { l: 0, r: 0 }
  const vu = setInterval(() => {
    const lv = ctl.levels
    peak.l = Math.max(peak.l, lv.l)
    peak.r = Math.max(peak.r, lv.r)
  }, 20)
  try {
    await ctl.play()
    const startWait = performance.now()
    // durante a latência de saída o relógio fica preso em us0 (o som ainda não saiu): mede depois disso
    while ((ctl.clockUs ?? 0) <= 500_000 && performance.now() - startWait < 5000) await sleep(1)
    // e o currentTime anda aos saltos logo após o início do dispositivo (~30 ms medidos): mede a taxa depois
    await sleep(200)
    const c0 = ctl.clockUs
    const w0 = performance.now()
    if (c0 === null || c0 <= 500_000) return { error: 'relógio não começou', audioErrors }
    while (performance.now() - w0 < 2000) await sleep(10)
    const c1 = ctl.clockUs ?? NaN
    const w1 = performance.now()
    const playheadUs = useEditorStore.getState().playheadUs
    const playing = useEditorStore.getState().playing
    const seek = await seekCheck(ctl)
    ctl.pause()
    const tail = drifts.slice(-10)
    return {
      peak,
      frames,
      driftLastUs: tail.length ? tail[tail.length - 1] : null,
      driftMaxTailUs: tail.length ? Math.max(...tail.map(Math.abs)) : null,
      clockAdvanceUs: c1 - c0,
      wallAdvanceUs: Math.round((w1 - w0) * 1000),
      playheadUs,
      playing,
      pausedPlaying: useEditorStore.getState().playing,
      startupMs: Math.round(w0 - startWait),
      seek,
      audioErrors
    }
  } finally {
    clearInterval(vu)
    off()
    ctl.dispose()
    audio.dispose()
  }
}

/**
 * Seek tocando: volta de ~2,7 s para 1,0 s. O relógio deve seguir do novo ponto e todo nó agendado depois
 * do seek deve ser do novo ponto (fromUs em [alvo, alvo + 1 s]) e começar depois do instante do seek.
 */
async function seekCheck(ctl: PlaybackController): Promise<Record<string, unknown>> {
  const seekToUs = 1_000_000
  const after: { fromUs: number; startS: number }[] = []
  let seekCtxS = Infinity
  const off = ctl.onSchedule((s) => {
    if (ctl.contextTime >= seekCtxS) after.push({ fromUs: s.fromUs, startS: s.startS })
  })
  try {
    seekCtxS = ctl.contextTime
    ctl.seek(seekToUs)
    await sleep(400)
    const clockAfterUs = ctl.clockUs
    // o ponto antigo (~2,7 s) fica fora de [alvo, alvo + 1 s]: nó dele depois do seek conta como inválido
    const bad = after.filter((s) => s.fromUs < seekToUs || s.fromUs > seekToUs + 1_000_000 || s.startS < seekCtxS).length
    return { seekToUs, clockAfterUs, playing: ctl.playing, seekCtxS, scheduledAfter: after, badSchedules: bad }
  } finally {
    off()
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Watchdog do preview (spec §13) pelo motor real do editor (createEditorEngine, prazo de 1,5 s no teste):
 * tocando, o worker é travado (testStall) → o motor troca o worker e o canvas (no mesmo lugar do DOM),
 * restaura o projeto e a reprodução volta a receber quadros; parado, o quadro em 1 s é o mesmo de antes.
 */
async function watchdogCheck(project: Awaited<ReturnType<typeof window.api.project.load>>): Promise<Record<string, unknown>> {
  const store = useEditorStore.getState()
  store.open(project)
  store.setPlayhead(500_000)
  const engine = createEditorEngine({ stallMs: 1500 })
  const host = document.createElement('div')
  host.style.width = '480px'
  document.body.appendChild(host)
  host.appendChild(engine.canvas)
  const first = engine.canvas
  let rendered = 0
  const off = engine.render.onMessage((m) => {
    if (m.t === 'rendered') rendered++
  })
  try {
    await engine.render.ready
    engine.render.resize(W, H)
    const pxAt1s = async (): Promise<number[]> => {
      // o motor redesenha sozinho o playhead parado no próximo rAF (assinatura da store): com o playhead em 1 s os dois
      // desenhos são o mesmo quadro — senão o redesenho do ponto da pausa (às vezes > 3 s, onde esse pixel é a faixa
      // preta do vídeo girado) podia cair entre o requestFrame e a leitura
      useEditorStore.getState().setPlayhead(1_000_000)
      await sleep(100)
      const r = await engine.render.requestFrame(1_000_000, false)
      if (r.t !== 'rendered') return [-1]
      // o motor desenha em CSS × devicePixelRatio: centro do círculo vermelho (1680, 135) nessa escala
      const d = window.devicePixelRatio || 1
      return [...(await engine.render.readPixels(Math.round(1680 * d), Math.round(135 * d), 1, 1))]
    }
    const before = await pxAt1s()
    await engine.playback.play()
    await sleep(500)
    const renderedBeforeStall = rendered
    const t0 = performance.now()
    engine.render.testStall(60_000) // o worker antigo fica preso; o watchdog tem de trocá-lo
    while (engine.canvas === first && performance.now() - t0 < 6000) await sleep(50)
    const restartMs = Math.round(performance.now() - t0)
    const swapped = engine.canvas !== first && !first.isConnected && engine.canvas.parentElement === host
    const atRestart = rendered
    const t1 = performance.now()
    while (rendered === atRestart && performance.now() - t1 < 5000) await sleep(20)
    const renderedAfterRestart = rendered - atRestart
    const playing = useEditorStore.getState().playing
    engine.playback.pause()
    const after = await pxAt1s()
    return { before, after, restartMs, swapped, renderedBeforeStall, renderedAfterRestart, playing }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  } finally {
    off()
    engine.dispose()
    host.remove()
  }
}

/** O que o mediabunny entrega para uma faixa girada: rotação no sample e dimensões do VideoFrame. */
async function rotationDiag(url: string | undefined): Promise<Record<string, unknown>> {
  if (!url) return { error: 'sem URL' }
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return { error: 'sem vídeo' }
    const sample = await new VideoSampleSink(track).getSample(0.5)
    if (!sample) return { error: 'sem sample' }
    const frame = sample.toVideoFrame()
    const out = {
      trackRotation: track.rotation,
      sampleRotation: sample.rotation,
      sampleCoded: `${sample.codedWidth}x${sample.codedHeight}`,
      sampleDisplay: `${sample.displayWidth}x${sample.displayHeight}`,
      frameCoded: `${frame.codedWidth}x${frame.codedHeight}`,
      frameDisplay: `${frame.displayWidth}x${frame.displayHeight}`,
      frameRotation: (frame as unknown as { rotation?: number }).rotation ?? null
    }
    frame.close()
    sample.close()
    return out
  } catch (e) {
    return { error: String(e) }
  } finally {
    input.dispose()
  }
}

function mean(d: Uint8Array): number[] {
  const s = [0, 0, 0]
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) s[c] += d[i + c]
  return s.map((v) => Math.round(v / (d.length / 4)))
}

function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) if (i % 4 !== 3) s += Math.abs(a[i] - b[i])
  return s / ((a.length / 4) * 3)
}
