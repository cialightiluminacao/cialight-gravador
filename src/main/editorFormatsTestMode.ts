import { BrowserWindow, ipcMain } from 'electron'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import type { Asset, EffectItem, MediaItem, Project, Track } from '@shared/editor/project'
import { createEffectItem, createEmptyProject, createMediaItem } from '@shared/editor/factory'
import { addAsset, addMediaFromAsset } from '@shared/editor/ops'
import type { ProjectStore } from './project/projectStore'
import { probeFile, runFfmpeg } from './export/ffmpegRunner'
import { ffprobePath } from './export/ffmpegPath'
import { probe } from './media/probe'
import { assetFromInfo } from './media/ingest'
import { crossCorrelationLag, isFastStart } from './testFixtures'
import { loadPage, preloadPath } from './windows/recorderWindow'
import { BT709, check, checkEffects, countFrames, detailEnergy, frameRgb, FX_BLOCK, FX_BLUR, FX_OUTSIDE, FX_PIXEL, FX_PIXEL_STRENGTH, FX_SOLID, FX_TARJA, gen, NOISE_LUMA_VAR, pcmOf, PIXEL_GUARD_CODEC, PIXEL_MIN_BLOCKS, PIXEL_STEP_MIN, PIXEL_VAR_MAX_CODEC, pixelateCheck, pixelateText, psnr, rmsDb, settingsHash, streamInfo, type EffectsOut, type ExportOut } from './editorExportTestMode'
import { editorExportCounts } from './quitGuard'

// Teste de integração dos formatos extras da exportação do editor (CIALIGHT_TEST=editor-formats,
// `npm run test:editor-formats`). Projeto 1920×1080: ruído em células de 4 px + blur (0–3 s) + blur INVERTIDO
// (3–6 s, buraco nítido na mesma região) + tarja #123456 (0–6 s, por cima) + pixelização (0–3 s, faixa de cima);
// áudio: tom de 440 Hz (0–2,5 s), tom de 660 Hz (3,5–6 s) e uma faixa MUDA com 1 kHz o tempo todo. Trecho I–O =
// [1 s, 5 s).
//  1. GIF 480 px / 12 fps: codec gif 480×270, quadros = frameCount (±0), loop infinito, tarja ±8 da cor em todo
//     quadro, blur com energia de detalhe ≤ a calibrada pelo PNG do mesmo instante reduzido, invertido escondendo
//     o fora do buraco, pixelização com blocos uniformes na grade do compositor (pixelateCheck) em todo quadro
//     em que está ativa; cancelamentos (quadros e finalização) sem .gif, .part ou temporários.
//  2. PNG em 1,5 s: 1920×1080, alfa 255, tarja exata (±0), pixelização exata (variância 0 por bloco), = preview
//     (readPixels do compositor; ≤ 1).
//  3. Só áudio wav/mp3/m4a: codec, 48 kHz estéreo, duração (wav: amostras exatas), RMS dos tons = áudio da
//     exportação de vídeo do mesmo trecho (≤ 0,5 dB), silêncio no vão ≤ −60 dB, m4a com faststart.
//  4. Fila (F7 Task 4): 4 itens pela fila do app — vídeo 720p I–O, GIF, wav e um vídeo 360p com o MESMO nome do
//     1º — todos concluídos e válidos (ffprobe), o repetido numerado "fila (2).mp4", estritamente em sequência
//     (início de cada um ≥ fim do anterior; nunca 2 rodando), o vídeo com os efeitos do instantâneo (checkEffects:
//     os efeitos foram apagados do editor depois de enfileirar), o estado da fila no main (confirmação de saída)
//     visto com 1 rodando + 3 na fila e zerado no fim; 2ª fila com o item rodando cancelado no meio: sem parcial e
//     o seguinte concluído.
//  5. Codificador de reserva (F7 Task 5): o trecho I–O em 1920×1080 / 12 Mbps pelo WebCodecs (A) e com falhas
//     simuladas de hardware E software (B → libx264 por pipe): B fellBackToX264, H.264 High yuv420p BT.709 tv
//     (marcado como A), quadros = frameCount = A, duração = A ± 1 quadro, AAC 48 kHz estéreo, faststart; pixels A × B
//     em 6 instantes (PSNR ≥ 35 dB, média |dif.| ≤ 3 por canal) e sem deslocamento de quadro (1º quadro nítido do
//     buraco do invertido = 60 nos dois); privacidade em B (checkEffects da variante 1080p/12 Mbps, tarja ±3 em todo
//     bloco, blur/invertido e pixelização em cada instante, tarja ±3 em TODO quadro de 1–3 s do arquivo e
//     pixelização em TODO quadro em que está ativa); áudio A × B (RMS dos tons ≤ 0,5 dB, atraso 0 ± 1 ms); B cancelado no meio sem .mp4/.part/áudio temporário e uma nova exportação terminando; tamanho
//     alvo de 4 MB no projeto de 20 s pela reserva (2 passadas, final ≤ alvo).
//  6. settings.json intocado.

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
// pixelização no GIF (pixelateCheck, guard de 1 px nas bordas do bloco): medido 0,00 em todo quadro (a paleta tem a
// cor de cada bloco liso e o pontilhado sierra2_4a não age em área lisa); 1 cobre uma troca para a cor vizinha da
// paleta (1–2 níveis) em parte do bloco, e continua 1/5400 da variância do ruído da fonte. Degrau medido 8,4
const PIXEL_GUARD_GIF = 1
const PIXEL_VAR_MAX_GIF = 1
// marcador de ORIENTAÇÃO: tarja #a05030 fora do centro (terço de cima, à esquerda); o espelho vertical dela (y = 0,85)
// é ruído/borrado. Um GIF de cabeça para baixo (readPixels sem desvirar) põe a cor no lugar errado e falha.
// Bordas em pixels inteiros a 480×270 (x 96–192, y 27–54) e a 1920×1080.
const MARKER = { x: 0.3, y: 0.15, w: 0.2, h: 0.1 }
const MARKER_RGB = [0xa0, 0x50, 0x30]
// codificador de reserva
const LONG_ID = 'p-editor-formats-20s'
const X264_TARGET_MB = 4
const X264_FRAMES = 120
// quadros comparados A × B (no meio do quadro: t = (n + 0,5)/30); < 60 = blur, ≥ 60 = invertido
const X264_SAMPLES = [6, 27, 45, 66, 90, 114]
const X264_PSNR_MIN = 35
const X264_MEAN_DIFF_MAX = 3
// tarja densa: todo quadro de 1–3 s do arquivo
const DENSE_FROM = 30
const DENSE_TO = 89
// pixelização ativa na timeline 0–3 s: quadros 0–59 de B (trecho I–O a partir de 1 s)
const PIXEL_LAST_FRAME = 59

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
  x264A?: X264Out
  x264B?: X264Out
  x264Effects?: Omit<EffectsOut, 'export'>
  x264Cancel?: X264Out
  x264AfterCancel?: X264Out
  x264Target?: X264Out
  x264TargetDurUs?: number
}
type X264Out = ExportOut & { fellBackToX264?: boolean; stages?: string[]; percentMonotonic?: boolean; lastPercent?: number | null; reserveFps?: number | null; audioMs?: number | null; cancelled?: boolean; at?: unknown }
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

/** Marcações de cor e perfil da faixa de vídeo (ffprobe). */
function videoTags(file: string): Promise<Record<string, string | number> | null> {
  return new Promise((resolve) => {
    execFile(ffprobePath(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,profile,pix_fmt,color_space,color_primaries,color_transfer,color_range,duration,width,height', '-of', 'json', file], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      try {
        resolve((JSON.parse(String(stdout)) as { streams?: Record<string, never>[] }).streams?.[0] ?? null)
      } catch {
        resolve(null)
      }
    })
  })
}

/** Quadros [from, to] (índice de decodificação) recortados em `c`, como RGB24 (um Uint8Array por quadro). */
async function framesRgb(file: string, from: number, to: number, c: Region, out: string): Promise<Uint8Array[]> {
  await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', file, '-vf', `select=between(n\\,${from}\\,${to}),crop=${c.w}:${c.h}:${c.x}:${c.y}`, '-fps_mode', 'passthrough', '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', out], { label: 'teste: quadros recortados' })
  const b = new Uint8Array(readFileSync(out))
  const n = c.w * c.h * 3
  const frames: Uint8Array[] = []
  for (let i = 0; i + n <= b.length; i += n) frames.push(b.subarray(i, i + n))
  return frames
}

/** Macroblocos 16×16 inteiros dentro da tarja (a mesma grade do checkEffects) no quadro w×h. */
function tarjaGrid(w: number, h: number): { bx0: number; by0: number; bx1: number; by1: number } {
  return {
    by0: Math.ceil(((FX_SOLID.y - FX_SOLID.h / 2) * h) / FX_BLOCK),
    bx0: Math.ceil(((FX_SOLID.x - FX_SOLID.w / 2) * w) / FX_BLOCK),
    by1: Math.floor(((FX_SOLID.y + FX_SOLID.h / 2) * h) / FX_BLOCK) - 1,
    bx1: Math.floor(((FX_SOLID.x + FX_SOLID.w / 2) * w) / FX_BLOCK) - 1
  }
}

/** Pior desvio da cor da tarja no centro de cada macrobloco (miolo e anel) de uma imagem RGB24 `iw` de largura cuja origem é (ox, oy) no quadro. */
function tarjaWorst(img: Uint8Array, iw: number, ox: number, oy: number, g: ReturnType<typeof tarjaGrid>): { inner: number; ring: number; n: number } {
  const out = { inner: 0, ring: 0, n: 0 }
  for (let by = g.by0; by <= g.by1; by++) {
    for (let bx = g.bx0; bx <= g.bx1; bx++) {
      const x = bx * FX_BLOCK + FX_BLOCK / 2 - ox
      const y = by * FX_BLOCK + FX_BLOCK / 2 - oy
      const i = (y * iw + x) * 3
      const d = Math.max(Math.abs(img[i] - FX_TARJA[0]), Math.abs(img[i + 1] - FX_TARJA[1]), Math.abs(img[i + 2] - FX_TARJA[2]))
      out.n++
      if (by === g.by0 || by === g.by1 || bx === g.bx0 || bx === g.bx1) out.ring = Math.max(out.ring, d)
      else out.inner = Math.max(out.inner, d)
    }
  }
  return out
}

async function buildLongProject(dir: string, projects: ProjectStore): Promise<void> {
  const src = join(dir, 'vinte.mp4')
  await gen(['-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=${FPS}`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '20', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30', '-pix_fmt', 'yuv420p', ...BT709, '-c:a', 'aac', '-b:a', '128k', '-ac', '2', src], 'formatos: 20 s')
  const a: Asset = { ...assetFromInfo('a_vinte', src, statSync(src), await probe(src)), status: 'ready' }
  rmSync(projects.dirOf(LONG_ID), { recursive: true, force: true })
  projects.create(addMediaFromAsset(addAsset({ ...createEmptyProject('Vinte segundos', { width: 1280, height: 720, fps: FPS, background: '#000000' }), id: LONG_ID }, a), a.id, 0).project)
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
  // pixelização só com o blur comum (0–3 s): de 3 a 6 s o invertido borra o quadro inteiro fora do buraco — inclusive
  // o que está sob ela — e os blocos ficariam todos da mesma média (sem degrau para provar a grade)
  const pixel: EffectItem = { ...createEffectItem('pixelate', 0, 3_000_000, FX_PIXEL), strength: { value: FX_PIXEL_STRENGTH }, feather: 0 }
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
      vt('t_pixelizar', pixel),
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
  const x264Dir = join(dir, 'reserva')
  const x264CancelDir = join(dir, 'reserva-cancelada')
  rmSync(dir, { recursive: true, force: true })
  for (const d of [exportsDir, cancelDir, cancelPaletteDir, queueDir, queueCancelDir, x264Dir, x264CancelDir]) mkdirSync(d, { recursive: true })
  await buildProject(dir, projects)
  await buildLongProject(dir, projects)

  const win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { preload: preloadPath(), sandbox: false, backgroundThrottling: false, additionalArguments: ['--cialight-window=recorder'] } })
  // estado da fila no main (o mesmo que a confirmação de saída lê), amostrado durante o harness
  const seen = { running: 0, pending: 0 }
  const poll = setInterval(() => {
    const c = editorExportCounts()
    seen.running = Math.max(seen.running, c.running)
    seen.pending = Math.max(seen.pending, c.pending)
  }, 20)
  const result = await new Promise<{ ok: boolean; report: Report }>((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, report: { errors: ['timeout de 900 s'] } }), 900_000)
    ipcMain.once('test:result', (_e, r: { ok: boolean; report: Report }) => {
      clearTimeout(timer)
      resolve(r)
    })
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning') console.log(`[renderer] ${e.message}`)
    })
    const params = { projectId: PROJECT_ID, outputDir: exportsDir, cancelDir, cancelPaletteDir, inUs: IN_US, outUs: OUT_US, pngUs: PNG_US, pngInvUs: PNG_INV_US, pngBackgroundUs: PNG_BG_US, solid: FX_SOLID, blur: FX_BLUR, queueDir, queueCancelDir, block: FX_BLOCK, outside: FX_OUTSIDE, x264Dir, x264CancelDir, longProjectId: LONG_ID, targetMB: X264_TARGET_MB }
    loadPage(win, `index.html#editor-formats-test/${encodeURIComponent(JSON.stringify(params))}`)
  })
  clearInterval(poll)
  const r = result.report
  // a referência do preview da fila (variância por bloco, RGB do miolo) é grande: fora do log
  console.log(`relatório do harness: ${JSON.stringify({ ...r, queueEffects: r.queueEffects ? { export: r.queueEffects.export, error: r.queueEffects.error } : undefined, x264Effects: r.x264Effects ? { error: r.x264Effects.error } : undefined })}`)
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

    // pixelização (quadros 0–23 = 1,0–2,9 s, todo quadro em que ela está ativa): blocos uniformes na grade do
    // compositor a 480×270 (bloco pela altura do GIF)
    const pix = frames.slice(0, 24).map((f) => pixelateCheck(f, GIF_W, GIF_H, 0, 0, GIF_W, GIF_H, FX_PIXEL, FX_PIXEL_STRENGTH, PIXEL_GUARD_GIF))
    const pw = pix.reduce((a, b) => (b.worstVar > a.worstVar ? b : a))
    const pk = pix.indexOf(pw)
    const minStep = Math.min(...pix.map((p) => p.step))
    const minBlocks = Math.min(...pix.map((p) => p.blocks))
    console.log(`GIF pixelização: variância pior por quadro ${pix.map((p) => p.worstVar.toFixed(2)).join(' ')} | degrau ${pix.map((p) => p.step.toFixed(1)).join(' ')}`)
    check(pix.length === 24 && minBlocks >= PIXEL_MIN_BLOCKS && pw.worstVar <= PIXEL_VAR_MAX_GIF && minStep >= PIXEL_STEP_MIN, `GIF: pixelização com blocos uniformes na grade do compositor em TODO quadro em que ela está ativa (0–23) — pior no quadro ${pk}: ${pixelateText(pw)}; mín. ${minBlocks} blocos, degrau mín. ${minStep.toFixed(1)} (variância ≤ ${PIXEL_VAR_MAX_GIF} a ${PIXEL_GUARD_GIF} px das bordas do bloco, paleta/pontilhado; ruído da fonte ≈ ${NOISE_LUMA_VAR})`, failures)
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
    // pixelização (ativa em 0–3 s: o PNG de 1,5 s) exata (sem perdas): cada bloco da grade do compositor com UMA cor (variância 0), degrau entre vizinhos
    const rgb = new Uint8Array(W * H * 3)
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) rgb.set(rgba.subarray(i, i + 3), j)
    const pix = pixelateCheck(rgb, W, H, 0, 0, W, H, FX_PIXEL, FX_PIXEL_STRENGTH, 0)
    if (tUs < 3_000_000) check(pix.blocks >= PIXEL_MIN_BLOCKS && pix.worstVar <= 1e-6 && pix.step >= PIXEL_STEP_MIN, `PNG em ${name}: pixelização exata — cada bloco inteiro de uma cor só (variância 0 em todo pixel do bloco): ${pixelateText(pix)}`, failures)
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
  check(!!qs && qs.storeEffects === 0 && qs.itemEffects === 5 && qs.sameAsSnapshot && qs.frozen, `fila: instantâneo — efeitos apagados do editor depois de enfileirar e o item com os 5 do momento, mesmo objeto, congelado (${JSON.stringify(qs)})`, failures)
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

  await checkX264(r, dir, x264Dir, x264CancelDir, failures)

  check(settingsHash() === hashBefore, 'settings.json do usuário intocado', failures)
  win.destroy()
  writeFileSync(join(outDir, 'editor-formats-report.json'), JSON.stringify({ result, failures }, null, 2))
  console.log(failures.length ? `\nFALHAS (${failures.length}):\n - ${failures.join('\n - ')}` : '\nTESTE DOS FORMATOS DO EDITOR PASSOU')
  return failures.length ? 1 : 0
}


/** 5. Codificador de reserva: A (WebCodecs) × B (libx264 por pipe), privacidade, áudio, cancelamento e tamanho alvo. */
async function checkX264(r: Report, dir: string, x264Dir: string, x264CancelDir: string, failures: string[]): Promise<void> {
  const A = r.x264A
  const B = r.x264B
  const fa = A?.path
  const fb = B?.path
  check(!!fa && existsSync(fa) && A?.fellBackToX264 === false && A?.fellBackToSoftware === false, `reserva: A (WebCodecs, sem falha) exportado (${fa ?? A?.error}; ${A?.videoCodec}, hw ${A?.hardware})`, failures)
  check(
    !!fb && existsSync(fb) && B?.fellBackToX264 === true && B.fellBackToSoftware === true && /libx264/.test(B.videoCodec ?? '') && !!B.warnings?.includes('Exportado com o codificador de reserva (mais lento)'),
    `reserva: B com falhas simuladas de hardware e software → fellBackToX264, ${B?.videoCodec}, aviso ${JSON.stringify(B?.warnings)} (${fb ?? B?.error})`,
    failures
  )
  console.log(`reserva: A ${A?.ms} ms; B ${B?.ms} ms (áudio ${B?.audioMs} ms; quadros pelo pipe ${B?.reserveFps} fps a 1920×1080); etapas B ${JSON.stringify(B?.stages)}`)
  check(!!B?.stages?.includes('render+reserva') && !!B.percentMonotonic && B.lastPercent === 100, `reserva: progresso de B com a etapa "Codificador de reserva" (reserve), crescente até 100 % (${JSON.stringify(B?.stages)}; último ${B?.lastPercent})`, failures)
  if (!fa || !fb || !existsSync(fa) || !existsSync(fb)) return
  const ta = await videoTags(fa)
  const tb = await videoTags(fb)
  console.log(`reserva: marcações A ${JSON.stringify(ta)} | B ${JSON.stringify(tb)}`)
  check(
    tb?.codec_name === 'h264' && tb.profile === 'High' && tb.pix_fmt === 'yuv420p' && tb.color_space === 'bt709' && tb.color_primaries === 'bt709' && tb.color_transfer === 'bt709' && tb.color_range === 'tv' && tb.width === 1920 && tb.height === 1080,
    `reserva: B H.264 High yuv420p BT.709 faixa limitada 1920×1080 (${JSON.stringify(tb)})`,
    failures
  )
  check(!!ta && ta.color_space === tb?.color_space && ta.color_primaries === tb?.color_primaries && ta.color_transfer === tb?.color_transfer && ta.color_range === tb?.color_range, `reserva: mesma marcação de cor que A (${ta?.color_space}/${ta?.color_primaries}/${ta?.color_transfer}/${ta?.color_range})`, failures)
  const na = await countFrames(fa)
  const nb = await countFrames(fb)
  check(nb === X264_FRAMES && na === nb, `reserva: quadros de B = frameCount(I–O, 30 fps) = ${X264_FRAMES} = A (B ${nb}, A ${na})`, failures)
  const da = Number(ta?.duration)
  const db = Number(tb?.duration)
  check(Math.abs(da - db) <= 1 / 30 + 1e-6, `reserva: duração do vídeo B = A ± 1 quadro (${db} × ${da} s)`, failures)
  const aa = await probeAudio(fb)
  check(aa?.codec_name === 'aac' && aa.sample_rate === '48000' && aa.channels === 2, `reserva: áudio de B AAC 48 kHz estéreo (${JSON.stringify(aa)})`, failures)
  check(isFastStart(fb), 'reserva: B com faststart (moov antes do mdat)', failures)

  // ---- pixels A × B ----
  const parity: string[] = []
  let worstPsnr = Infinity
  let worstMean = 0
  for (const n of X264_SAMPLES) {
    const t = (n + 0.5) / 30
    const ia = await frameRgb(fa, t, join(dir, `reserva-a-${n}.rgb`))
    const ib = await frameRgb(fb, t, join(dir, `reserva-b-${n}.rgb`))
    const p = psnr(ia, ib)
    const mean = [0, 0, 0]
    for (let i = 0; i < ia.length; i++) mean[i % 3] += Math.abs(ia[i] - ib[i])
    const m = mean.map((v) => v / (ia.length / 3))
    worstPsnr = Math.min(worstPsnr, p)
    worstMean = Math.max(worstMean, ...m)
    parity.push(`q${n}: ${p.toFixed(1)} dB, |dif.| ${m.map((v) => v.toFixed(2)).join('/')}`)
  }
  check(worstPsnr >= X264_PSNR_MIN && worstMean <= X264_MEAN_DIFF_MAX, `reserva: pixels A × B em ${X264_SAMPLES.length} instantes — PSNR ≥ ${X264_PSNR_MIN} dB e média |dif.| ≤ ${X264_MEAN_DIFF_MAX} por canal (${parity.join('; ')})`, failures)
  // sem deslocamento de quadro: o 1º quadro com o buraco do invertido nítido (energia > metade da máxima) é o 60 nos dois
  const hole = pxRegion(FX_BLUR, 1920, 1080, 64)
  const firstSharp = async (f: string, tag: string): Promise<{ first: number; e: string }> => {
    const frames = await framesRgb(f, 54, 65, hole, join(dir, `reserva-buraco-${tag}.rgb`))
    const e = frames.map((d) => detailEnergy(d, hole.w, hole.h))
    const max = Math.max(...e)
    return { first: e.length === 12 ? 54 + e.findIndex((v) => v > max / 2) : -1, e: e.map((v) => v.toFixed(0)).join(' ') }
  }
  const sa = await firstSharp(fa, 'a')
  const sb = await firstSharp(fb, 'b')
  check(sa.first === 60 && sb.first === 60, `reserva: sem deslocamento de quadro — 1º quadro do buraco nítido A ${sa.first} / B ${sb.first} (= 60; energia 54–65: A ${sa.e} | B ${sb.e})`, failures)

  // ---- privacidade em B ----
  const fx: EffectsOut | undefined = r.x264Effects ? { ...r.x264Effects, export: { path: fb } } : undefined
  await checkEffects('reserva B', 'codificador de reserva 1080p / 12 Mbps', fx, { w: 1920, h: 1080, codec: 'h264' }, dir, failures)
  const grid = tarjaGrid(1920, 1080)
  const blurIn = pxRegion(FX_BLUR, 1920, 1080, 64)
  const outside = pxRegion(FX_OUTSIDE, 1920, 1080, 0)
  const priv: string[] = []
  let privOk = true
  for (const n of X264_SAMPLES) {
    const img = await frameRgb(fb, (n + 0.5) / 30, join(dir, `reserva-b-${n}.rgb`))
    const tj = tarjaWorst(img, 1920, 0, 0, grid)
    const eIn = detailEnergy(crop(img, 1920, blurIn), blurIn.w, blurIn.h)
    const eOut = detailEnergy(crop(img, 1920, outside), outside.w, outside.h)
    // blur (< 60): a região borrada ≪ o ruído de fora; invertido (≥ 60): o de fora borrado ≪ o buraco nítido
    const hidden = n < 60 ? eIn < 0.1 * eOut : eOut < 0.1 * eIn
    const pix = pixelateCheck(img, 1920, 1080, 0, 0, 1920, 1080, FX_PIXEL, FX_PIXEL_STRENGTH, PIXEL_GUARD_CODEC)
    const pixOk = n >= 60 || (pix.blocks >= PIXEL_MIN_BLOCKS && pix.worstVar <= PIXEL_VAR_MAX_CODEC && pix.step >= PIXEL_STEP_MIN)
    const ok = tj.inner <= 3 && tj.ring <= 3 && tj.n > 100 && hidden && pixOk
    privOk &&= ok
    priv.push(`q${n}: tarja ${tj.inner}/${tj.ring} (${tj.n} blocos), ${n < 60 ? 'blur' : 'invertido'} região ${eIn.toFixed(1)} × fora ${eOut.toFixed(1)}${n < 60 ? `, pixelização ${pix.worstVar.toFixed(2)}/${pix.step.toFixed(1)} (${pix.blocks} blocos)` : ''}${ok ? '' : ' FALHA'}`)
  }
  check(privOk, `reserva: privacidade em B em cada instante — tarja ±3 em todo macrobloco (miolo/anel), blur/invertido escondendo (energia < 10 %) e pixelização uniforme por bloco onde ativa (< 60; variância ≤ ${PIXEL_VAR_MAX_CODEC}, degrau ≥ ${PIXEL_STEP_MIN}): ${priv.join('; ')}`, failures)
  const tc: Region = { x: grid.bx0 * FX_BLOCK, y: grid.by0 * FX_BLOCK, w: (grid.bx1 - grid.bx0 + 1) * FX_BLOCK, h: (grid.by1 - grid.by0 + 1) * FX_BLOCK }
  const dense = await framesRgb(fb, DENSE_FROM, DENSE_TO, tc, join(dir, 'reserva-tarja-densa.rgb'))
  let dWorst = 0
  let dAt = -1
  for (let k = 0; k < dense.length; k++) {
    const w = tarjaWorst(dense[k], tc.w, tc.x, tc.y, grid)
    const d = Math.max(w.inner, w.ring)
    if (d > dWorst || dAt < 0) {
      dWorst = Math.max(dWorst, d)
      dAt = DENSE_FROM + k
    }
  }
  check(dense.length === DENSE_TO - DENSE_FROM + 1 && dWorst <= 3, `reserva: tarja ±3 em todo macrobloco de TODO quadro de 1–3 s de B (${dense.length} quadros; pior desvio ${dWorst} no quadro ${dAt})`, failures)
  // pixelização em TODO quadro de B em que ela está ativa (timeline 1–3 s = quadros 0–59): recorte da caixa da região
  const pc = pxRegion(FX_PIXEL, 1920, 1080, 0)
  const pFrames = await framesRgb(fb, 0, PIXEL_LAST_FRAME, pc, join(dir, 'reserva-pixelizacao-densa.rgb'))
  const pDense = pFrames.map((f) => pixelateCheck(f, pc.w, pc.h, pc.x, pc.y, 1920, 1080, FX_PIXEL, FX_PIXEL_STRENGTH, PIXEL_GUARD_CODEC))
  const pdw = pDense.length ? pDense.reduce((a, b) => (b.worstVar > a.worstVar ? b : a)) : null
  const pdMinStep = Math.min(...pDense.map((p) => p.step))
  const pdMinBlocks = Math.min(...pDense.map((p) => p.blocks))
  check(pDense.length === PIXEL_LAST_FRAME + 1 && !!pdw && pdMinBlocks >= PIXEL_MIN_BLOCKS && pdw.worstVar <= PIXEL_VAR_MAX_CODEC && pdMinStep >= PIXEL_STEP_MIN, `reserva: pixelização uniforme por bloco em TODO quadro de B em que ela está ativa (0–${PIXEL_LAST_FRAME}: ${pDense.length} quadros; pior no quadro ${pdw ? pDense.indexOf(pdw) : -1}: ${pdw ? pixelateText(pdw) : '—'}; mín. ${pdMinBlocks} blocos, degrau mín. ${pdMinStep.toFixed(1)}; variância ≤ ${PIXEL_VAR_MAX_CODEC})`, failures)

  // ---- áudio A × B ----
  const la = { t1: await rmsDb(fa, ...TONE1), t2: await rmsDb(fa, ...TONE2) }
  const lb = { t1: await rmsDb(fb, ...TONE1), t2: await rmsDb(fb, ...TONE2) }
  const d1 = Math.abs(la.t1 - lb.t1)
  const d2 = Math.abs(la.t2 - lb.t2)
  check(d1 <= 0.5 && d2 <= 0.5, `reserva: RMS dos tons B × A (440 Hz ${lb.t1} × ${la.t1} dB; 660 Hz ${lb.t2} × ${la.t2} dB; dif. ${d1.toFixed(2)} / ${d2.toFixed(2)} ≤ 0,5)`, failures)
  const lag = crossCorrelationLag(await pcmOf(fa, join(dir, 'reserva-a.f32')), await pcmOf(fb, join(dir, 'reserva-b.f32')), 96, 1)
  check(Math.abs(lag) <= 48, `reserva: áudio de B alinhado com A — atraso ${lag} amostras (${((lag / 48000) * 1000).toFixed(2)} ms; 0 ± 1 ms)`, failures)

  // ---- cancelamento e nova exportação ----
  const c = r.x264Cancel
  const after = r.x264AfterCancel
  const left = existsSync(x264CancelDir) ? readdirSync(x264CancelDir) : []
  check(!!c?.cancelled && !!c.at, `reserva: B cancelado no meio dos quadros (${JSON.stringify(c?.at)}) ${c?.error ?? ''}`, failures)
  check(!!after?.path && after.fellBackToX264 === true && left.length === 1 && left[0] === 'depois.mp4', `reserva: sem .mp4, .part nem áudio temporário do cancelado; a exportação seguinte pela reserva terminou (${left.join(', ') || 'pasta vazia'}; ${after?.path ?? after?.error})`, failures)
  if (after?.path && existsSync(after.path)) {
    const st = await streamInfo(after.path)
    check(st?.codec_name === 'h264' && st.width === 640 && st.height === 360, `reserva: depois.mp4 válido — h264 640×360 (${JSON.stringify(st)})`, failures)
  }

  // ---- tamanho alvo pela reserva ----
  const tg = r.x264Target
  const target = Math.round(X264_TARGET_MB * 1024 * 1024)
  check(!!tg?.path && existsSync(tg.path) && tg.fellBackToX264 === true && tg.passes === 2 && (tg.size ?? Infinity) <= target, `reserva: tamanho alvo ${X264_TARGET_MB} MB em ${(r.x264TargetDurUs ?? 0) / 1e6} s — ${tg?.size} bytes ≤ ${target} em ${tg?.passes} passadas (${tg?.path ?? tg?.error})`, failures)
  if (tg?.path && existsSync(tg.path)) {
    const st = await streamInfo(tg.path)
    check(st?.codec_name === 'h264' && st.width === 1280 && st.height === 720 && (await countFrames(tg.path)) === 600, `reserva: alvo.mp4 válido — h264 1280×720, 600 quadros (${JSON.stringify(st)})`, failures)
  }
  const files = readdirSync(x264Dir)
  check(files.every((f) => !f.endsWith('.part')), `reserva: nenhum .part/temporário na pasta (${files.join(', ')})`, failures)
}
