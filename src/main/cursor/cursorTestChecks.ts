import { BrowserWindow, screen } from 'electron'
import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { performance } from 'perf_hooks'
import { CURSOR_FILE, dipToPhysical, normalizeToFrame, parseCursorTrack, physicalDisplays, type CursorTrackV1 } from '@shared/cursor'
import { ffmpegPath } from '../export/ffmpegPath'
import type { CursorRecorder } from './cursorRecorder'
import { cursorBegin, cursorDiscard, injectTestClick, setCursorTestHooks } from './cursorCapture'
import { loadWinInput } from './winInput'

// Conferências da trilha do cursor (F6) no teste de integração de captura (CIALIGHT_TEST=capture). Nada de input do
// SO (ruling R1): o ponto vem de uma fonte sintética que codifica o instante de parede na coordenada x, e o clique é
// injetado no mesmo pipeline do main (cursorCapture.injectTestClick) a partir do renderer.

type Ok = (cond: boolean, msg: string) => void
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** x DIP = origem + 20 + (parede − t0) × 0,1 → 1 px DIP a cada 10 ms (sem dar a volta em 18 s). */
const SYN_MS_PER_PX = 10
const SYN_MARGIN = 20

export interface CursorTestState {
  t0: number | null
  display: Electron.Display
  track: CursorTrackV1 | null
  rec: CursorRecorder | null
  clicks: { dip: { x: number; y: number }; mainMediaMs: number | null }[]
}

/** Liga a fonte sintética no monitor principal e o canal de clique sintético. */
export function installCursorTest(ipcMain: Electron.IpcMain): CursorTestState {
  const display = screen.getPrimaryDisplay()
  const st: CursorTestState = { t0: null, display, track: null, rec: null, clicks: [] }
  setCursorTestHooks({
    readDipPoint: () => {
      const w = performance.now()
      if (st.t0 === null) st.t0 = w
      return { x: display.bounds.x + SYN_MARGIN + (w - st.t0) / SYN_MS_PER_PX, y: display.bounds.y + display.bounds.height / 2 }
    },
    disableNativeClicks: true,
    onStopped: (track, rec) => {
      st.track = track
      st.rec = rec
    }
  })
  ipcMain.handle('test:cursorClick', (_e, r: { button: 'left' | 'right' | 'middle'; x: number; y: number }) => {
    const mainMediaMs = injectTestClick(r.button, { x: r.x, y: r.y })
    st.clicks.push({ dip: { x: r.x, y: r.y }, mainMediaMs })
    return mainMediaMs
  })
  return st
}

function cpuPct(c: NodeJS.CpuUsage, wallMs: number): number {
  return ((c.user + c.system) / 1000 / wallMs) * 100
}

/**
 * Antes da gravação: o binding nativo real carrega, lê os botões e os limites de uma janela; a trilha real (cursor do
 * SO via screen.getCursorScreenPoint + botões via GetAsyncKeyState) começa e para sem erro, e o custo de CPU do main
 * (process.cpuUsage, 10 s, menos 10 s ociosos) fica < 1 % de um núcleo. Devolve as medições.
 */
export async function checkCursorRealSourceAndOverhead(win: BrowserWindow, outDir: string, ok: Ok): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {}
  const native = loadWinInput()
  ok(!!native, 'cursor: binding nativo (koffi) carregou no main do Electron')
  if (native) {
    let threw: unknown = null
    try {
      native.readButtons()
      native.buttonsSwapped()
    } catch (e) {
      threw = e
    }
    ok(threw === null, `cursor: leitura dos botões sem erro (${threw ? String(threw) : 'ok'})`)
    const hwnd = Number(win.getNativeWindowHandle().readBigUInt64LE(0))
    const frame = native.windowFrame(hwnd)
    const phys = screen.dipToScreenRect(win, win.getBounds())
    report.windowFrame = { dwm: frame, electronPhys: phys }
    const near = !!frame && Math.abs(frame.x - phys.x) <= 16 && Math.abs(frame.y - phys.y) <= 16 && Math.abs(frame.width - phys.width) <= 32 && Math.abs(frame.height - phys.height) <= 32
    ok(near, `cursor: limites da janela via DWM batem com o Electron (${JSON.stringify(frame)} vs ${JSON.stringify(phys)})`)
  }
  // DIP → físico (puro) igual ao do Electron em pontos de todos os monitores
  const table = physicalDisplays(screen.getAllDisplays(), (r) => screen.dipToScreenRect(null, r))
  let maxErr = 0
  for (const d of screen.getAllDisplays()) {
    for (const [fx, fy] of [[0.1, 0.1], [0.5, 0.5], [0.9, 0.8]]) {
      const p = { x: Math.round(d.bounds.x + d.bounds.width * fx), y: Math.round(d.bounds.y + d.bounds.height * fy) }
      const mine = dipToPhysical(p, table)
      const theirs = screen.dipToScreenPoint(p)
      maxErr = Math.max(maxErr, Math.abs(mine.x - theirs.x), Math.abs(mine.y - theirs.y))
    }
  }
  report.dipToPhysicalMaxErrPx = maxErr
  report.displays = table
  ok(maxErr <= 1, `cursor: DIP → físico igual ao screen.dipToScreenPoint em ${screen.getAllDisplays().length} monitor(es) (erro máx. ${maxErr} px)`)

  // CPU: 10 s ocioso, depois 10 s com a trilha real ligada (sem gravação)
  const probeDir = join(outDir, 'cursor-cpu-probe')
  rmSync(probeDir, { recursive: true, force: true })
  mkdirSync(probeDir, { recursive: true })
  const measure = async (ms: number): Promise<number> => {
    const c0 = process.cpuUsage()
    const t0 = performance.now()
    await sleep(ms)
    return cpuPct(process.cpuUsage(c0), performance.now() - t0)
  }
  setCursorTestHooks(null)
  const primary = screen.getPrimaryDisplay()
  let startErr: unknown = null
  // ociosa e com trilha alternadas (2 × 10 s cada) depois de 2 s de aquecimento: o começo do app é ruidoso
  await sleep(2000)
  const idle: number[] = []
  const withTrack: number[] = []
  for (let i = 0; i < 2 && startErr === null; i++) {
    idle.push(await measure(10_000))
    try {
      cursorBegin({ sessionId: 'cursor-cpu-probe', width: 1920, height: 1080, source: { kind: 'screen', id: 'screen:probe', displayId: String(primary.id) } }, probeDir)
      withTrack.push(await measure(10_000))
    } catch (e) {
      startErr = e
    } finally {
      cursorDiscard('cursor-cpu-probe')
    }
  }
  ok(startErr === null, `cursor: trilha real (cursor do SO + botões nativos) começou e parou sem erro${startErr ? ` (${String(startErr)})` : ''}`)
  ok(!existsSync(join(probeDir, CURSOR_FILE)), 'cursor: descartar não grava cursor.json')
  rmSync(probeDir, { recursive: true, force: true })
  const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)
  const overhead = mean(withTrack) - mean(idle)
  report.cpu = { idlePct: idle.map((v) => +v.toFixed(3)), withTrackPct: withTrack.map((v) => +v.toFixed(3)), overheadPct: +overhead.toFixed(3) }
  ok(withTrack.length === 2 && overhead < 1, `cursor: custo da amostragem a ~60 Hz + botões < 1 % de um núcleo (ocioso ${idle.map((v) => v.toFixed(2)).join('/')} %, com trilha ${withTrack.map((v) => v.toFixed(2)).join('/')} %, custo ${overhead.toFixed(2)} %)`)
  return report
}

/** Quadros (pts em ms + cor RGB média de um recorte 16×16) da faixa de tela, em ordem. */
async function cropColors(rec: string, crop: { x: number; y: number }): Promise<{ ptsMs: number; rgb: [number, number, number] }[]> {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostdin', '-i', rec, '-map', '0:v:0', '-vf', `crop=16:16:${crop.x}:${crop.y},scale=1:1:flags=area,showinfo`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']
    const child = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let err = ''
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', () => {
      const raw = Buffer.concat(chunks)
      const pts = [...err.matchAll(/pts_time:\s*([-\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 1000))
      const out: { ptsMs: number; rgb: [number, number, number] }[] = []
      for (let i = 0; i < pts.length && i * 3 + 2 < raw.length; i++) out.push({ ptsMs: pts[i], rgb: [raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]] })
      resolve(out)
    })
  })
}

/**
 * Depois da gravação: cursor.json ao lado do rec.mp4, válido, do tamanho do vídeo de tela, amostras dentro da duração,
 * mapeamento parede → mídia com a pausa removida, nenhuma amostra no trecho pausado, clique injetado no lugar/instante
 * certos e alinhamento relógio × PTS do vídeo medido por um "flash" verde na janela do teste.
 */
export async function checkCursorAfterRecording(
  args: {
    st: CursorTestState
    sessionDir: string
    rec: string
    video: { width: number; height: number; durationMs: number; fps: number }
    rendererClicks: { x: number; y: number; rendererMediaMs: number; mainMediaMs: number | null }[]
    flashes: { mediaMs: number; color: 'green' | 'black'; wallMs: number }[]
    /** renderTime (Element Timing) do texto inserido junto de cada flash: quando ele foi apresentado na tela. */
    flashPaints: { id: string; renderTime: number }[]
    /** Início do relógio de mídia × 1º dado de mídia do Output (PTS 0), ambos em performance.now() do renderer. */
    clockVsPts: { clockStartMs: number | null; firstMediaMs: number | null } | null
    win: BrowserWindow
  },
  ok: Ok
): Promise<Record<string, unknown>> {
  const { st, sessionDir, video } = args
  const report: Record<string, unknown> = {}
  const file = join(sessionDir, CURSOR_FILE)
  ok(existsSync(file), 'cursor: cursor.json existe ao lado do rec.mp4')
  if (!existsSync(file)) return report
  const track = parseCursorTrack(JSON.parse(readFileSync(file, 'utf8')))
  ok(!!track, 'cursor: cursor.json passa no parseCursorTrack')
  if (!track) return report
  ok(JSON.stringify(track) === JSON.stringify(st.track), 'cursor: arquivo igual à trilha encerrada no main')
  ok(track.width === video.width && track.height === video.height, `cursor: width/height = vídeo de tela (${track.width}×${track.height} vs ${video.width}×${video.height})`)
  const s = track.samples
  const frameMs = 1000 / video.fps
  const lastT = s[s.length - 1]?.tMs ?? 0
  ok(s.every((p, i) => i === 0 || p.tMs > s[i - 1].tMs) && s.every((p) => Number.isInteger(p.tMs)), 'cursor: tMs inteiros e estritamente crescentes')
  ok(lastT <= video.durationMs + frameMs, `cursor: última amostra (${lastT} ms) ≤ duração do vídeo + 1 quadro (${video.durationMs} + ${frameMs.toFixed(1)} ms)`)
  const rec = st.rec
  if (rec && st.t0 !== null) {
    const disp = st.display
    const phys = screen.dipToScreenRect(null, disp.bounds)
    const scale = disp.scaleFactor
    const start = rec.startedAtMs
    const pauses = rec.pauses
    let maxMapErr = 0
    let inPause = 0
    for (const p of s) {
      const dipX = disp.bounds.x + (p.x * phys.width) / scale
      const wall = st.t0 + (dipX - disp.bounds.x - SYN_MARGIN) * SYN_MS_PER_PX
      let paused = 0
      for (const q of pauses) paused += Math.max(0, Math.min(q.endMs, wall) - q.startMs)
      maxMapErr = Math.max(maxMapErr, Math.abs(p.tMs - (wall - start - paused)))
      if (pauses.some((q) => wall > q.startMs + 2 && wall < q.endMs - 2)) inPause++
    }
    const runMs = Math.max(1, lastT)
    const hz = (s.length - 1) / (runMs / 1000)
    report.samples = { count: s.length, hz: +hz.toFixed(1), maxWallToMediaErrMs: +maxMapErr.toFixed(2), pauses: pauses.map((q) => ({ startMs: +(q.startMs - start).toFixed(1), endMs: +(q.endMs - start).toFixed(1) })) }
    ok(pauses.length === 1, `cursor: 1 pausa no relógio do main (${pauses.length})`)
    ok(inPause === 0, `cursor: nenhuma amostra dentro do trecho pausado (${inPause})`)
    ok(maxMapErr <= 2, `cursor: tMs = parede − início − pausas (erro máx. ${maxMapErr.toFixed(2)} ms)`)
    ok(hz >= 50, `cursor: cadência ≈ 60 Hz (${hz.toFixed(1)} amostras/s de mídia)`)
  }
  // clique injetado: posição pelo screen.dipToScreenPoint do Electron (independente do helper puro) e instante
  const clickReport: unknown[] = []
  for (const c of args.rendererClicks) {
    const phys = screen.dipToScreenRect(null, st.display.bounds)
    const expected = normalizeToFrame(screen.dipToScreenPoint({ x: c.x, y: c.y }), phys)
    const got = track.clicks.find((k) => Math.abs(k.x - expected.x) <= 0.002 && Math.abs(k.y - expected.y) <= 0.002)
    clickReport.push({ expected, got, rendererMediaMs: c.rendererMediaMs, mainMediaMs: c.mainMediaMs })
    ok(!!got, `cursor: clique injetado presente em ±0,002 (esperado ${expected.x.toFixed(4)}, ${expected.y.toFixed(4)}; cliques ${JSON.stringify(track.clicks)})`)
    if (got) ok(Math.abs(got.tMs - c.rendererMediaMs) <= 40, `cursor: clique em ±40 ms do instante da injeção no renderer (${got.tMs} vs ${c.rendererMediaMs} ms)`)
  }
  report.clicks = clickReport
  // alinhamento relógio de mídia × PTS: primeiro quadro com a cor do flash no centro da janela do teste
  try {
    const cb = screen.dipToScreenRect(args.win, args.win.getContentBounds())
    const dphys = screen.dipToScreenRect(null, st.display.bounds)
    const cx = ((cb.x + cb.width / 2 - dphys.x) / dphys.width) * video.width
    const cy = ((cb.y + cb.height / 2 - dphys.y) / dphys.height) * video.height
    const frames = await cropColors(args.rec, { x: Math.max(0, Math.round(cx - 8)), y: Math.max(0, Math.round(cy - 8)) })
    const isGreen = (c: [number, number, number]): boolean => c[1] > 160 && c[0] < 90 && c[2] < 90
    const isBlack = (c: [number, number, number]): boolean => c[0] < 40 && c[1] < 40 && c[2] < 40
    const align: unknown[] = []
    let from = 0
    for (const [i, f] of args.flashes.entries()) {
      const paint = args.flashPaints.find((p) => p.id === `flash-${i + 1}`)
      const paintMs = paint && paint.renderTime > 0 ? paint.renderTime - f.wallMs : null
      const idx = frames.findIndex((fr, i) => i >= from && (f.color === 'green' ? isGreen(fr.rgb) : isBlack(fr.rgb)) && fr.ptsMs >= f.mediaMs - 500)
      if (idx < 0) {
        align.push({ ...f, found: false })
        console.log(`AVISO cursor: flash ${f.color} em ${f.mediaMs} ms não encontrado no vídeo (janela coberta?)`)
        continue
      }
      from = idx
      const errMs = frames[idx].ptsMs - f.mediaMs
      // erro total = pintura da página (até a apresentação) + captura/entrega do quadro + quantização a 1/fps
      align.push({ ...f, found: true, firstFramePtsMs: frames[idx].ptsMs, errMs, paintMs, captureMs: paintMs === null ? null : +(errMs - paintMs).toFixed(1) })
    }
    report.ptsAlignment = align
    const cz = args.clockVsPts
    if (cz?.clockStartMs != null && cz.firstMediaMs != null) {
      const zeroMs = cz.firstMediaMs - cz.clockStartMs
      report.clockZeroVsPtsZeroMs = +zeroMs.toFixed(1)
      ok(Math.abs(zeroMs) <= 1000 / video.fps, `cursor: zero do relógio de mídia × PTS 0 do vídeo ≤ 1 quadro (${zeroMs.toFixed(1)} ms)`)
    } else console.log('AVISO cursor: instante do PTS 0 indisponível (campo interno do mediabunny)')
    console.log(`cursor: alinhamento relógio de mídia × PTS (flash): ${JSON.stringify(align)}`)
  } catch (e) {
    console.log('AVISO cursor: medição de alinhamento × PTS falhou', e)
  }
  report.track = { samples: s.length, clicks: track.clicks }
  return report
}
