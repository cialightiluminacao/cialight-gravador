import { app, BrowserWindow, ipcMain } from 'electron'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Asset, EffectItem, MediaItem, Project, Track } from '@shared/editor/project'
import type { ExportOptions } from '@shared/types'
import { createEffectItem, createEmptyProject, createMediaItem } from '@shared/editor/factory'
import { addAsset, addMediaFromAsset, deleteRange, setSpeed, updateItem } from '@shared/editor/ops'
import { dominantHz, toneAmplitude } from '@shared/audio/pcmAnalysis'
import { AUDIO_MIX_DEFAULTS } from '@shared/editor/audioPlan'
import { speechFromFile, type SpeechInterval } from '@shared/editor/speech'
import { clampPip, pipPixelRect, pipRectAt } from '@shared/compositor/pipMath'
import { untaggedFamily } from '@shared/editor/sourceColor'
import type { ProjectStore } from './project/projectStore'
import type { SessionStore } from './session/sessionStore'
import { probeFile, probeKeyframes, runFfmpeg } from './export/ffmpegRunner'
import { ffprobePath } from './export/ffmpegPath'
import { startExportJob } from './export/exportJob'
import { cachedEncoderProbe } from './export/encoderProbe'
import { probe } from './media/probe'
import { assetFromInfo } from './media/ingest'
import { processAudioFile } from './media/audioProcess'
import { buildSpeech } from './media/analysis'
import { processedAudioRel, sourceFingerprint } from '@shared/editor/audioProcess'
import { rnnoiseDir } from './export/ffmpegPath'
import { crossCorrelationLag, isFastStart, makeSyntheticSession, makeVoiceFixture } from './testFixtures'
import { loadPage, preloadPath } from './windows/recorderWindow'

// Teste de integração da exportação do editor (CIALIGHT_TEST=editor-export, `npm run test:editor-export`).
// Cenário: testsrc2 1280×720@30 10 s + senoide, trecho [2 s, 5 s) apagado com deleteRange, imagem sobreposta
// por 2 s, fade-in de áudio de 1 s → exporta 1280×720@30 pelo render worker e valida com ffprobe/ffmpeg
// (faixas, duração, quadros, níveis de áudio, PSNR do quadro após o corte, faststart). Também: fallback do
// encoder (falha simulada do hardware), nome sem sobrescrever, cancelamento sem parcial e paridade com a v1
// (sessão sintética com webcam circular: editor × composição v1 + job ffmpeg, PSNR no centro da PiP).
// Não grava settings.json (o app instalado divide a pasta userData): o teste confere o hash.

const PROJECT_ID = 'p-editor-export-test'
const SESSION_ID = 'test-editor-export-session'
const W = 1280
const H = 720
const FPS = 30
const FRAME_MS = 1000 / FPS
// fonte marcada como BT.709 (como as gravações do app): sem a marcação, o Chromium e o ffmpeg convertem o
// YUV para RGB com matrizes diferentes e a comparação de pixels mediria a matriz, não a exportação
const BT709 = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']
// como as gravações de tela da v1 (WebCodecs): BT.601 marcado
const BT601 = ['-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m', '-color_range', 'tv']
const COLOR_601 = 'p-editor-export-cor-601'
const COLOR_UNTAGGED = 'p-editor-export-cor-sem-marcacao'
const COLOR_UNTAGGED_SD = 'p-editor-export-cor-sem-marcacao-sd'
// efeitos (F2): projeto 1920×1080 (ruído + blur + tarja) exportado em 1280×720
const EFFECTS_ID = 'p-editor-export-efeitos'
const FX_BLOCK = 16
const FX_T_US = 1_000_000
const FX_TARJA = [0x12, 0x34, 0x56]
const FX_SOLID = { x: 0.72, y: 0.5, w: 0.3, h: 0.4 }
const FX_BLUR = { x: 0.3, y: 0.5, w: 0.3, h: 0.4 }
// trecho só de ruído, longe do blur e da tarja (energia de detalhe de referência)
const FX_OUTSIDE = { x: 0.065, y: 0.5, w: 0.11, h: 0.8 }
// velocidade (F3): testsrc2 + voz sintética de 6 s a 2× com tom preservado
const SPEED_ID = 'p-editor-export-velocidade'
const VOICE_HZ = 220
// reverso (F3): testsrc2 [2 s, 5 s) de trás para frente × ffmpeg -vf reverse
const REVERSE_ID = 'p-editor-export-reverso'
// redução de ruído (F3): voz sintética com pausas + ruído branco −30 dBFS, item com denoise e o processado pronto
const DENOISE_ID = 'p-editor-export-ruido'
// ducking (F3): música = seno de 220 Hz (amplitude 0,25) na faixa Música; voz = bursts de 1 kHz na faixa Voz com a pausa
// [3; 3,52) s (vira um vão de ~0,28 s entre os intervalos de fala com o padding: menor que o hold de 300 ms, não solta)
const DUCKING_ID = 'p-editor-export-ducking'
const DUCK_HZ = 220
const DUCK_WIN = 2400 // 50 ms: 11 ciclos de 220 Hz e 50 de 1 kHz (Goertzel sem vazamento da voz)
const DUCK_HOP = 480 // 10 ms
// tamanho-alvo forçado (o cenário de 7 s a 8 Mbps dá ~7 MB)
const SMALL_TARGET = 2 * 1024 * 1024
// F7: projeto de 20 s (a fonte do cenário duas vezes) exportado com tamanho alvo personalizado de 3 MB, e
// projeto 1080×1080 para o Feed 1:1
const LONG_ID = 'p-editor-export-20s'
const SQUARE_ID = 'p-editor-export-quadrado'
const F7_TARGET_MB = 3

interface ExportOut { path?: string; size?: number; passes?: number; warnings?: string[]; error?: string; fellBackToSoftware?: boolean; fellBackFromHevc?: boolean; codec?: string; hardware?: string; audioCodec?: string | null; videoCodec?: string; ms?: number; speed?: number | null; progressEvents?: number }
type Region = { x: number; y: number; w: number; h: number }
interface HarnessReport {
  errors: string[]
  scenario?: ExportOut
  fallback?: ExportOut
  cancel?: { error?: string; cancelled: boolean; afterFrames: number }
  parity?: ExportOut
  sized?: ExportOut
  nonEncoder?: ExportOut
  missingMedia?: { preflight: { assetId: string; status: string }[]; export: ExportOut }
  color?: Record<string, { export: ExportOut; frame: unknown }>
  v1Composed?: { path?: string; error?: string }
  effects?: EffectsOut
  f7Target?: ExportOut & { requestTargetBytes?: number | null; requestVideoBitrate?: number; durationUs?: number }
  f7Fps60?: ExportOut & { expectedFrames?: number }
  f7Intermediate?: ExportOut
  f7Feed11?: ExportOut & { availability?: { ok: boolean; reason?: string }; unavailableOn169?: { ok: boolean; reason?: string } }
  f7Hevc?: { supported: true; effects?: EffectsOut } | { supported: false; dialogBlocker?: string | null }
  f7HevcFallback?: ExportOut
  f7Whatsapp?: EffectsOut
  speed?: ExportOut
  speedAgain?: ExportOut
  reverse?: ExportOut
  denoise?: ExportOut
  denoiseOff?: ExportOut
  ducking?: ExportOut
  duckingPreview?: { levelsDb?: number[]; error?: string }
  previewUntouched?: { before: number[]; after: number[] } | { error: string }
}

interface LevelSpan { n: number; min: number; max: number }
interface DuckingResult { speech: LevelSpan; hold: LevelSpan; outside: LevelSpan; holdGapMs: number; ramps: { kind: 'ataque' | 'soltura'; atS: number; windows: number; backstep: number; span: number }[] }

/**
 * Classifica as janelas de nível da música (dB relativo à fonte; janela DUCK_WIN, passo DUCK_HOP) pelos intervalos de
 * fala (timeline = fonte: item em 0 a 1×), com os tempos padrão do ducking: dentro da fala, dentro de uma pausa menor
 * que o hold, fora (a mais de ataque/hold + soltura + 50 ms de qualquer fala) e as rampas (janelas inteiras dentro do
 * ataque [início − ataque, início] e da soltura [fim + hold, fim + hold + soltura] de cada região): recuo = maior passo
 * no sentido errado, variação = nível do 1º − último (ataque) ou último − 1º (soltura).
 */
function duckingCheck(levels: number[], speech: SpeechInterval[]): DuckingResult {
  const A = AUDIO_MIX_DEFAULTS.attackMs / 1000
  const R = AUDIO_MIX_DEFAULTS.releaseMs / 1000
  const H = AUDIO_MIX_DEFAULTS.holdMs / 1000
  const M = 0.05
  const iv = speech.map((s) => ({ a: s.fromUs / 1e6, b: s.toUs / 1e6 }))
  const regions: { a: number; e: number }[] = []
  const held: { a: number; b: number }[] = []
  iv.forEach((x, k) => {
    const last = regions[regions.length - 1]
    if (last && x.a <= last.e) {
      held.push({ a: iv[k - 1].b, b: x.a })
      last.e = Math.max(last.e, x.b + H)
    } else regions.push({ a: x.a, e: x.b + H })
  })
  const span = (): LevelSpan => ({ n: 0, min: Infinity, max: -Infinity })
  const add = (s: LevelSpan, v: number): void => {
    s.n++
    s.min = Math.min(s.min, v)
    s.max = Math.max(s.max, v)
  }
  const out: DuckingResult = { speech: span(), hold: span(), outside: span(), holdGapMs: held.length ? Math.round((held[0].b - held[0].a) * 1000) : 0, ramps: [] }
  const t0 = (i: number): number => (i * DUCK_HOP) / 48000
  const t1 = (i: number): number => (i * DUCK_HOP + DUCK_WIN) / 48000
  const inside = (i: number, a: number, b: number): boolean => t0(i) >= a && t1(i) <= b
  // as pontas do arquivo ficam de fora: o AAC da exportação atenua os primeiros milissegundos (priming do encoder)
  const edge = 0.05
  const endS = t1(levels.length - 1)
  levels.forEach((v, i) => {
    if (t0(i) < edge || t1(i) > endS - edge) return
    if (iv.some((x) => inside(i, x.a, x.b))) add(out.speech, v)
    else if (held.some((x) => inside(i, x.a, x.b))) add(out.hold, v)
    else if (regions.every((g) => t1(i) <= g.a - A - M || t0(i) >= g.e + R + M)) add(out.outside, v)
  })
  const ramp = (kind: 'ataque' | 'soltura', a: number, b: number): void => {
    const seq = levels.filter((_, i) => inside(i, a, b))
    const dir = kind === 'ataque' ? -1 : 1
    let backstep = 0
    for (let i = 1; i < seq.length; i++) backstep = Math.max(backstep, -dir * (seq[i] - seq[i - 1]))
    out.ramps.push({ kind, atS: +a.toFixed(3), windows: seq.length, backstep: +backstep.toFixed(4), span: seq.length ? +(dir * (seq[seq.length - 1] - seq[0])).toFixed(2) : 0 })
  }
  for (const g of regions) {
    ramp('ataque', g.a - A, g.a)
    ramp('soltura', g.e, g.e + R)
  }
  return out
}

function check(cond: boolean, msg: string, failures: string[]): void {
  if (!cond) failures.push(msg)
  console.log(`${cond ? 'OK ' : 'FAIL'} ${msg}`)
}

function settingsHash(): string | null {
  const f = join(app.getPath('userData'), 'settings.json')
  return existsSync(f) ? createHash('sha1').update(readFileSync(f)).digest('hex') : null
}

const gen = (args: string[], label: string): Promise<unknown> => runFfmpeg(['-hide_banner', '-nostdin', '-y', ...args, '-progress', 'pipe:1', '-nostats'], { label })

/** Quadro em tSec (decodificação exata a partir do keyframe anterior), recortado, como RGB24. */
async function frameRgb(file: string, tSec: number, out: string, crop?: { x: number; y: number; w: number; h: number }): Promise<Uint8Array> {
  const vf = crop ? ['-vf', `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`] : []
  await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-ss', tSec.toFixed(3), '-i', file, '-frames:v', '1', ...vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', out], { label: 'teste: quadro' })
  return new Uint8Array(readFileSync(out))
}

/** Quadro como RGB24 interpretando o YUV com a matriz/faixa dadas (ignora a marcação do arquivo). */
async function frameRgbAs(file: string, tSec: number, out: string, matrix: 'bt601' | 'bt709', range: 'tv' | 'pc'): Promise<Uint8Array> {
  await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-ss', tSec.toFixed(3), '-i', file, '-frames:v', '1', '-vf', `scale=in_color_matrix=${matrix}:in_range=${range}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', out], { label: 'teste: quadro' })
  return new Uint8Array(readFileSync(out))
}

/** Variância de luma por bloco b×b (blocos inteiros, linha a linha) de uma imagem RGB24. */
function blockVar(d: Uint8Array, w: number, h: number, b: number): number[] {
  const out: number[] = []
  for (let by = 0; by + b <= h; by += b) {
    for (let bx = 0; bx + b <= w; bx += b) {
      let s = 0
      let s2 = 0
      for (let y = by; y < by + b; y++) {
        for (let x = bx; x < bx + b; x++) {
          const i = (y * w + x) * 3
          const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
          s += l
          s2 += l * l
        }
      }
      const n = b * b
      out.push(s2 / n - (s / n) ** 2)
    }
  }
  return out
}

/** PSNR (dB) entre duas imagens RGB24 do mesmo tamanho. */
function psnr(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return -1
  let se = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    se += d * d
  }
  const mse = se / a.length
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse)
}

/** RMS geral (dB) do áudio em [from, to) s pelo astats. */
async function rmsDb(file: string, from: number, to: number): Promise<number> {
  const r = await runFfmpeg(['-hide_banner', '-nostdin', '-i', file, '-vn', '-af', `atrim=start=${from}:end=${to},astats=measure_perchannel=none`, '-f', 'null', '-'], { label: 'teste: astats' })
  const m = /RMS level dB:\s*(-?[\d.]+|-inf)/.exec(r.stderrTail.split('Overall').pop() ?? '')
  return m ? (m[1] === '-inf' ? -Infinity : Number(m[1])) : NaN
}

/** Áudio do arquivo como PCM float 48 kHz intercalado (ffmpeg → f32le); mono por padrão. */
async function pcmOf(file: string, out: string, channels = 1): Promise<Float32Array> {
  await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', file, '-vn', '-ac', String(channels), '-ar', '48000', '-f', 'f32le', out], { label: 'teste: pcm' })
  const b = readFileSync(out)
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}

/** Quadros decodificados da faixa de vídeo (ffprobe -count_frames). */
function countFrames(file: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(ffprobePath(), ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], { windowsHide: true }, (err, stdout) => {
      resolve(err ? -1 : Number(String(stdout).trim().replace(/,$/, '')))
    })
  })
}

interface EffectsOut { export?: ExportOut; width?: number; height?: number; blurCrop?: Region; outsideCrop?: Region; previewBlockVar?: number[]; previewBlurRgb?: number[]; previewEnergy?: { blur: number; outside: number }; error?: string }

/** Energia de detalhe: média de (ΔL)² entre vizinhos (horizontal + vertical) de uma imagem RGB24 w×h. */
function detailEnergy(d: Uint8Array, w: number, h: number): number {
  const L = (x: number, y: number): number => {
    const i = (y * w + x) * 3
    return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
  }
  let s = 0
  let n = 0
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const l = L(x, y)
      s += (L(x + 1, y) - l) ** 2 + (L(x, y + 1) - l) ** 2
      n++
    }
  }
  return n ? s / n : 0
}

/** Faixa de vídeo pelo ffprobe (codec, tag, taxa de quadros, resolução). */
function streamInfo(file: string): Promise<{ codec_name?: string; codec_tag_string?: string; r_frame_rate?: string; avg_frame_rate?: string; width?: number; height?: number } | null> {
  return new Promise((resolve) => {
    execFile(ffprobePath(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,codec_tag_string,r_frame_rate,avg_frame_rate,width,height', '-of', 'json', file], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      try {
        resolve((JSON.parse(String(stdout)) as { streams?: Record<string, never>[] }).streams?.[0] ?? null)
      } catch {
        resolve(null)
      }
    })
  })
}

/**
 * Oráculos de privacidade numa exportação do projeto de efeitos (ruído 1920×1080 + blur + tarja #123456) em
 * w×h: tarja com a cor exata (±3, centro de cada macrobloco inteiro na região), área borrada/tarjada no mesmo
 * lugar do preview reduzido (IoU dos blocos de baixa variância ≥ 0,9), miolo borrado ≈ preview reduzido (PSNR >
 * 30; raio ∝ altura), energia de detalhe do miolo borrado < 10 % da do ruído de fora, e o ruído de fora intacto
 * (energia ≥ 50 % da do preview reduzido: nada borrado fora da região).
 */
async function checkEffects(label: string, what: string, fx: EffectsOut | undefined, expect: { w: number; h: number; codec: 'h264' | 'hevc' }, dir: string, failures: string[]): Promise<void> {
  const out = fx?.export?.path
  const tag = label.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  check(!!out && existsSync(out) && !!fx?.previewBlockVar, `${label}: projeto 1920×1080 exportado (${what}) (${out ?? fx?.export?.error ?? fx?.error})`, failures)
  if (!out || !existsSync(out) || !fx?.previewBlockVar || !fx.blurCrop || !fx.outsideCrop) return
  const { w: OW, h: OH } = expect
  const st = await streamInfo(out)
  check(st?.width === OW && st?.height === OH, `${label}: saída ${OW}×${OH} (${st?.width}×${st?.height})`, failures)
  if (expect.codec === 'hevc') check(st?.codec_name === 'hevc' && st?.codec_tag_string === 'hvc1' && fx.export?.codec === 'hevc', `${label}: codec HEVC com a tag hvc1 (${st?.codec_name}/${st?.codec_tag_string}; ${fx.export?.videoCodec})`, failures)
  else check(st?.codec_name === 'h264', `${label}: codec H.264 (${st?.codec_name})`, failures)
  const img = await frameRgb(out, FX_T_US / 1e6, join(dir, `${tag}-saida.rgb`))
  // tarja: centro de cada bloco 16×16 (macrobloco) inteiro dentro da região. Miolo: ±3 por canal após o encoder.
  // Anel (macroblocos na borda da região, vizinhos do ruído): o deblocking/croma 4:2:0 do encoder puxa até 4 níveis
  // a 8 Mbps (medido no WhatsApp 720p) — continua opaco e sem detalhe (ver a máscara de baixa variância), ±6.
  const by0 = Math.ceil(((FX_SOLID.y - FX_SOLID.h / 2) * OH) / FX_BLOCK)
  const bx0 = Math.ceil(((FX_SOLID.x - FX_SOLID.w / 2) * OW) / FX_BLOCK)
  const by1 = Math.floor(((FX_SOLID.y + FX_SOLID.h / 2) * OH) / FX_BLOCK) - 1
  const bx1 = Math.floor(((FX_SOLID.x + FX_SOLID.w / 2) * OW) / FX_BLOCK) - 1
  const worst = { inner: { d: 0, px: [] as number[], n: 0 }, ring: { d: 0, px: [] as number[], n: 0 } }
  for (let by = by0; by <= by1; by++) {
    for (let bx = bx0; bx <= bx1; bx++) {
      const i = ((by * FX_BLOCK + FX_BLOCK / 2) * OW + bx * FX_BLOCK + FX_BLOCK / 2) * 3
      const px = [img[i], img[i + 1], img[i + 2]]
      const d = Math.max(...px.map((v, c) => Math.abs(v - FX_TARJA[c])))
      const w = by === by0 || by === by1 || bx === bx0 || bx === bx1 ? worst.ring : worst.inner
      w.n++
      if (d >= w.d) {
        w.d = d
        w.px = px
      }
    }
  }
  check(worst.inner.n > 100 && worst.inner.d <= 3, `${label}: tarja com a cor exata na exportação — miolo (${worst.inner.n} blocos, pior desvio ${worst.inner.d} em ${worst.inner.px}; esperado 18,52,86 ± 3)`, failures)
  check(worst.ring.n > 20 && worst.ring.d <= 6, `${label}: tarja — anel da borda (${worst.ring.n} blocos, pior desvio ${worst.ring.d} em ${worst.ring.px}; ± 6)`, failures)
  // região borrada no mesmo lugar: blocos de baixa variância (ruído: milhares; borrado/tarja: ~0), exportação × preview
  const exportVar = blockVar(img, OW, OH, FX_BLOCK)
  const pv = fx.previewBlockVar
  const LOW = 300
  let inter = 0
  let union = 0
  for (let k = 0; k < Math.min(pv.length, exportVar.length); k++) {
    const a = pv[k] < LOW
    const b = exportVar[k] < LOW
    if (a && b) inter++
    if (a || b) union++
  }
  const iou = union ? inter / union : 0
  check(pv.length === exportVar.length && union > 100 && iou >= 0.9, `${label}: área borrada/tarjada no mesmo lugar (IoU ${iou.toFixed(3)} ≥ 0,9; ${inter}/${union} blocos de ${FX_BLOCK}×${FX_BLOCK})`, failures)
  // mesmo raio relativo à altura: o miolo borrado da exportação ≈ preview 1080p reduzido
  const bc = fx.blurCrop
  const ex = await frameRgb(out, FX_T_US / 1e6, join(dir, `${tag}-blur.rgb`), bc)
  const pBlur = psnr(ex, Uint8Array.from(fx.previewBlurRgb ?? []))
  check(pBlur > 30, `${label}: região borrada exportação ${OW}×${OH} × preview 1080p reduzido (raio ∝ altura): PSNR ${pBlur.toFixed(1)} dB > 30 (miolo ${bc.w}×${bc.h})`, failures)
  // energia de detalhe: borrado ≪ ruído de fora; ruído de fora preservado (comparado ao preview reduzido)
  const oc = fx.outsideCrop
  const eBlur = detailEnergy(ex, bc.w, bc.h)
  const outside = await frameRgb(out, FX_T_US / 1e6, join(dir, `${tag}-fora.rgb`), oc)
  check(ex.length === bc.w * bc.h * 3 && outside.length === oc.w * oc.h * 3, `${label}: recortes do miolo (${bc.w}×${bc.h}) e de fora (${oc.w}×${oc.h}) com o tamanho pedido`, failures)
  const eOut = detailEnergy(outside, oc.w, oc.h)
  const pe = fx.previewEnergy
  check(eBlur < 0.1 * eOut, `${label}: energia de detalhe do miolo borrado ${eBlur.toFixed(1)} < 10 % da do ruído de fora ${eOut.toFixed(1)} (preview: ${pe?.blur} / ${pe?.outside})`, failures)
  check(!!pe && eOut >= 0.5 * pe.outside, `${label}: fora da região o ruído continua (energia ${eOut.toFixed(1)} ≥ 50 % da do preview reduzido ${pe?.outside})`, failures)
}

function scenarioProject(video: Asset, red: Asset): Project {
  let p: Project = { ...createEmptyProject('Exportação de teste', { width: W, height: H, fps: FPS, background: '#000000' }), id: PROJECT_ID }
  p = addAsset(addAsset(p, video), red)
  const added = addMediaFromAsset(p, video.id, 0)
  p = added.project
  // apaga [2 s, 5 s) em todas as faixas: o quadro em 2,0 s da saída é o 5,0 s da fonte
  p = deleteRange(p, 2_000_000, 5_000_000)
  // fade-in de áudio de 1 s no item de áudio do início
  const audioTrack = p.tracks.find((t) => t.kind === 'audio')!
  const first = audioTrack.items.find((i) => i.startUs === 0)!
  p = updateItem(p, first.id, (d) => {
    if (d.type === 'media') d.audio.fadeInUs = 1_000_000
  })
  // imagem sobreposta de 4 s a 6 s (canto superior direito, ¼ da largura), numa faixa acima do vídeo
  const img: MediaItem = { ...createMediaItem(red, 4_000_000, 'video'), durationUs: 2_000_000 }
  const v = img.visual!
  const overlay: MediaItem = { ...img, visual: { ...v, transform: { ...v.transform, x: { value: 0.85 }, y: { value: 0.2 }, scale: { value: 0.25 } } } }
  const track: Track = { id: 't_overlay', kind: 'video', name: 'Imagem', muted: false, hidden: false, locked: false, volume: 1, items: [overlay] }
  const firstAudio = p.tracks.findIndex((t) => t.kind === 'audio')
  return { ...p, tracks: [...p.tracks.slice(0, firstAudio), track, ...p.tracks.slice(firstAudio)] }
}

export async function testEditorExport(projects: ProjectStore, sessions: SessionStore, outDir: string): Promise<number> {
  const failures: string[] = []
  const hashBefore = settingsHash()
  const dir = join(outDir, 'editor-export')
  const exportsDir = join(dir, 'saidas')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(exportsDir, { recursive: true })

  const src = join(dir, 'testsrc2-seno.mp4')
  const red = join(dir, 'vermelho.png')
  await gen(['-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=${FPS}`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000,volume=4', '-t', '10', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30', '-pix_fmt', 'yuv420p', ...BT709, '-c:a', 'aac', '-b:a', '160k', '-ac', '2', src], 'editor-export: fonte')
  await gen(['-f', 'lavfi', '-i', 'color=c=red:s=320x180', '-frames:v', '1', '-update', '1', red], 'editor-export: imagem')
  const aVideo: Asset = { ...assetFromInfo('a_src', src, statSync(src), await probe(src)), status: 'ready' }
  const aRed: Asset = { ...assetFromInfo('a_red', red, statSync(red), await probe(red)), status: 'ready' }
  const project = scenarioProject(aVideo, aRed)
  rmSync(projects.dirOf(PROJECT_ID), { recursive: true, force: true })
  projects.create(project)

  // fontes de cor: BT.601 marcada (como a gravação de tela da v1) e sem marcação nenhuma
  // (+ uma SD 640×480 sem marcação: o Chromium escolhe a matriz pela resolução)
  const colorSrc: Record<string, string> = { [COLOR_601]: join(dir, 'cor-601.mp4'), [COLOR_UNTAGGED]: join(dir, 'cor-sem-marcacao.mp4'), [COLOR_UNTAGGED_SD]: join(dir, 'cor-sem-marcacao-sd.mp4') }
  for (const [id, file] of Object.entries(colorSrc)) {
    const [cw, ch] = id === COLOR_UNTAGGED_SD ? [640, 480] : [W, H]
    await gen(['-f', 'lavfi', '-i', `testsrc2=size=${cw}x${ch}:rate=${FPS}`, '-t', '3', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30', '-pix_fmt', 'yuv420p', ...(id === COLOR_601 ? BT601 : []), file], `editor-export: ${id}`)
    const a: Asset = { ...assetFromInfo(`a_${id}`, file, statSync(file), await probe(file)), status: 'ready' }
    let cp: Project = { ...createEmptyProject(id, { width: cw, height: ch, fps: FPS, background: '#000000' }), id }
    cp = addMediaFromAsset(addAsset(cp, a), a.id, 0).project
    rmSync(projects.dirOf(id), { recursive: true, force: true })
    projects.create(cp)
  }

  // efeitos: ruído 1920×1080 em células de 4 px (detalhe em todo bloco: a máscara de baixa variância é exatamente
  // a área borrada/tarjada; ruído por pixel esgota os bits do H.264 a 8 Mbps e suja a tarja) + blur (preset
  // padrão) + tarja #123456 sem feather
  const noise = join(dir, 'ruido.png')
  await gen(['-f', 'lavfi', '-i', 'nullsrc=s=480x270,format=gray,geq=lum=random(1)*255,scale=1920:1080:flags=neighbor', '-frames:v', '1', '-update', '1', noise], 'editor-export: ruído')
  const aNoise = assetFromInfo('a_noise', noise, statSync(noise), await probe(noise))
  const noiseItem: MediaItem = { ...createMediaItem(aNoise, 0, 'video'), durationUs: 2_000_000 }
  const blurFx: EffectItem = createEffectItem('blur', 0, 2_000_000, FX_BLUR)
  const solidFx: EffectItem = { ...createEffectItem('solid', 0, 2_000_000, FX_SOLID), color: '#123456', feather: 0 }
  const vt = (id: string, item: MediaItem | EffectItem): Track => ({ id, kind: 'video', name: id, muted: false, hidden: false, locked: false, volume: 1, items: [item] })
  const fxp: Project = {
    ...addAsset({ ...createEmptyProject('Efeitos', { width: 1920, height: 1080, fps: FPS, background: '#000000' }), id: EFFECTS_ID }, aNoise),
    tracks: [vt('t_ruido', noiseItem), vt('t_blur', blurFx), vt('t_tarja', solidFx)]
  }
  rmSync(projects.dirOf(EFFECTS_ID), { recursive: true, force: true })
  projects.create(fxp)

  // F7: projeto de 20 s (a fonte do cenário duas vezes) e projeto 1080×1080 (testsrc2 + seno, 3 s)
  const longProject: Project = { ...createEmptyProject('Vinte segundos', { width: W, height: H, fps: FPS, background: '#000000' }), id: LONG_ID }
  rmSync(projects.dirOf(LONG_ID), { recursive: true, force: true })
  projects.create(addMediaFromAsset(addMediaFromAsset(addAsset(longProject, aVideo), aVideo.id, 0).project, aVideo.id, 10_000_000).project)
  const squareSrc = join(dir, 'quadrado.mp4')
  await gen(['-f', 'lavfi', '-i', `testsrc2=size=1080x1080:rate=${FPS}`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30', '-pix_fmt', 'yuv420p', ...BT709, '-c:a', 'aac', '-b:a', '128k', '-ac', '2', squareSrc], 'editor-export: quadrado')
  const aSquare: Asset = { ...assetFromInfo('a_quadrado', squareSrc, statSync(squareSrc), await probe(squareSrc)), status: 'ready' }
  rmSync(projects.dirOf(SQUARE_ID), { recursive: true, force: true })
  projects.create(addMediaFromAsset(addAsset({ ...createEmptyProject('Quadrado', { width: 1080, height: 1080, fps: FPS, background: '#000000' }), id: SQUARE_ID }, aSquare), aSquare.id, 0).project)

  // velocidade: voz sintética (220 Hz + harmônicos ½ e ¼, sílabas a 4 Hz) com vídeo, item inteiro a 2×
  const voice = join(dir, 'voz-sintetica.mp4')
  const voiceExpr = `0.3*(0.6+0.4*sin(2*PI*4*t))*(sin(2*PI*${VOICE_HZ}*t)+0.5*sin(4*PI*${VOICE_HZ}*t)+0.25*sin(6*PI*${VOICE_HZ}*t))`
  await gen(['-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=${FPS}`, '-f', 'lavfi', '-i', `aevalsrc='${voiceExpr}|${voiceExpr}':s=48000`, '-t', '6', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30', '-pix_fmt', 'yuv420p', ...BT709, '-c:a', 'aac', '-b:a', '160k', voice], 'editor-export: voz sintética')
  const aVoice: Asset = { ...assetFromInfo('a_voz', voice, statSync(voice), await probe(voice)), status: 'ready' }
  const speedAdded = addMediaFromAsset(addAsset({ ...createEmptyProject('Velocidade', { width: W, height: H, fps: FPS, background: '#000000' }), id: SPEED_ID }, aVoice), aVoice.id, 0)
  const speedProject = setSpeed(speedAdded.project, speedAdded.itemIds[1], 2) // vinculados: vídeo e áudio a 2×
  rmSync(projects.dirOf(SPEED_ID), { recursive: true, force: true })
  projects.create(speedProject)

  // reverso: a fonte do cenário, trecho [2 s, 5 s) com reverse (só vídeo)
  const revItem: MediaItem = { ...createMediaItem(aVideo, 0, 'video'), inUs: 2_000_000, durationUs: 3_000_000, reverse: true }
  const reverseProject: Project = {
    ...addAsset({ ...createEmptyProject('Reverso', { width: W, height: H, fps: FPS, background: '#000000' }), id: REVERSE_ID }, aVideo),
    tracks: [{ id: 't_rev', kind: 'video', name: 'Vídeo', muted: false, hidden: false, locked: false, volume: 1, items: [revItem] }]
  }
  rmSync(projects.dirOf(REVERSE_ID), { recursive: true, force: true })
  projects.create(reverseProject)

  // redução de ruído: voz sintética (a do Windows, se houver) + ruído branco −30 dBFS em estéreo; o arquivo processado
  // é gerado pelo mesmo caminho do main (media.processAudio) em generated/, com a impressão digital da fonte no nome
  const voiceFx = await makeVoiceFixture(dir, 'voz-ruido-limpa')
  const noisyVoice = join(dir, 'voz-ruido.m4a')
  await gen(['-i', voiceFx.file, '-f', 'lavfi', '-i', `anoisesrc=color=white:r=48000:a=0.05477:d=${voiceFx.durS}:seed=3`, '-filter_complex', '[0][1]amix=inputs=2:normalize=0:duration=first,pan=stereo|c0=c0|c1=c0', '-c:a', 'aac', '-b:a', '192k', noisyVoice], 'editor-export: voz com ruído')
  const nst = statSync(noisyVoice)
  const noisyFp = sourceFingerprint(nst.size, nst.mtimeMs)
  const aNoisy: Asset = { ...assetFromInfo('a_ruido', noisyVoice, nst, await probe(noisyVoice)), status: 'ready', processedAudio: { 'dn-sh': noisyFp } }
  const dnAdded = addMediaFromAsset(addAsset({ ...createEmptyProject('Ruído', { width: W, height: H, fps: FPS, background: '#000000' }), id: DENOISE_ID }, aNoisy), aNoisy.id, 0)
  rmSync(projects.dirOf(DENOISE_ID), { recursive: true, force: true })
  projects.create(updateItem<MediaItem>(dnAdded.project, dnAdded.itemIds[0], (d) => { d.audio.denoise = true }))
  await processAudioFile(noisyVoice, '0:a:0', projects.filePath(DENOISE_ID, processedAudioRel(aNoisy.id, 'dn-sh', noisyFp)), { denoise: true, normalize: false }, { modelDir: rnnoiseDir(), durationUs: Math.round(voiceFx.durS * 1e6), dualMono: false })

  // ducking: música e voz só de áudio, cada uma na sua faixa com papel; fala da voz analisada pelo mesmo caminho da
  // ingestão (silencedetect → cache/<id>.speech.json)
  const duckMusic = join(dir, 'ducking-musica.m4a')
  const duckVoice = join(dir, 'ducking-voz.m4a')
  const tone = `0.25*sin(2*PI*${DUCK_HZ}*t)`
  const bursts = '0.3*sin(2*PI*1000*t)*(between(t,2,3)+between(t,3.52,4.5)+between(t,7,8))'
  await gen(['-f', 'lavfi', '-i', `aevalsrc='${tone}|${tone}':s=48000:d=10`, '-c:a', 'aac', '-b:a', '192k', duckMusic], 'editor-export: música 220 Hz')
  await gen(['-f', 'lavfi', '-i', `aevalsrc='${bursts}|${bursts}':s=48000:d=10`, '-c:a', 'aac', '-b:a', '192k', duckVoice], 'editor-export: voz em bursts')
  const aDuckMusic: Asset = { ...assetFromInfo('a_dmus', duckMusic, statSync(duckMusic), await probe(duckMusic)), status: 'ready' }
  const aDuckVoice: Asset = { ...assetFromInfo('a_dvoz', duckVoice, statSync(duckVoice), await probe(duckVoice)), status: 'ready', speech: 'cache/a_dvoz.speech.json' }
  const at = (id: string, name: string, role: Track['role'], a: Asset): Track => ({ id, kind: 'audio', name, muted: false, hidden: false, locked: false, volume: 1, role, items: [{ ...createMediaItem(a, 0, 'audio'), durationUs: 10_000_000 }] })
  rmSync(projects.dirOf(DUCKING_ID), { recursive: true, force: true })
  projects.create({ ...createEmptyProject('Ducking', { width: W, height: H, fps: FPS, background: '#000000' }), id: DUCKING_ID, assets: [aDuckVoice, aDuckMusic], tracks: [at('t_voz', 'Voz', 'voice', aDuckVoice), at('t_mus', 'Música', 'music', aDuckMusic)] })
  const duckSpeech = speechFromFile(await buildSpeech(duckVoice, projects.filePath(DUCKING_ID, 'cache/a_dvoz.speech.json'), 10_000_000))

  // sessão v1 sintética (webcam circular espelhada, PiP padrão até 5 s)
  rmSync(sessions.dirOf(SESSION_ID), { recursive: true, force: true })
  const session = await makeSyntheticSession(sessions, SESSION_ID)

  const win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { preload: preloadPath(), sandbox: false, backgroundThrottling: false, additionalArguments: ['--cialight-window=recorder'] } })
  const result = await new Promise<{ ok: boolean; report: HarnessReport }>((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, report: { errors: ['timeout de 480 s'] } }), 480_000)
    ipcMain.once('test:result', (_e, r: { ok: boolean; report: HarnessReport }) => {
      clearTimeout(timer)
      resolve(r)
    })
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning') console.log(`[renderer] ${e.message}`)
    })
    const params = encodeURIComponent(JSON.stringify({ projectId: PROJECT_ID, sessionId: SESSION_ID, outputDir: exportsDir, targetBytes: SMALL_TARGET, colorProjects: [COLOR_601, COLOR_UNTAGGED, COLOR_UNTAGGED_SD], speedProjectId: SPEED_ID, reverseProjectId: REVERSE_ID, denoiseProjectId: DENOISE_ID, duckingProjectId: DUCKING_ID, duckingHz: DUCK_HZ, effects: { projectId: EFFECTS_ID, width: W, height: H, tUs: FX_T_US, block: FX_BLOCK, blur: FX_BLUR, outside: FX_OUTSIDE }, longProjectId: LONG_ID, squareProjectId: SQUARE_ID, targetMB: F7_TARGET_MB }))
    loadPage(win, `index.html#editor-export-test/${params}`)
  })
  // a janela só fecha no fim: sem janelas o app sai (window-all-closed) no meio das verificações
  const r = result.report
  console.log(`relatório do harness: ${JSON.stringify(r)}`)
  check(result.ok && r.errors.length === 0, `harness sem exceção (${JSON.stringify(r.errors)})`, failures)

  // ---- cenário principal ----
  const out = r.scenario?.path
  check(!!out && existsSync(out) && out.endsWith('cenario.mp4'), `cenário exportado (${out ?? r.scenario?.error}) em ${r.scenario?.ms} ms, ${r.scenario?.speed?.toFixed(2)}× tempo real, ${r.scenario?.hardware}`, failures)
  if (out && existsSync(out)) {
    const pr = await probeFile(out)
    const vs = pr.streams.filter((s) => s.type === 'video')
    const as = pr.streams.filter((s) => s.type === 'audio')
    check(vs.length === 1 && vs[0].codec === 'h264' && vs[0].width === W && vs[0].height === H, `1 faixa H.264 ${W}×${H} (${JSON.stringify(vs)})`, failures)
    check(as.length === 1 && as[0].codec === 'aac' && as[0].sampleRate === 48000 && as[0].channels === 2, `1 faixa AAC 48 kHz estéreo (${JSON.stringify(as)})`, failures)
    check(Math.abs(pr.durationMs - 7000) <= FRAME_MS, `duração 7,0 s ± 1 quadro (${pr.durationMs} ms)`, failures)
    check(Math.abs((vs[0]?.fps ?? 0) - FPS) < 0.01, `30 fps (${vs[0]?.fps})`, failures)
    const frames = await countFrames(out)
    check(Math.abs(frames - 210) <= 1, `210 ± 1 quadros (${frames})`, failures)
    const rms0 = await rmsDb(out, 0, 0.1)
    const rms2 = await rmsDb(out, 2, 3)
    const rms3 = await rmsDb(out, 3, 4)
    check(rms0 < -30, `fade-in: RMS dos primeiros 100 ms < −30 dB (${rms0.toFixed(1)} dB)`, failures)
    check(rms2 > -20 && rms3 > -20, `áudio cheio no segundo 3 (> −20 dB): [2,3) ${rms2.toFixed(1)} dB, [3,4) ${rms3.toFixed(1)} dB`, failures)
    const a = await frameRgb(out, 2.0, join(dir, 'q-saida-2s.rgb'))
    const b = await frameRgb(src, 5.0, join(dir, 'q-fonte-5s.rgb'))
    const p25 = psnr(a, b)
    const b4 = await frameRgb(src, 4.0, join(dir, 'q-fonte-4s.rgb'))
    check(p25 > 30, `quadro 2,0 s da saída = quadro 5,0 s da fonte (PSNR ${p25.toFixed(1)} dB > 30; contra 4,0 s: ${psnr(a, b4).toFixed(1)} dB)`, failures)
    // imagem sobreposta em 5 s: centro em (0,85·W, 0,2·H)
    const ov = await frameRgb(out, 5.0, join(dir, 'q-saida-5s-overlay.rgb'), { x: Math.round(0.85 * W) - 8, y: Math.round(0.2 * H) - 8, w: 16, h: 16 })
    const mean = [0, 1, 2].map((c) => ov.filter((_, i) => i % 3 === c).reduce((s, v) => s + v, 0) / (ov.length / 3))
    check(mean[0] > 200 && mean[1] < 50 && mean[2] < 50, `imagem sobreposta visível em 5 s (RGB médio ${mean.map((v) => v.toFixed(0)).join(',')})`, failures)
    check(isFastStart(out), 'faststart: moov antes do mdat', failures)
  }

  // ---- fallback de encoder + nome sem sobrescrever ----
  const fb = r.fallback
  check(!!fb?.path && fb.fellBackToSoftware === true && fb.hardware === 'prefer-software', `falha do hardware → refeito em software (${JSON.stringify(fb)})`, failures)
  check(!!fb?.path && fb.path.endsWith('cenario (2).mp4') && existsSync(fb.path), `nome ocupado → "cenario (2).mp4" (${fb?.path})`, failures)
  if (fb?.path && existsSync(fb.path)) {
    const pr = await probeFile(fb.path)
    check(Math.abs(pr.durationMs - 7000) <= FRAME_MS && pr.streams.some((s) => s.codec === 'h264'), `saída do software válida (${pr.durationMs} ms)`, failures)
  }

  // ---- cancelamento ----
  check(!!r.cancel?.cancelled && r.cancel.afterFrames > 0, `cancelamento no meio interrompe (${JSON.stringify(r.cancel)})`, failures)
  const left = readdirSync(exportsDir)
  check(!left.some((n) => n.endsWith('.part') || n.startsWith('cancelado')), `sem parcial nem arquivo do cancelado (${left.join(', ')})`, failures)

  // ---- erro que não é do codificador ----
  const ne = r.nonEncoder
  check(!!ne?.error && ne.error.includes('Intervalo de exportação vazio') && !ne.error.includes('codificar'), `erro fora do codificador mostra a causa real, sem refazer em software (${ne?.error})`, failures)
  check(!readdirSync(exportsDir).some((n) => n.startsWith('vazio')), 'erro: nenhum arquivo deixado', failures)

  // ---- mídia ausente: pré-checagem + aviso no resultado ----
  const mm = r.missingMedia
  check(!!mm && mm.preflight.length === 1 && mm.preflight[0].assetId === 'a_ausente' && mm.preflight[0].status === 'missing', `pré-checagem lista a mídia ausente (${JSON.stringify(mm?.preflight)})`, failures)
  const mw = mm?.export.warnings ?? []
  check(!!mm?.export.path && existsSync(mm.export.path) && mw.some((w) => w.includes('apagado.mp4') && w.includes('30 quadros')), `mídia ausente exportada → aviso com a mídia e os quadros, não sucesso silencioso (${mm?.export.error ?? JSON.stringify(mw)})`, failures)

  // ---- tamanho-alvo ----
  const sz = r.sized
  check(!!sz?.path && existsSync(sz.path) && (sz.passes ?? 0) === 2 && (sz.size ?? Infinity) <= SMALL_TARGET && statSync(sz.path).size <= SMALL_TARGET, `tamanho-alvo de 2 MB: refeito na 2ª passada e ≤ alvo (${sz?.size} bytes, ${sz?.passes} passadas, avisos ${JSON.stringify(sz?.warnings)})`, failures)

  // ---- cor ----
  const color = r.color ?? {}
  const c601 = color[COLOR_601]
  console.log(`cor BT.601: ${JSON.stringify(c601?.frame)}`)
  if (c601?.export.path && existsSync(c601.export.path)) {
    const e = await frameRgb(c601.export.path, 1.0, join(dir, 'cor601-saida.rgb'))
    const f = await frameRgb(colorSrc[COLOR_601], 1.0, join(dir, 'cor601-fonte.rgb'))
    check(psnr(e, f) > 30, `fonte BT.601 marcada: RGB do quadro exportado ≈ fonte (ffmpeg seguindo as marcações) PSNR ${psnr(e, f).toFixed(1)} dB > 30`, failures)
  } else check(false, `fonte BT.601 exportada (${c601?.export.error})`, failures)
  // Sem marcação, cada um adivinha: o ffmpeg (swscale) usa sempre BT.601; o Chromium (e o mediabunny, que copia o
  // padrão dele) decodifica como BT.709 limitado, mesmo em SD — o colorDiag mostra o VideoFrame de um sink sem
  // ajuste. Regra única (shared/editor/sourceColor.ts, convenção dos players): HD → BT.709, SD → BT.601 (o
  // DecoderPool declara BT.601 ao decoder só em SD). A saída tem de bater com a fonte lida pela regra.
  for (const id of [COLOR_UNTAGGED, COLOR_UNTAGGED_SD]) {
    const cu = color[id]
    const cs = (cu?.frame as { colorSpace?: { matrix?: string; fullRange?: boolean } } | undefined)?.colorSpace
    console.log(`${id}: VideoFrame.colorSpace do Chromium ${JSON.stringify(cs)}`)
    if (!cu?.export.path || !existsSync(cu.export.path) || !cs?.matrix) {
      check(false, `${id}: exportado com colorSpace informado (${cu?.export.error ?? JSON.stringify(cu?.frame)})`, failures)
      continue
    }
    const e = await frameRgb(cu.export.path, 1.0, join(dir, `${id}-saida.rgb`))
    const interp: Record<string, number> = {}
    for (const m of ['bt601', 'bt709'] as const) for (const rg of ['tv', 'pc'] as const) interp[`${m}/${rg}`] = +psnr(e, await frameRgbAs(colorSrc[id], 1.0, join(dir, `${id}-fonte-${m}-${rg}.rgb`), m, rg)).toFixed(1)
    const ffDefault = +psnr(e, await frameRgb(colorSrc[id], 1.0, join(dir, `${id}-fonte.rgb`))).toFixed(1)
    const [sw, sh] = id === COLOR_UNTAGGED_SD ? [640, 480] : [W, H]
    const rule = `${untaggedFamily(sw, sh)}/tv`
    console.log(`${id}: PSNR da saída × fonte em cada interpretação ${JSON.stringify(interp)}; padrão do ffmpeg ${ffDefault} dB`)
    check(interp[rule] > 30, `${id} (${sw}×${sh}): saída = fonte lida pela regra (${rule}: ${interp[rule]} dB > 30; Chromium sem ajuste: ${cs.matrix}/${cs.fullRange ? 'pc' : 'tv'}; ${JSON.stringify(interp)})`, failures)
  }

  // ---- efeitos: projeto 1080p exportado em 720p × preview reduzido ----
  await checkEffects('efeitos', 'H.264 720p a 12 Mbps', r.effects, { w: W, h: H, codec: 'h264' }, dir, failures)

  // ================================ F7: configurações do diálogo ================================
  // a) tamanho alvo personalizado (YouTube 1080p com "Tamanho alvo" de 3 MB) num projeto de 20 s
  const ft = r.f7Target
  const targetBytes = F7_TARGET_MB * 1024 * 1024
  check(ft?.requestTargetBytes === targetBytes, `F7 alvo: o pedido de um tamanho alvo personalizado leva targetBytes = ${targetBytes} (2ª passada habilitada) (${ft?.requestTargetBytes}; bitrate ${ft?.requestVideoBitrate})`, failures)
  check(!!ft?.path && existsSync(ft.path), `F7 alvo: exportado (${ft?.path ?? ft?.error})`, failures)
  if (ft?.path && existsSync(ft.path)) {
    const size = statSync(ft.path).size
    const pr = await probeFile(ft.path)
    check(size <= targetBytes && size >= 0.8 * targetBytes, `F7 alvo: ${(size / 1048576).toFixed(2)} MB ≤ ${F7_TARGET_MB} MB e ≥ ${(0.8 * F7_TARGET_MB).toFixed(1)} MB (${size} bytes, ${ft.passes} passada(s), ${pr.durationMs} ms)`, failures)
    check(Math.abs(pr.durationMs - 20000) <= FRAME_MS, `F7 alvo: duração 20 s ± 1 quadro (${pr.durationMs} ms)`, failures)
  }

  // b) 60 fps a partir de um projeto de 30 fps: quadros exatos
  const f60 = r.f7Fps60
  check(!!f60?.path && existsSync(f60.path), `F7 60 fps: exportado (${f60?.path ?? f60?.error})`, failures)
  if (f60?.path && existsSync(f60.path)) {
    const st = await streamInfo(f60.path)
    const frames = await countFrames(f60.path)
    check(st?.r_frame_rate === '60/1', `F7 60 fps: r_frame_rate 60/1 (${st?.r_frame_rate}, avg ${st?.avg_frame_rate})`, failures)
    check(frames === f60.expectedFrames && frames === Math.round(7 * 60), `F7 60 fps: ${frames} quadros = round(7 s × 60) = ${f60.expectedFrames}`, failures)
  }

  // c) intermediário: quadro-chave a cada ≤ 0,5 s
  const fi = r.f7Intermediate
  check(!!fi?.path && existsSync(fi.path), `F7 intermediário: exportado (${fi?.path ?? fi?.error}; áudio ${fi?.audioCodec})`, failures)
  if (fi?.path && existsSync(fi.path)) {
    const keys = await probeKeyframes(fi.path)
    const gaps = keys.slice(1).map((t, i) => t - keys[i])
    const maxGap = Math.max(0, ...gaps)
    check(keys.length >= 14 && maxGap <= 0.5 + 1e-3, `F7 intermediário: ${keys.length} quadros-chave, maior intervalo ${maxGap.toFixed(3)} s ≤ 0,5 s`, failures)
    const as = (await probeFile(fi.path)).streams.find((s) => s.type === 'audio')
    check(as?.codec === 'aac' && fi.audioCodec === 'aac', `F7 intermediário: áudio AAC (320 kbps pedido; o AAC do Windows aceita até a maior taxa suportada abaixo) ${JSON.stringify(as)}`, failures)
  }

  // d) Feed 1:1 num projeto 1080×1080
  const f11 = r.f7Feed11
  check(!!f11?.availability?.ok && f11?.unavailableOn169?.ok === false, `F7 Feed 1:1: disponível no 1080×1080, indisponível no 16:9 (${JSON.stringify(f11?.unavailableOn169)})`, failures)
  check(!!f11?.path && existsSync(f11.path), `F7 Feed 1:1: exportado (${f11?.path ?? f11?.error})`, failures)
  if (f11?.path && existsSync(f11.path)) {
    const st = await streamInfo(f11.path)
    check(st?.width === 1080 && st?.height === 1080 && st?.codec_name === 'h264', `F7 Feed 1:1: saída 1080×1080 H.264 (${st?.width}×${st?.height} ${st?.codec_name})`, failures)
  }

  // e) HEVC (se o hardware tiver) com a privacidade provada no arquivo HEVC; senão o diálogo bloqueia
  const fh = r.f7Hevc
  if (fh?.supported) {
    await checkEffects('F7 HEVC', 'HEVC 1080p (Original)', fh.effects, { w: 1920, h: 1080, codec: 'hevc' }, dir, failures)
  } else {
    console.log('F7 HEVC: HEVC indisponível — pulado')
    check(fh?.supported === false && fh.dialogBlocker === 'HEVC não suportado neste computador', `F7 HEVC indisponível: o diálogo bloqueia com "HEVC não suportado neste computador" (${fh?.dialogBlocker})`, failures)
  }
  const fhf = r.f7HevcFallback
  check(!!fhf?.path && existsSync(fhf.path) && fhf.fellBackFromHevc === true && fhf.codec === 'h264' && (fhf.warnings ?? []).some((w) => w.includes('HEVC falhou')), `F7 HEVC com falha injetada → refeito em H.264 com aviso (${JSON.stringify({ path: fhf?.path, codec: fhf?.codec, fellBackFromHevc: fhf?.fellBackFromHevc, warnings: fhf?.warnings, error: fhf?.error })})`, failures)
  if (fhf?.path && existsSync(fhf.path)) {
    const st = await streamInfo(fhf.path)
    check(st?.codec_name === 'h264', `F7 HEVC com falha: arquivo H.264 (${st?.codec_name}/${st?.codec_tag_string})`, failures)
  }

  // f) privacidade num preset reduzido: WhatsApp (1280×720 do projeto 1920×1080, bitrate do preset)
  await checkEffects('F7 WhatsApp', 'preset WhatsApp 720p', r.f7Whatsapp, { w: 1280, h: 720, codec: 'h264' }, dir, failures)

  // ---- velocidade 2× com tom preservado ----
  const spOut = r.speed?.path
  check(!!spOut && existsSync(spOut), `velocidade: clipe de 6 s a 2× exportado (${spOut ?? r.speed?.error})`, failures)
  if (spOut && existsSync(spOut)) {
    const pr = await probeFile(spOut)
    check(Math.abs(pr.durationMs - 3000) <= FRAME_MS, `velocidade: duração 3,0 s ± 1 quadro (${pr.durationMs} ms)`, failures)
    const outPcm = await pcmOf(spOut, join(dir, 'velocidade-saida.f32'))
    const srcPcm = await pcmOf(voice, join(dir, 'velocidade-fonte.f32'))
    const hzOut = dominantHz(outPcm, 48000, 48000, 100, 1000)
    const hzSrc = dominantHz(srcPcm, 2 * 48000, 48000, 100, 1000)
    let sq = 0
    for (let i = 48000; i < 2 * 48000 && i < outPcm.length; i++) sq += outPcm[i] * outPcm[i]
    const rms = Math.sqrt(sq / 48000)
    check(Math.abs(hzOut - VOICE_HZ) / VOICE_HZ <= 0.02 && Math.abs(hzSrc - VOICE_HZ) / VOICE_HZ <= 0.02 && rms > 0.05, `velocidade: tom mantido a 2× — fundamental ${hzOut} Hz na saída × ${hzSrc} Hz na fonte (${VOICE_HZ} ±2 %; reamostrado daria ${2 * VOICE_HZ}), RMS ${rms.toFixed(3)}`, failures)
  }

  const spAgain = r.speedAgain?.path
  check(!!spOut && !!spAgain && existsSync(spOut) && existsSync(spAgain), `velocidade: 2ª exportação igual (${spAgain ?? r.speedAgain?.error})`, failures)
  if (spOut && spAgain && existsSync(spOut) && existsSync(spAgain)) {
    const a = await pcmOf(spOut, join(dir, 'velocidade-a.f32'), 2)
    const b = await pcmOf(spAgain, join(dir, 'velocidade-b.f32'), 2)
    let diff = 0
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff = Math.max(diff, Math.abs(a[i] - b[i]))
    check(a.length > 0 && a.length === b.length && diff === 0, `velocidade: exportação determinística — PCM estéreo decodificado idêntico nas duas exportações (${a.length} × ${b.length} amostras, diferença máx. ${diff})`, failures)
  }

  // ---- redução de ruído: a exportação lê a versão processada; desligada, volta ao original ----
  const dnOn = r.denoise?.path
  const dnOff = r.denoiseOff?.path
  check(!!dnOn && !!dnOff && existsSync(dnOn) && existsSync(dnOff), `ruído: exportado com e sem a redução (${dnOn ?? r.denoise?.error} | ${dnOff ?? r.denoiseOff?.error})`, failures)
  if (dnOn && dnOff && existsSync(dnOn) && existsSync(dnOff)) {
    for (const [a, b] of voiceFx.pauses) {
      const src = await rmsDb(join(dir, 'voz-ruido.m4a'), a, b)
      const on = await rmsDb(dnOn, a, b)
      const off = await rmsDb(dnOff, a, b)
      check(Math.abs(off - src) <= 1.5 && off - on >= 10, `ruído: pausa ${a.toFixed(1)}–${b.toFixed(1)} s — fonte ${src.toFixed(1)} dB, desligado ${off.toFixed(1)} dB (= fonte ±1,5), tratado ${on.toFixed(1)} dB (≥ 10 dB abaixo)`, failures)
    }
    // tratado × original na exportação: mesma linha do tempo (|atraso| ≤ 2 ms); só com a voz do Windows, que o RNNoise mantém
    if (voiceFx.kind === 'tts') {
      const lag = crossCorrelationLag(await pcmOf(dnOff, join(dir, 'ruido-original.f32')), await pcmOf(dnOn, join(dir, 'ruido-tratado.f32')), 2400, 4)
      check(Math.abs(lag) <= 96, `ruído: exportação tratada alinhada à original (${lag} amostras = ${((lag / 48) || 0).toFixed(2)} ms; ≤ 2 ms)`, failures)
    } else console.log('ruído: sem voz do Windows; correlação tratado × original não se aplica à voz harmônica')
  }

  // ---- ducking: música −12 dB ±1 durante a fala (e nas pausas menores que o hold), 0 dB ±0,5 fora, rampas monotônicas ----
  const dk = r.ducking?.path
  check(!!dk && existsSync(dk), `ducking: exportado (${dk ?? r.ducking?.error})`, failures)
  if (dk && existsSync(dk)) {
    // canal esquerdo (o preview mede o mesmo canal); nível relativo à música da fonte
    const left = (x: Float32Array): Float32Array => x.filter((_, i) => i % 2 === 0)
    const ref = toneAmplitude(left(await pcmOf(duckMusic, join(dir, 'ducking-musica.f32'), 2)), 48000, 4 * 48000, DUCK_HZ, 48000)
    const out = left(await pcmOf(dk, join(dir, 'ducking-saida.f32'), 2))
    const levels: number[] = []
    for (let i = 0; i + DUCK_WIN <= out.length; i += DUCK_HOP) levels.push(20 * Math.log10(Math.max(1e-9, toneAmplitude(out, i, DUCK_WIN, DUCK_HZ, 48000)) / ref))
    const dc = duckingCheck(levels, duckSpeech)
    console.log(`ducking: fala ${JSON.stringify(duckSpeech)}; ${JSON.stringify(dc)}`)
    check(dc.speech.n > 100 && dc.speech.min >= -13 && dc.speech.max <= -11, `ducking: música durante a fala −12 dB ±1 (${dc.speech.n} janelas de 50 ms: ${dc.speech.min.toFixed(2)} a ${dc.speech.max.toFixed(2)} dB)`, failures)
    check(dc.hold.n > 5 && dc.hold.min >= -13 && dc.hold.max <= -11, `ducking: pausa de ${dc.holdGapMs} ms (< hold de 300 ms) não solta (${dc.hold.n} janelas: ${dc.hold.min.toFixed(2)} a ${dc.hold.max.toFixed(2)} dB)`, failures)
    check(dc.outside.n > 100 && dc.outside.min >= -0.5 && dc.outside.max <= 0.5, `ducking: fora da fala (longe das rampas) 0 dB ±0,5 (${dc.outside.n} janelas: ${dc.outside.min.toFixed(2)} a ${dc.outside.max.toFixed(2)} dB)`, failures)
    check(dc.ramps.length === 4 && dc.ramps.every((x) => x.backstep <= 0.1 && x.span >= 6), `ducking: rampas monotônicas — ataque desce e soltura sobe (recuo máx. ${Math.max(0, ...dc.ramps.map((x) => x.backstep)).toFixed(3)} dB ≤ 0,1; variação ${dc.ramps.map((x) => x.span.toFixed(1)).join(' / ')} dB) ${JSON.stringify(dc.ramps)}`, failures)
    const pl = r.duckingPreview?.levelsDb
    let maxDiff = 0
    const n = pl ? Math.min(pl.length, levels.length) : 0
    // sem as pontas (priming do AAC da exportação), como em duckingCheck
    const skip = Math.ceil((0.05 * 48000) / DUCK_HOP)
    for (let i = skip; i < n - skip - DUCK_WIN / DUCK_HOP; i++) maxDiff = Math.max(maxDiff, Math.abs(pl![i] - (levels[i] + 20 * Math.log10(ref))))
    check(!r.duckingPreview?.error && n > 900 && maxDiff <= 0.5, `ducking: preview (AudioClient, blocos de 100 ms) = exportação — nível da música por janela (dif. máx. ${maxDiff.toFixed(3)} dB em ${n} janelas) ${r.duckingPreview?.error ?? ''}`, failures)
  }

  // ---- reverso × ffmpeg -vf reverse ----
  const rvOut = r.reverse?.path
  check(!!rvOut && existsSync(rvOut), `reverso: trecho de 3 s exportado de trás para frente (${rvOut ?? r.reverse?.error}) em ${r.reverse?.ms} ms`, failures)
  if (rvOut && existsSync(rvOut)) {
    const ref = join(dir, 'reverso-ref.mp4')
    // -t de entrada: o filtro reverse guarda tudo o que entra (com -t de saída inverteria até o fim do arquivo)
    await gen(['-ss', '2', '-t', '3', '-i', src, '-an', '-vf', 'reverse', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '10', '-pix_fmt', 'yuv420p', ...BT709, ref], 'teste: reverso de referência')
    const pr = await probeFile(rvOut)
    check(Math.abs(pr.durationMs - 3000) <= FRAME_MS && (await countFrames(rvOut)) === 90, `reverso: 3,0 s e 90 quadros (${pr.durationMs} ms)`, failures)
    for (const t of [0.5, 1.5, 2.5]) {
      const a = await frameRgb(rvOut, t, join(dir, `reverso-saida-${t}.rgb`))
      const b = await frameRgb(ref, t, join(dir, `reverso-ref-${t}.rgb`))
      const nb = await frameRgb(ref, t + 1 / FPS, join(dir, `reverso-ref-vizinho-${t}.rgb`))
      const p = psnr(a, b)
      check(p > 30, `reverso: quadro ${t.toFixed(1)} s = ffmpeg reverse (PSNR ${p.toFixed(1)} dB > 30; contra o quadro vizinho: ${psnr(a, nb).toFixed(1)} dB)`, failures)
    }
  }

  // ---- preview intocado durante a exportação ----
  const pv = r.previewUntouched
  check(!!pv && !('error' in pv) && pv.before.length > 0 && pv.before.every((v, i) => Math.abs(v - pv.after[i]) <= 2), `preview continua vivo e igual depois da exportação (${JSON.stringify(pv)})`, failures)

  // ---- paridade com a v1 (webcam circular) ----
  const ed = r.parity?.path
  let v1Out: string | null = null
  if (r.v1Composed?.path) {
    const options: ExportOptions = {
      presetId: 'max', trimStartMs: 0, trimEndMs: null, includeWebcam: true, includeAnnotations: true, audioMode: 'mix', micOffsetMs: 0,
      targetSizeMB: null, reels: false, outputDir: exportsDir, fileName: 'paridade-v1', pipOverride: null
    }
    const v1 = await new Promise<{ outputs: string[]; error?: string }>((resolve) => {
      // encoder do cache (só leitura): sem cache o job dispararia o probe, que grava no settings.json
      startExportJob({ sessionId: session.id, options, composedFile: r.v1Composed!.path! }, sessions, (p) => {
        if (p.stage === 'done') resolve({ outputs: p.outputs ?? [] })
        else if (p.stage === 'error' || p.stage === 'cancelled') resolve({ outputs: [], error: p.error ?? p.stage })
      }, { encoder: cachedEncoderProbe()?.preferred ?? 'libx264' })
    })
    v1Out = v1.outputs[0] ?? null
    check(!!v1Out && existsSync(v1Out), `v1 (composição + job ffmpeg, como __qaExport) exportou (${v1Out ?? v1.error})`, failures)
  } else check(false, `v1: composição falhou (${r.v1Composed?.error})`, failures)
  check(!!ed && existsSync(ed), `editor: projeto da sessão exportado (${ed ?? r.parity?.error})`, failures)
  if (ed && v1Out && existsSync(ed) && existsSync(v1Out)) {
    const tMs = 3000
    const rect = pipRectAt(session.pip, tMs)!
    const px = pipPixelRect(clampPip(rect), session.video.width, session.video.height)
    const side = Math.round(px.w * 0.5)
    const crop = { x: Math.round(px.x + px.w / 2 - side / 2), y: Math.round(px.y + px.h / 2 - side / 2), w: side, h: side }
    const fe = await frameRgb(ed, tMs / 1000, join(dir, 'pip-editor.rgb'), crop)
    const fv = await frameRgb(v1Out, tMs / 1000, join(dir, 'pip-v1.rgb'), crop)
    const p = psnr(fe, fv)
    check(p > 28, `paridade: centro da PiP em 3 s ≈ v1 (PSNR ${p.toFixed(1)} dB > 28; recorte ${JSON.stringify(crop)})`, failures)
  }

  check(settingsHash() === hashBefore, 'settings.json do usuário intocado', failures)
  win.destroy()
  writeFileSync(join(outDir, 'editor-export-report.json'), JSON.stringify({ result, failures }, null, 2))
  console.log(failures.length ? `\nFALHAS (${failures.length}):\n - ${failures.join('\n - ')}` : '\nTESTE DE EXPORTAÇÃO DO EDITOR PASSOU')
  return failures.length ? 1 : 0
}
