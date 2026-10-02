import { setReverse } from '@shared/editor/ops'
import type { MediaItem, Project } from '@shared/editor/project'
import { sourceTimeUs } from '@shared/editor/resolve'
import { channel, dominantHz, rmsOf } from '@shared/audio/pcmAnalysis'
import { RenderClient } from '../engine/RenderClient'
import { AudioClient } from '../engine/audio/AudioClient'
import { mediaUrlsFor } from '../engine/mediaUrls'
import { PlaybackController } from '../engine/PlaybackController'
import { useEditorStore } from '../state/editorStore'

// Reverso e shuttle J/K/L no motor real (CIALIGHT_TEST=editor-render): vídeo 1080p30 de 8 s com GOP de 2 s e o
// número do quadro gravado em bits no topo (8 caixas de 240×80, branca = 1) + senoide de 1 kHz. Toca pelo
// PlaybackController e lê o marcador do quadro na tela enquanto toca: o quadro mostrado tem de ser o esperado
// para o instante (sourceTimeUs) e andar no sentido certo; mede o atraso (relógio do áudio − instante do quadro)
// e a taxa do relógio. O main valida (editorTestMode.ts).

export const SPEED_PROJECT_ID = 'p-editor-speed-test'
export const SPEED_SD_PROJECT_ID = 'p-editor-speed-sd-test'
const W = 1920
const H = 1080
const FPS = 30
const BITS = 8

export interface SpeedRun {
  error?: string
  frames: number
  /** amostras do marcador: instante do último quadro renderizado × quadro lido na tela × esperado */
  samples: number
  wrong: number
  /** maior distância (em quadros) entre o quadro na tela e o esperado */
  maxError: number
  /** leituras com o quadro da fonte na tela depois do esperado (o pool só devolve quadro ≤ alvo; o esparso fica antes) */
  ahead: number
  /** maior passo entre quadros renderizados seguidos, em quadros da fonte (o bloco esparso guarda um a cada meio passo) */
  maxStepFrames: number
  /** tempo de render no worker por quadro (ms): mediana e máximo na janela medida */
  renderMs: { median: number; max: number }
  /** pares consecutivos fora do sentido esperado (marcador andando ao contrário) */
  wrongDirection: number
  /** maior recuo (em quadros) entre leituras seguidas fora do sentido esperado */
  maxBacktrack: number
  firstMarker: number | null
  lastMarker: number | null
  meanLagUs: number
  maxLagUs: number
  /** avanço do relógio ÷ tempo real na janela medida (negativo = para trás) */
  ratio: number
  peak: number
  mismatches: { tUs: number; marker: number; expected: number }[]
}
export interface SpeedReport {
  error?: string
  reverseItem?: SpeedRun
  shuttleBack?: SpeedRun
  shuttle2x?: SpeedRun
  shuttle4x?: SpeedRun
  shuttleBack8x?: SpeedRun
  /**
   * Quadro servido pelo bloco do reverso (cópia na GPU) × o mesmo quadro da fonte por seek no item normal: maior
   * diferença por canal no miolo da imagem (a cópia não pode mudar cor nem geometria).
   */
  parity?: { maxDiff: number; meanDiff: number; neighborMeanDiff: number; markers: number[]; error?: string }
  /** a mesma paridade numa fonte SD 640×480 sem marcação de cor (o decoder recebe BT.601 pela regra única) */
  paritySd?: SpeedReport['parity']
  /** bloco de 0,5 s mixado a 2× pelo audio worker: frequência dominante (1 kHz esticado; reamostrado daria 2 kHz) */
  pcm2x?: { hz: number; rms: number; error?: string }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Número do quadro lido da faixa de bits (linha y = 40). */
function decodeMarker(row: Uint8Array): number {
  let n = 0
  for (let k = 0; k < BITS; k++) {
    const i = (k * 240 + 120) * 4
    const luma = 0.299 * row[i] + 0.587 * row[i + 1] + 0.114 * row[i + 2]
    if (luma > 128) n |= 1 << k
  }
  return n
}

/** Quadro da fonte esperado na tela em tUs: o de maior timestamp ≤ fonte + 1 µs (a tolerância do DecoderPool). */
function expectedFrame(p: Project, tUs: number): number {
  const item = p.tracks[0].items.find((i) => i.startUs <= tUs && tUs < i.startUs + i.durationUs) as MediaItem | undefined
  const asset = p.assets[0]
  if (!item) return -1
  return Math.floor(((sourceTimeUs(item, asset, tUs) + 1) * FPS) / 1e6 + 1e-9)
}

async function run(client: RenderClient, audio: AudioClient, p: Project, startUs: number, dir: 1 | -1, start: (ctl: PlaybackController) => Promise<void>, measureMs: number): Promise<SpeedRun> {
  const out: SpeedRun = { frames: 0, samples: 0, wrong: 0, maxError: 0, ahead: 0, maxStepFrames: 0, renderMs: { median: 0, max: 0 }, maxBacktrack: 0, wrongDirection: 0, firstMarker: null, lastMarker: null, meanLagUs: 0, maxLagUs: 0, ratio: 0, peak: 0, mismatches: [] }
  const urls = mediaUrlsFor(p, 'preview')
  useEditorStore.getState().open(p)
  client.setProject(p, urls, true)
  audio.setProject(p, urls, true)
  useEditorStore.getState().setPlayhead(startUs)
  await client.requestFrame(startUs, false) // quadro parado no ponto de partida, como no editor
  const ctl = new PlaybackController(client, audio, useEditorStore)
  let measuring = false
  let last: number | null = null
  const lags: number[] = []
  const renderMs: number[] = []
  const off = client.onMessage((m) => {
    if (m.t !== 'rendered') return
    if (last !== null && ctl.playing) out.maxStepFrames = Math.max(out.maxStepFrames, Math.ceil((Math.abs(m.tUs - last) * FPS) / 1e6))
    last = m.tUs
    const c = ctl.clockUs
    if (!measuring || c === null || !ctl.playing) return
    out.frames++
    lags.push(Math.abs(c - m.tUs))
    renderMs.push(m.ms)
  })
  const vu = setInterval(() => {
    const lv = ctl.levels
    out.peak = Math.max(out.peak, lv.l, lv.r)
  }, 20)
  try {
    await start(ctl)
    const t0 = performance.now()
    while ((ctl.clockUs ?? startUs) === startUs && performance.now() - t0 < 3000) await sleep(5)
    await sleep(250) // aquecimento (1º bloco do reverso, dispositivo de áudio)
    out.peak = 0
    measuring = true
    const c0 = ctl.clockUs ?? NaN
    const w0 = performance.now()
    let prev: number | null = null
    while (performance.now() - w0 < measureMs && ctl.playing) {
      const px = await client.readPixels(0, 40, W, 1)
      if (last !== null) {
        const marker = decodeMarker(px)
        const expected = expectedFrame(p, last)
        out.samples++
        out.maxError = Math.max(out.maxError, Math.abs(marker - expected))
        if (marker > expected) out.ahead++ // quadro da fonte depois do alvo: o pool só pode devolver quadro ≤ alvo
        if (marker !== expected) {
          out.wrong++
          if (out.mismatches.length < 8) out.mismatches.push({ tUs: last, marker, expected })
        }
        if (prev !== null && marker !== prev && Math.sign(marker - prev) !== dir) {
          out.wrongDirection++
          out.maxBacktrack = Math.max(out.maxBacktrack, Math.abs(marker - prev))
        }
        out.firstMarker ??= marker
        out.lastMarker = marker
        prev = marker
      }
      await sleep(15)
    }
    const c1 = ctl.clockUs ?? NaN
    const w1 = performance.now()
    measuring = false
    out.ratio = Math.round(((c1 - c0) / ((w1 - w0) * 1000)) * 1000) / 1000
    out.meanLagUs = lags.length ? Math.round(lags.reduce((s, v) => s + v, 0) / lags.length) : -1
    out.maxLagUs = lags.length ? Math.max(...lags) : -1
    const sorted = [...renderMs].sort((a, b) => a - b)
    out.renderMs = { median: Math.round(sorted[sorted.length >> 1] ?? -1), max: Math.round(sorted[sorted.length - 1] ?? -1) }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e)
  } finally {
    clearInterval(vu)
    off()
    ctl.pause()
    ctl.dispose()
  }
  return out
}

export async function speedCheck(): Promise<SpeedReport> {
  const report: SpeedReport = {}
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  canvas.style.width = '480px'
  document.body.appendChild(canvas)
  const client = new RenderClient(canvas, { width: W, height: H, dpr: 1 })
  const audio = new AudioClient()
  try {
    await client.ready
    const base = await window.api.project.load(SPEED_PROJECT_ID)
    const videoId = base.tracks[0].items[0].id
    const reversed = setReverse(base, [videoId], true)
    // item reverso tocado a 1×: quadros em ordem decrescente, sem travar
    report.reverseItem = await run(client, audio, reversed, 500_000, -1, (ctl) => ctl.play(), 2000)
    // J no item normal: −1×
    report.shuttleBack = await run(client, audio, base, 7_000_000, -1, (ctl) => ctl.shuttle(-1), 1500)
    // L L: 2× com som esticado
    report.shuttle2x = await run(client, audio, base, 0, 1, async (ctl) => { await ctl.shuttle(1); await ctl.shuttle(1) }, 1000)
    // L L L: 4× mudo, 4 s por segundo
    report.shuttle4x = await run(client, audio, base, 0, 1, async (ctl) => { for (let i = 0; i < 3; i++) await ctl.shuttle(1) }, 1000)
    // J J J J: −8× (bloco esparso: um quadro a cada meio passo, a menos de meio passo do exato)
    report.shuttleBack8x = await run(client, audio, base, 7_950_000, -1, async (ctl) => { for (let i = 0; i < 4; i++) await ctl.shuttle(-1) }, 600)
    report.pcm2x = await pcm2x(audio, base)
    report.parity = await parity(client, base, reversed, true)
    const sd = await window.api.project.load(SPEED_SD_PROJECT_ID)
    report.paritySd = await parity(client, sd, setReverse(sd, [sd.tracks[0].items[0].id], true), false)
  } catch (e) {
    report.error = e instanceof Error ? (e.stack ?? e.message) : String(e)
  } finally {
    audio.dispose()
    client.dispose()
    canvas.remove()
    useEditorStore.getState().close()
  }
  return report
}

/** Maior diferença por canal e média no miolo da imagem (passo 2). */
function diff(a: Uint8Array, b: Uint8Array): { max: number; mean: number } {
  let max = 0
  let sum = 0
  let n = 0
  for (let y = 120; y < H - 40; y += 2) {
    for (let x = 40; x < W - 40; x += 2) {
      const i = (y * W + x) * 4
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a[i + c] - b[i + c])
        max = Math.max(max, d)
        sum += d
        n++
      }
    }
  }
  return { max, mean: Math.round((sum / n) * 1000) / 1000 }
}

/**
 * Pede quadros sequenciais do item reverso (fonte voltando: do 3º pedido em diante, bloco do reverso com a cópia na
 * GPU) e compara com o seek do mesmo quadro no item normal; e com o quadro vizinho (a medida distingue quadros).
 */
async function parity(client: RenderClient, base: Project, reversed: Project, withMarkers: boolean): Promise<SpeedReport['parity']> {
  try {
    const urls = mediaUrlsFor(base, 'preview')
    client.setProject(reversed, urls, true)
    // item reverso: quadros seguidos voltam na fonte
    const ts = [2_900_000, 2_933_333, 2_966_667, 3_000_000, 3_033_333, 3_066_667, 3_100_000]
    for (const t of ts) await client.requestFrame(t, true)
    const rev = await client.readPixels(0, 0, W, H)
    const item = reversed.tracks[0].items[0] as MediaItem
    const srcUs = sourceTimeUs(item, reversed.assets[0], ts[ts.length - 1])
    client.setProject(base, urls, true)
    await client.requestFrame(srcUs, false)
    const fwd = await client.readPixels(0, 0, W, H)
    await client.requestFrame(srcUs - 33_334, false)
    const prev = await client.readPixels(0, 0, W, H)
    const d = diff(rev, fwd)
    const markers = withMarkers ? [rev, fwd].map((px) => decodeMarker(px.subarray(40 * W * 4, 41 * W * 4))) : []
    return { maxDiff: d.max, meanDiff: d.mean, neighborMeanDiff: diff(rev, prev).mean, markers }
  } catch (e) {
    return { maxDiff: -1, meanDiff: -1, neighborMeanDiff: -1, markers: [], error: e instanceof Error ? e.message : String(e) }
  }
}

/** 0,5 s da timeline (a partir de 1 s) mixado a 2× em blocos de 100 ms pelo worker real. */
async function pcm2x(audio: AudioClient, p: Project): Promise<{ hz: number; rms: number; error?: string }> {
  try {
    audio.setProject(p, mediaUrlsFor(p, 'preview'), true)
    const blocks: Float32Array[] = []
    for (let k = 0; k < 5; k++) {
      const b = await audio.render(1_000_000 + k * 200_000, 4800, 2)
      if (!b) throw new Error(`bloco ${k} sem resposta`)
      blocks.push(b.pcm)
    }
    const all = new Float32Array(blocks.reduce((s, b) => s + b.length, 0))
    let o = 0
    for (const b of blocks) {
      all.set(b, o)
      o += b.length
    }
    const x = channel(all, 0)
    return { hz: dominantHz(x, 4800, x.length - 4800, 200, 3000), rms: Math.round(rmsOf(x, 4800) * 1000) / 1000 }
  } catch (e) {
    return { hz: 0, rms: 0, error: e instanceof Error ? e.message : String(e) }
  }
}
