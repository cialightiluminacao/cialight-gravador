import { BrowserWindow, ipcMain } from 'electron'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import type { Asset, EffectItem, MediaItem, Project, Track } from '@shared/editor/project'
import { createEffectItem, createEmptyProject, createMediaItem } from '@shared/editor/factory'
import { addAsset } from '@shared/editor/ops'
import type { ProjectStore } from './project/projectStore'
import { probeFile, runFfmpeg } from './export/ffmpegRunner'
import { ffprobePath } from './export/ffmpegPath'
import { probe } from './media/probe'
import { assetFromInfo } from './media/ingest'
import { isFastStart } from './testFixtures'
import { loadPage, preloadPath } from './windows/recorderWindow'
import { check, checkEffects, countFrames, detailEnergy, FX_BLOCK, FX_BLUR, FX_OUTSIDE, FX_SOLID, FX_TARJA, gen, pcmOf, rmsDb, settingsHash, streamInfo, type EffectsOut } from './editorExportTestMode'
import { editorExportCounts } from './quitGuard'

// Teste de integração dos formatos extras da exportação do editor (CIALIGHT_TEST=editor-formats,
// `npm run test:editor-formats`). Projeto 1920×1080: ruído em células de 4 px + blur (0–3 s) + blur INVERTIDO
// (3–6 s, buraco nítido na mesma região) + tarja #123456 (0–6 s, por cima); áudio: tom de 440 Hz (0–2,5 s), tom
// de 660 Hz (3,5–6 s) e uma faixa MUDA com 1 kHz o tempo todo. Trecho I–O = [1 s, 5 s).
//  1. GIF 480 px / 12 fps: codec gif 480×270, quadros = frameCount (±0), loop infinito, tarja ±8 da cor em todo
//     quadro, blur com energia de detalhe ≤ a calibrada pelo PNG do mesmo instante reduzido, invertido escondendo
//     o fora do buraco; cancelamentos (quadros e finalização) sem .gif, .part ou temporários.
//  2. PNG em 1,5 s: 1920×1080, alfa 255, tarja exata (±0), = preview (readPixels do compositor; ≤ 1).
//  3. Só áudio wav/mp3/m4a: codec, 48 kHz estéreo, duração (wav: amostras exatas), RMS dos tons = áudio da
//     exportação de vídeo do mesmo trecho (≤ 0,5 dB), silêncio no vão ≤ −60 dB, m4a com faststart.
//  4. Fila (F7 Task 4): 4 itens pela fila do app — vídeo 720p I–O, GIF, wav e um vídeo 360p com o MESMO nome do
//     1º — todos concluídos e válidos (ffprobe), o repetido numerado "fila (2).mp4", estritamente em sequência
//     (início de cada um ≥ fim do anterior; nunca 2 rodando), o vídeo com os efeitos do instantâneo (checkEffects:
//     os efeitos foram apagados do editor depois de enfileirar), o estado da fila no main (confirmação de saída)
//     visto com 1 rodando + 3 na fila e zerado no fim; 2ª fila com o item rodando cancelado no meio: sem parcial e
//     o seguinte concluído.
//  5. settings.json intocado.

const PROJECT_ID = 'p-editor-formats'
const W = 1920
const H = 1080
const FPS = 30
const IN_US = 1_000_000
const OUT_US = 5_000_000
const GIF_W = 480
const GIF_H = 270
const GIF_FPS = 12
const PNG_US = 1_500_000
const PNG_INV_US = 4_000_000
// depois do fim do conteúdo: o PNG é só o fundo do projeto (opaco, na cor do fundo)
const PNG_BG_US = 7_000_000
const BACKGROUND = [0x20, 0x30, 0x40]
// janelas (s, no tempo do arquivo exportado = timeline − 1 s): tom de 440 Hz, vão sem nada audível, tom de 660 Hz
const TONE1 = [0.2, 1.3] as const
const GAP = [1.7, 2.3] as const
const TONE2 = [2.7, 3.8] as const
// Borrado no GIF × o PNG do mesmo instante reduzido para 480×270 (área): energia de detalhe ≤ a do PNG + 1 (nível²).
// Medido: GIF 0,04 × PNG 0,09 (blur) e 0,06 × 0,17 (invertido) — a paleta não pontilha o degradê liso a ponto de
// devolver detalhe; o ruído de fora mede ~21 400. Margem de 1 nível² para variação de paleta/pontilhado.
const BLUR_GIF_MARGIN = 1
// marcador de ORIENTAÇÃO: tarja #a05030 fora do centro (terço de cima, à esquerda); o espelho vertical dela (y = 0,85)
// é ruído/borrado. Um GIF de cabeça para baixo (readPixels sem desvirar) põe a cor no lugar errado e falha.
// Bordas em pixels inteiros a 480×270 (x 96–192, y 27–54) e a 1920×1080.
const MARKER = { x: 0.3, y: 0.15, w: 0.2, h: 0.1 }
const MARKER_RGB = [0xa0, 0x50, 0x30]

type Region = { x: number; y: number; w: number; h: number }
interface FileOut { path?: string; size?: number; error?: string; warnings?: string[]; frames?: number; width?: number; height?: number }
interface PngOut { file?: FileOut; sha256?: string; bytes?: number; error?: string; vsPreview?: { maxDiff: number; diffPixels: number; blurMaxDiff: number; alphaMin: number; tarja: { worst: number; pixels: number; png: number[]; preview: number[] } } }
interface Report {
  errors: string[]
  range?: { fromUs: number; toUs: number }
  gif?: FileOut
  gifExpectedFrames?: number
  gifProgress?: { maxRender: number; minFinalize: number; last: { stage: string; percent: number } | null; monotonic: boolean }
  gifCancel?: { cancelled: boolean; at: unknown; error?: string }
  gifCancelPalette?: { cancelled: boolean; at: unknown; error?: string }
  png?: PngOut
  pngInv?: PngOut
  pngBackground?: FileOut
  audio?: Record<'wav' | 'mp3' | 'm4a', FileOut>
  video?: FileOut & { audioCodec?: string }
  audioMuted?: { blocker: string | null; run: FileOut }
  queueSnapshot?: { storeEffects: number; itemEffects: number; sameAsSnapshot: boolean; frozen: boolean }
  queue?: { items: QueueOut[]; maxRunning: number; fractionMonotonic: boolean; lastFraction: number | null }
  queueEffects?: EffectsOut
  queueCancel?: { at: { frame: number; percent: number } | null; maxRunning: number; items: QueueOut[] }
}
interface QueueOut { id: string; label: string; kind: string; state: string; path: string | null; message: string | null; startedAt: number | null; endedAt: number | null }

/** Recorte em pixels (par) de uma região normalizada, com `inset` px de margem para dentro. */
function pxRegion(r: Region, w: number, h: number, inset = 0): Region {
  const ev = (v: number): number => Math.round(v / 2) * 2
  return { x: ev((r.x - r.w / 2) * w + inset), y: ev((r.y - r.h / 2) * h + inset), w: ev(r.w * w - 2 * inset), h: ev(r.h * h - 2 * inset) }
}

/** Recorte RGB24 de uma imagem RGB24 w×h. */
function crop(d: Uint8Array, w: number, c: Region): Uint8Array {
  const out = new Uint8Array(c.w * c.h * 3)
  for (let y = 0; y < c.h; y++) out.set(d.subarray(((c.y + y) * w + c.x) * 3, ((c.y + y) * w + c.x + c.w) * 3), y * c.w * 3)
  return out
}

/** Todos os quadros do GIF como RGB24 (sem duplicar/descartar: fps_mode passthrough). */
async function gifFrames(file: string, out: string): Promise<Uint8Array[]> {
  await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', file, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', out], { label: 'teste: quadros do GIF' })
  const b = new Uint8Array(readFileSync(out))
  const n = GIF_W * GIF_H * 3
  const frames: Uint8Array[] = []
  for (let i = 0; i + n <= b.length; i += n) frames.push(b.subarray(i, i + n))
  return frames
}

/** Imagem reduzida para w×h (área) como RGB24. */
async function scaledRgb(file: string, w: number, h: number, out: string): Promise<Uint8Array> {
  await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', file, '-vf', `scale=${w}:${h}:flags=area`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', out], { label: 'teste: reduzido' })
  return new Uint8Array(readFileSync(out))
}

/** Bloco de extensão de aplicação NETSCAPE2.0 do GIF: contagem de repetições (0 = infinito) ou null. */
function gifLoopCount(file: string): number | null {
  const b = readFileSync(file)
  const i = b.indexOf('NETSCAPE2.0')
  if (i < 0 || b[i + 11] !== 3 || b[i + 12] !== 1) return null
  return b[i + 13] | (b[i + 14] << 8)
}

/** Tipo de cor do PNG (IHDR): 2 = RGB, 6 = RGBA. */
function pngColorType(file: string): number {
  return readFileSync(file)[25]
}

function probeAudio(file: string): Promise<{ codec_name?: string; sample_rate?: string; channels?: number; duration_ts?: number } | null> {
  return new Promise((resolve) => {
    execFile(ffprobePath(), ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels,duration_ts', '-of', 'json', file], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      try {
        resolve((JSON.parse(String(stdout)) as { streams?: Record<string, never>[] }).streams?.[0] ?? null)
      } catch {
        resolve(null)
      }
    })
  })
}

async function buildProject(dir: string, projects: ProjectStore): Promise<void> {
  const noise = join(dir, 'ruido.png')
  await gen(['-f', 'lavfi', '-i', `nullsrc=s=480x270,format=gray,geq=lum=random(1)*255,scale=${W}:${H}:flags=neighbor`, '-frames:v', '1', '-update', '1', noise], 'formatos: ruído')
  const tone = async (name: string, hz: number, durS: number, amp = 0.3): Promise<Asset> => {
    const f = join(dir, `${name}.m4a`)
    const e = `${amp}*sin(2*PI*${hz}*t)`
    await gen(['-f', 'lavfi', '-i', `aevalsrc='${e}|${e}':s=48000:d=${durS}`, '-c:a', 'aac', '-b:a', '192k', f], `formatos: ${name}`)
    return { ...assetFromInfo(`a_${name}`, f, statSync(f), await probe(f)), status: 'ready' }
  }
  const aNoise: Asset = { ...assetFromInfo('a_ruido', noise, statSync(noise), await probe(noise)), status: 'ready' }
  const a440 = await tone('tom440', 440, 2.5)
  const a660 = await tone('tom660', 660, 2.5)
  const a1k = await tone('tom1k-mudo', 1000, 6, 0.5)
  const vt = (id: string, item: MediaItem | EffectItem): Track => ({ id, kind: 'video', name: id, muted: false, hidden: false, locked: false, volume: 1, items: [item] })
  const at = (id: string, item: MediaItem, muted = false): Track => ({ id, kind: 'audio', name: id, muted, hidden: false, locked: false, volume: 1, items: [item] })
  const audioItem = (a: Asset, startUs: number, durUs: number): MediaItem => ({ ...createMediaItem(a, startUs, 'audio'), durationUs: durUs })
  const blur: EffectItem = createEffectItem('blur', 0, 3_000_000, FX_BLUR)
  const inverted: EffectItem = { ...createEffectItem('blur', 3_000_000, 3_000_000, FX_BLUR), invert: true }
  const solid: EffectItem = { ...createEffectItem('solid', 0, 6_000_000, FX_SOLID), color: '#123456', feather: 0 }
  const marker: EffectItem = { ...createEffectItem('solid', 0, 6_000_000, MARKER), color: '#a05030', feather: 0 }
  let p: Project = { ...createEmptyProject('Formatos', { width: W, height: H, fps: FPS, background: '#203040' }), id: PROJECT_ID }
  for (const a of [aNoise, a440, a660, a1k]) p = addAsset(p, a)
  p = {
    ...p,
    tracks: [
      vt('t_ruido', { ...createMediaItem(aNoise, 0, 'video'), durationUs: 6_000_000 }),
      vt('t_blur', blur),
      vt('t_invertido', inverted),
      vt('t_tarja', solid),
      vt('t_marcador', marker),
      at('t_440', audioItem(a440, 0, 2_500_000)),
      at('t_660', audioItem(a660, 3_500_000, 2_500_000)),
      at('t_mudo', audioItem(a1k, 0, 6_000_000), true)
    ]
  }
  rmSync(projects.dirOf(PROJECT_ID), { recursive: true, force: true })
  projects.create(p)
}

export async function testEditorFormats(projects: ProjectStore, outDir: string): Promise<number> {
  const failures: string[] = []
  const hashBefore = settingsHash()
  const dir = join(outDir, 'editor-formats')
  const exportsDir = join(dir, 'saidas')
  const cancelDir = join(dir, 'cancelado')
  const cancelPaletteDir = join(dir, 'cancelado-paleta')
  const queueDir = join(dir, 'fila')
  const queueCancelDir = join(dir, 'fila-cancelada')
  rmSync(dir, { recursive: true, force: true })
  for (const d of [exportsDir, cancelDir, cancelPaletteDir, queueDir, queueCancelDir]) mkdirSync(d, { recursive: true })
  await buildProject(dir, projects)

  const win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { preload: preloadPath(), sandbox: false, backgroundThrottling: false, additionalArguments: ['--cialight-window=recorder'] } })
  // estado da fila no main (o mesmo que a confirmação de saída lê), amostrado durante o harness
  const seen = { running: 0, pending: 0 }
  const poll = setInterval(() => {
    const c = editorExportCounts()
    seen.running = Math.max(seen.running, c.running)
    seen.pending = Math.max(seen.pending, c.pending)
  }, 20)
  const result = await new Promise<{ ok: boolean; report: Report }>((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, report: { errors: ['timeout de 480 s'] } }), 480_000)
    ipcMain.once('test:result', (_e, r: { ok: boolean; report: Report }) => {
      clearTimeout(timer)
      resolve(r)
    })
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning') console.log(`[renderer] ${e.message}`)
    })
    const params = { projectId: PROJECT_ID, outputDir: exportsDir, cancelDir, cancelPaletteDir, inUs: IN_US, outUs: OUT_US, pngUs: PNG_US, pngInvUs: PNG_INV_US, pngBackgroundUs: PNG_BG_US, solid: FX_SOLID, blur: FX_BLUR, queueDir, queueCancelDir, block: FX_BLOCK, outside: FX_OUTSIDE }
    loadPage(win, `index.html#editor-formats-test/${encodeURIComponent(JSON.stringify(params))}`)
  })
  clearInterval(poll)
  const r = result.report
  // a referência do preview da fila (variância por bloco, RGB do miolo) é grande: fora do log
  console.log(`relatório do harness: ${JSON.stringify({ ...r, queueEffects: r.queueEffects ? { export: r.queueEffects.export, error: r.queueEffects.error } : undefined })}`)
  check(result.ok && r.errors.length === 0, `harness sem exceção (${JSON.stringify(r.errors)})`, failures)
  check(r.range?.fromUs === IN_US && r.range?.toUs === OUT_US, `trecho I–O = [1 s, 5 s) (${JSON.stringify(r.range)})`, failures)
  const durS = (OUT_US - IN_US) / 1e6

  // ---------------- 1. GIF ----------------
  const gif = r.gif?.path
  check(!!gif && existsSync(gif) && gif.endsWith('formatos.gif'), `GIF exportado com a extensão do formato (${gif ?? r.gif?.error})`, failures)
  if (gif && existsSync(gif)) {
    const st = await streamInfo(gif)
    check(st?.codec_name === 'gif' && st.width === GIF_W && st.height === GIF_H, `GIF: codec gif ${GIF_W}×${GIF_H} (${JSON.stringify(st)})`, failures)
    const n = await countFrames(gif)
    check(n === r.gifExpectedFrames && n === Math.round(durS * GIF_FPS), `GIF: quadros = frameCount(I–O, 12 fps) = ${r.gifExpectedFrames} (${n})`, failures)
    check(gifLoopCount(gif) === 0, `GIF: loop infinito (NETSCAPE2.0 = ${gifLoopCount(gif)})`, failures)
    const gp = r.gifProgress
    check(!!gp && gp.maxRender <= 80 && gp.minFinalize >= 80 && gp.last?.percent === 100 && gp.monotonic, `GIF: progresso quadros 0–80 %, paleta 80–100 %, crescente (${JSON.stringify(gp)})`, failures)
    check(readdirSync(exportsDir).every((f) => !f.endsWith('.part')), `GIF: nenhum .part/temporário na pasta (${readdirSync(exportsDir).join(', ')})`, failures)

    const frames = await gifFrames(gif, join(dir, 'gif-quadros.rgb'))
    check(frames.length === 48, `GIF: 48 quadros decodificados (${frames.length})`, failures)
    // tarja e marcador: TODO pixel inteiramente coberto pela região (a borda da tarja cai no meio de um pixel a
    // 480 px — x 273,6 e 417,6 —, e esse pixel é uma mistura de cobertura, não a cor), em TODO quadro: ±8 (paleta)
    const covered = (r: Region): Region => {
      const x0 = Math.ceil((r.x - r.w / 2) * GIF_W - 1e-6)
      const y0 = Math.ceil((r.y - r.h / 2) * GIF_H - 1e-6)
      const x1 = Math.floor((r.x + r.w / 2) * GIF_W + 1e-6)
      const y1 = Math.floor((r.y + r.h / 2) * GIF_H + 1e-6)
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    }
    const colourCheck = (r: Region, rgb: number[]): { worst: number; k: number; at: number[]; px: number[]; pixels: number } => {
      const c = covered(r)
      const out = { worst: 0, k: -1, at: [] as number[], px: [] as number[], pixels: 0 }
      frames.forEach((f, k) => {
        for (let y = c.y; y < c.y + c.h; y++) {
          for (let x = c.x; x < c.x + c.w; x++) {
            const i = (y * GIF_W + x) * 3
            const d = Math.max(Math.abs(f[i] - rgb[0]), Math.abs(f[i + 1] - rgb[1]), Math.abs(f[i + 2] - rgb[2]))
            out.pixels++
            if (d > out.worst || out.k < 0) Object.assign(out, { worst: Math.max(d, out.worst), k, at: [x, y], px: [f[i], f[i + 1], f[i + 2]] })
          }
        }
      })
      return out
    }
    const tj = colourCheck(FX_SOLID, FX_TARJA)
    const tc = covered(FX_SOLID)
    check(tj.pixels === 48 * tc.w * tc.h && tj.worst <= 8, `GIF: tarja ±8 de #123456 em TODO pixel coberto (${tc.w}×${tc.h}) de todo quadro (${tj.pixels} px; pior desvio ${tj.worst} no quadro ${tj.k} em ${tj.at}: ${tj.px})`, failures)
    // orientação: o marcador está em cima (y 27–54) e NÃO no espelho vertical (y 216–243)
    const mk = colourCheck(MARKER, MARKER_RGB)
    const mc = covered(MARKER)
    const mirror = covered({ ...MARKER, y: 1 - MARKER.y })
    let mirrorHits = 0
    frames.forEach((f) => {
      for (let y = mirror.y; y < mirror.y + mirror.h; y++) {
        for (let x = mirror.x; x < mirror.x + mirror.w; x++) {
          const i = (y * GIF_W + x) * 3
          if (Math.max(Math.abs(f[i] - MARKER_RGB[0]), Math.abs(f[i + 1] - MARKER_RGB[1]), Math.abs(f[i + 2] - MARKER_RGB[2])) <= 8) mirrorHits++
        }
      }
    })
    check(mc.w === 96 && mc.h === 27 && mk.worst <= 8, `GIF: orientação — marcador #a05030 no terço de cima (x ${mc.x}–${mc.x + mc.w}, y ${mc.y}–${mc.y + mc.h}) em todo pixel de todo quadro (pior desvio ${mk.worst} no quadro ${mk.k}: ${mk.px})`, failures)
    check(mirrorHits === 0, `GIF: orientação — nenhum pixel da cor do marcador no espelho vertical (y ${mirror.y}–${mirror.y + mirror.h}): ${mirrorHits} (de cabeça para baixo daria ${48 * mc.w * mc.h})`, failures)

    // blur (quadros 0–23 = 1,0–2,9 s): miolo borrado a 6 px da borda do feather (proporcional à altura: 24 px a 720p)
    const inset = Math.round((24 * GIF_H) / 720)
    const bc = pxRegion(FX_BLUR, GIF_W, GIF_H, inset)
    const oc = pxRegion(FX_OUTSIDE, GIF_W, GIF_H, 0)
    // referência: o PNG do mesmo instante (1,5 s = quadro 6) reduzido para o tamanho do GIF
    const pngFile = r.png?.file?.path
    let pngBlurE = NaN
    let pngOutE = NaN
    if (pngFile && existsSync(pngFile)) {
      const small = await scaledRgb(pngFile, GIF_W, GIF_H, join(dir, 'png-reduzido.rgb'))
      pngBlurE = detailEnergy(crop(small, GIF_W, bc), bc.w, bc.h)
      pngOutE = detailEnergy(crop(small, GIF_W, oc), oc.w, oc.h)
    }
    const eBlur = frames.slice(0, 24).map((f) => detailEnergy(crop(f, GIF_W, bc), bc.w, bc.h))
    const eOut = frames.slice(0, 24).map((f) => detailEnergy(crop(f, GIF_W, oc), oc.w, oc.h))
    const maxBlur = Math.max(...eBlur)
    const minOut = Math.min(...eOut)
    console.log(`GIF energia: blur ${eBlur.map((e) => e.toFixed(1)).join(' ')} | fora ${eOut.map((e) => e.toFixed(0)).join(' ')} | PNG reduzido blur ${pngBlurE.toFixed(2)} fora ${pngOutE.toFixed(1)}`)
    check(Number.isFinite(pngBlurE) && maxBlur <= pngBlurE + BLUR_GIF_MARGIN, `GIF: blur — energia de detalhe do miolo ≤ a do PNG do mesmo instante reduzido + ${BLUR_GIF_MARGIN} em todo quadro (pior ${maxBlur.toFixed(2)}; PNG ${pngBlurE.toFixed(2)})`, failures)
    check(maxBlur < 0.1 * minOut, `GIF: blur — miolo borrado ${maxBlur.toFixed(1)} < 10 % do ruído de fora ${minOut.toFixed(1)} (o conteúdo continua escondido a 480 px)`, failures)
    check(Number.isFinite(pngOutE) && minOut >= 0.5 * pngOutE, `GIF: fora da região o ruído continua (energia ${minOut.toFixed(1)} ≥ 50 % da do PNG reduzido ${pngOutE.toFixed(1)})`, failures)

    // invertido (quadros 24–47 = 3,0–4,9 s): fora do buraco borrado, buraco nítido
    const hole = pxRegion(FX_BLUR, GIF_W, GIF_H, inset)
    const eInvOut = frames.slice(24).map((f) => detailEnergy(crop(f, GIF_W, oc), oc.w, oc.h))
    const eHole = frames.slice(24).map((f) => detailEnergy(crop(f, GIF_W, hole), hole.w, hole.h))
    const pngInv = r.pngInv?.file?.path
    let pngInvOutE = NaN
    if (pngInv && existsSync(pngInv)) {
      const small = await scaledRgb(pngInv, GIF_W, GIF_H, join(dir, 'png-inv-reduzido.rgb'))
      pngInvOutE = detailEnergy(crop(small, GIF_W, oc), oc.w, oc.h)
    }
    const maxInvOut = Math.max(...eInvOut)
    const minHole = Math.min(...eHole)
    console.log(`GIF invertido: fora ${eInvOut.map((e) => e.toFixed(1)).join(' ')} | buraco ${eHole.map((e) => e.toFixed(0)).join(' ')} | PNG reduzido fora ${pngInvOutE.toFixed(2)}`)
    check(maxInvOut < 0.1 * minHole, `GIF: blur invertido — fora do buraco ${maxInvOut.toFixed(1)} < 10 % do buraco nítido ${minHole.toFixed(1)} em todo quadro`, failures)
    check(Number.isFinite(pngInvOutE) && maxInvOut <= pngInvOutE + BLUR_GIF_MARGIN, `GIF: blur invertido — fora do buraco ≤ o PNG reduzido + ${BLUR_GIF_MARGIN} (pior ${maxInvOut.toFixed(2)}; PNG ${pngInvOutE.toFixed(2)})`, failures)
  }
  for (const [name, c, d] of [['nos quadros', r.gifCancel, cancelDir], ['na finalização', r.gifCancelPalette, cancelPaletteDir]] as const) {
    const left = existsSync(d) ? readdirSync(d) : []
    check(!!c?.cancelled && left.length === 0, `GIF cancelado ${name} (${JSON.stringify(c?.at)}): sem .gif, .part nem temporários (${left.join(', ') || 'pasta vazia'}) ${c?.error ?? ''}`, failures)
  }

  // ---------------- 2. PNG ----------------
  for (const [name, png, tUs] of [['1,5 s', r.png, PNG_US], ['4 s (invertido)', r.pngInv, PNG_INV_US]] as const) {
    const f = png?.file?.path
    check(!!f && existsSync(f), `PNG em ${name}: gravado (${f ?? png?.error})`, failures)
    if (!f || !existsSync(f)) continue
    const expectName = `Formatos - 00m0${Math.floor(tUs / 1e6)}s.png`
    check(f.endsWith(expectName), `PNG em ${name}: nome "${expectName}" (${f.split(/[\\/]/).pop()})`, failures)
    const sha = createHash('sha256').update(readFileSync(f)).digest('hex')
    check(sha === png?.sha256, `PNG em ${name}: o arquivo = os bytes renderizados de novo (render determinístico; sha ${sha.slice(0, 12)} × ${png?.sha256?.slice(0, 12)})`, failures)
    const st = await streamInfo(f)
    check(st?.codec_name === 'png' && st.width === W && st.height === H, `PNG em ${name}: ${W}×${H} (${JSON.stringify(st)})`, failures)
    const rgba = await (async () => {
      const out = join(dir, `png-${tUs}.rgba`)
      await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'rgba', out], { label: 'teste: png rgba' })
      return new Uint8Array(readFileSync(out))
    })()
    let alphaMin = 255
    for (let i = 3; i < rgba.length; i += 4) alphaMin = Math.min(alphaMin, rgba[i])
    const ct = pngColorType(f)
    check(rgba.length === W * H * 4 && alphaMin === 255 && (ct === 2 || ct === 6), `PNG em ${name}: opaco — alfa 255 em todo pixel (tipo de cor ${ct === 2 ? 'RGB' : ct === 6 ? 'RGBA' : ct}; mínimo ${alphaMin})`, failures)
    // tarja exata (±0) na decodificação do ffmpeg (independente do navegador): todo pixel a 2 px da borda
    const sb = pxRegion(FX_SOLID, W, H, 2)
    let tw = 0
    for (let y = sb.y; y < sb.y + sb.h; y++) for (let x = sb.x; x < sb.x + sb.w; x++) for (let c = 0; c < 3; c++) tw = Math.max(tw, Math.abs(rgba[(y * W + x) * 4 + c] - FX_TARJA[c]))
    check(tw === 0, `PNG em ${name}: tarja com a cor EXATA #123456 (${sb.w}×${sb.h} px; desvio máximo ${tw})`, failures)
    const v = png?.vsPreview
    check(!!v && v.maxDiff <= 1 && v.blurMaxDiff <= 1 && v.alphaMin === 255 && v.tarja.worst === 0, `PNG em ${name}: = preview (readPixels do compositor no mesmo instante): dif. máx ${v?.maxDiff} (${v?.diffPixels} px diferentes), região do blur ${v?.blurMaxDiff}, tarja ${v?.tarja.worst} (${v?.tarja.pixels} px), alfa mín ${v?.alphaMin}`, failures)
  }

  const bg = r.pngBackground?.path
  check(!!bg && existsSync(bg) && bg.endsWith('fundo.png'), `PNG sem mídia (7 s): gravado (${bg ?? r.pngBackground?.error})`, failures)
  if (bg && existsSync(bg)) {
    const out = join(dir, 'png-fundo.rgba')
    await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', bg, '-f', 'rawvideo', '-pix_fmt', 'rgba', out], { label: 'teste: png fundo' })
    const px = new Uint8Array(readFileSync(out))
    let worst = 0
    for (let i = 0; i < px.length; i += 4) worst = Math.max(worst, Math.abs(px[i] - BACKGROUND[0]), Math.abs(px[i + 1] - BACKGROUND[1]), Math.abs(px[i + 2] - BACKGROUND[2]), 255 - px[i + 3])
    check(px.length === W * H * 4 && worst === 0, `PNG sem mídia: opaco e na cor do fundo #203040 em todo pixel (desvio máximo ${worst})`, failures)
  }

  // ---------------- 3. Só áudio ----------------
  const ref = r.video?.path
  check(!!ref && existsSync(ref), `vídeo de referência do mesmo trecho exportado (${ref ?? r.video?.error}; áudio ${r.video?.audioCodec})`, failures)
  const refLevels = ref && existsSync(ref) ? { t1: await rmsDb(ref, ...TONE1), gap: await rmsDb(ref, ...GAP), t2: await rmsDb(ref, ...TONE2) } : null
  console.log(`referência (vídeo): ${JSON.stringify(refLevels)}`)
  check(!!refLevels && refLevels.t1 > -20 && refLevels.t2 > -20 && refLevels.gap <= -60, `referência: tons audíveis e vão em silêncio (${JSON.stringify(refLevels)})`, failures)
  const codecs = { wav: 'pcm_s16le', mp3: 'mp3', m4a: 'aac' } as const
  for (const fmt of ['wav', 'mp3', 'm4a'] as const) {
    const out = r.audio?.[fmt]
    const f = out?.path
    check(!!f && existsSync(f) && f.endsWith(`audio-${fmt}.${fmt}`), `só áudio ${fmt}: exportado (${f ?? out?.error})`, failures)
    if (!f || !existsSync(f)) continue
    const a = await probeAudio(f)
    check(a?.codec_name === codecs[fmt] && a.sample_rate === '48000' && a.channels === 2, `só áudio ${fmt}: ${codecs[fmt]} 48 kHz estéreo (${JSON.stringify(a)})`, failures)
    const pr = await probeFile(f)
    if (fmt === 'wav') {
      const pcm = await pcmOf(f, join(dir, 'wav.f32'), 2)
      check(pcm.length / 2 === 192_000 && a?.duration_ts === 192_000, `só áudio wav: ${durS} s = 192 000 amostras exatas (decodificado ${pcm.length / 2}; duration_ts ${a?.duration_ts})`, failures)
    } else check(Math.abs(pr.durationMs - durS * 1000) <= 50, `só áudio ${fmt}: duração ${durS} s ± 50 ms (${pr.durationMs} ms)`, failures)
    if (fmt === 'm4a') check(isFastStart(f), 'só áudio m4a: faststart (moov antes do mdat)', failures)
    const lv = { t1: await rmsDb(f, ...TONE1), gap: await rmsDb(f, ...GAP), t2: await rmsDb(f, ...TONE2) }
    if (refLevels) {
      const d1 = Math.abs(lv.t1 - refLevels.t1)
      const d2 = Math.abs(lv.t2 - refLevels.t2)
      check(d1 <= 0.5 && d2 <= 0.5, `só áudio ${fmt}: RMS dos tons = o da exportação de vídeo (440 Hz ${lv.t1} × ${refLevels.t1} dB; 660 Hz ${lv.t2} × ${refLevels.t2} dB; dif. ${d1.toFixed(2)} / ${d2.toFixed(2)} ≤ 0,5)`, failures)
    }
    check(lv.gap <= -60, `só áudio ${fmt}: vão (faixa de 1 kHz muda) em silêncio ≤ −60 dB (${lv.gap} dB)`, failures)
  }
  check(r.audioMuted?.blocker === 'Não há áudio para exportar' && /Não há áudio para exportar/.test(r.audioMuted?.run.error ?? ''), `só áudio sem nada audível: bloqueado (${r.audioMuted?.blocker}) e recusado (${r.audioMuted?.run.error})`, failures)

  // ---------------- 4. Fila ----------------
  const qs = r.queueSnapshot
  check(!!qs && qs.storeEffects === 0 && qs.itemEffects === 4 && qs.sameAsSnapshot && qs.frozen, `fila: instantâneo — efeitos apagados do editor depois de enfileirar e o item com os 4 do momento, mesmo objeto, congelado (${JSON.stringify(qs)})`, failures)
  const q = r.queue
  const qi = q?.items ?? []
  check(qi.length === 4 && qi.every((i) => i.state === 'done'), `fila: 4 itens concluídos (${JSON.stringify(qi.map((i) => [i.kind, i.state, i.message]))})`, failures)
  const names = qi.map((i) => (i.path ? basename(i.path) : null))
  check(JSON.stringify(names) === JSON.stringify(['fila.mp4', 'fila.gif', 'fila.wav', 'fila (2).mp4']), `fila: nomes na ordem, o repetido numerado sem sobrescrever (${JSON.stringify(names)})`, failures)
  const ordered = qi.every((i, k) => k === 0 || (i.startedAt != null && qi[k - 1].endedAt != null && i.startedAt >= (qi[k - 1].endedAt ?? Infinity)))
  check(ordered && q?.maxRunning === 1, `fila: estritamente em sequência, na ordem da fila (início ≥ fim do anterior; máx. rodando juntos ${q?.maxRunning}): ${JSON.stringify(qi.map((i) => [i.startedAt, i.endedAt]))}`, failures)
  check(!!q?.fractionMonotonic && q.lastFraction === 1, `fila: progresso global crescente até 100 % (último ${q?.lastFraction})`, failures)
  check(seen.running === 1 && seen.pending === 3, `fila: o main viu 1 rodando + 3 na fila (texto da confirmação de saída) (${JSON.stringify(seen)})`, failures)
  const after = editorExportCounts()
  check(after.running === 0 && after.pending === 0, `fila: estado no main zerado no fim (${JSON.stringify(after)})`, failures)
  const qfiles = existsSync(queueDir) ? readdirSync(queueDir) : []
  check(qfiles.length === 4 && qfiles.every((f) => !f.endsWith('.part')), `fila: só os 4 arquivos na pasta, sem .part (${qfiles.join(', ')})`, failures)
  const expectStream: [number, string, number, number][] = [
    [0, 'h264', 1280, 720],
    [1, 'gif', GIF_W, GIF_H],
    [3, 'h264', 640, 360]
  ]
  for (const [k, codec, w, h] of expectStream) {
    const f = qi[k]?.path
    const st = f && existsSync(f) ? await streamInfo(f) : null
    check(st?.codec_name === codec && st.width === w && st.height === h, `fila: ${names[k]} válido — ${codec} ${w}×${h} (${JSON.stringify(st)})`, failures)
  }
  const wavFile = qi[2]?.path
  const wavInfo = wavFile && existsSync(wavFile) ? await probeAudio(wavFile) : null
  check(wavInfo?.codec_name === 'pcm_s16le' && wavInfo.sample_rate === '48000' && wavInfo.channels === 2 && wavInfo.duration_ts === 192_000, `fila: fila.wav válido — PCM 48 kHz estéreo, 192 000 amostras (${JSON.stringify(wavInfo)})`, failures)
  await checkEffects('fila', 'item de vídeo 720p I–O da fila (instantâneo com efeitos)', r.queueEffects, { w: 1280, h: 720, codec: 'h264' }, dir, failures)
  const qc = r.queueCancel
  const cancelLeft = existsSync(queueCancelDir) ? readdirSync(queueCancelDir) : []
  check(!!qc?.at && qc.items[0]?.state === 'cancelled' && qc.items[1]?.state === 'done' && qc.maxRunning === 1, `fila: item rodando cancelado no meio (${JSON.stringify(qc?.at)}) e o seguinte concluído (${JSON.stringify(qc?.items.map((i) => [i.label, i.state, i.message]))})`, failures)
  check(cancelLeft.length === 1 && cancelLeft[0] === 'fila-depois.wav', `fila: cancelado sem parcial (.part/.mp4) e o seguinte gravado (${cancelLeft.join(', ') || 'pasta vazia'})`, failures)

  check(settingsHash() === hashBefore, 'settings.json do usuário intocado', failures)
  win.destroy()
  writeFileSync(join(outDir, 'editor-formats-report.json'), JSON.stringify({ result, failures }, null, 2))
  console.log(failures.length ? `\nFALHAS (${failures.length}):\n - ${failures.join('\n - ')}` : '\nTESTE DOS FORMATOS DO EDITOR PASSOU')
  return failures.length ? 1 : 0
}

