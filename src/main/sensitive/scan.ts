import type { Us } from '@shared/editor/project'
import { detectSensitive, type Detection, type OcrLine, type SensitiveKind } from '@shared/editor/sensitive'
import {
  applyRefinement,
  carryDetections,
  frameChanged,
  groupOccurrences,
  helperLinesToOcr,
  OCR_UPSCALE,
  refinementJobs,
  refineScale,
  refineTrack,
  REFINE_FPS,
  REFINE_STEP_US,
  SAMPLE_FPS,
  SAMPLE_INTERVAL_US,
  tilePlan,
  type Occurrence,
  type RefineJob,
  type ScanError,
  type ScanProgress,
  type ScanResult,
  type ScanSample,
  type ScanTimings
} from '@shared/editor/sensitiveScan'
import type { GrayImage } from '@shared/editor/track'
import { frameCountFor, sampleFrames, subFrames, type FrameStream, type RawFrame } from './frameSource'
import { OCR_UNAVAILABLE_MESSAGE, OcrHelper, OcrUnavailableError } from './ocrHelper'

// Varredura de dados sensíveis de UM arquivo de origem (ruling R2): quadros a 2 qps (ffmpeg → memória) → quadro igual ao
// último lido reaproveita as detecções → OCR (helper WinRT) → OcrLine normalizadas → detectSensitive → amostras →
// ocorrências (groupOccurrences) → refinamento por NCC de pré/pós-rolagem e intervalos com movimento.
// PRIVACIDADE (R6): texto lido, valores e termos personalizados só em memória; o resultado não tem valor; o log recebe só
// contagens, tipos, tempos e códigos de erro. Nada é gravado em disco. Sem `electron` aqui: caminhos e probe injetados.

export interface ScanRequest {
  filePath: string
  fromUs: Us
  toUs: Us
  kinds?: SensitiveKind[]
  customTerms?: string[]
}

export interface ScanLog {
  info: (...a: unknown[]) => void
  warn: (...a: unknown[]) => void
}

export interface ScanDeps {
  ffmpeg: string
  helperScript: string
  /** Dimensões (codificadas) + giro de exibição + duração (src/main/media/probe.ts). */
  probe: (file: string) => Promise<{ video?: { width: number; height: number; rotation?: number }; durationUs: number | null }>
  log?: ScanLog
  /** Força o idioma do OCR (testes). */
  helperLang?: string
  frameTimeoutMs?: number
  readyTimeoutMs?: number
  /** PIDs iniciados (testes de cancelamento). */
  onSpawn?: (pid: number, what: 'ffmpeg' | 'ocr') => void
  /** Teto do refinamento: fração da duração do trecho em sub-quadros decodificados (padrão 0,3, mínimo 2 s). */
  refineBudget?: number
}

export interface ScanRunOpts {
  signal?: AbortSignal
  onProgress?: (p: ScanProgress) => void
}

/** Sobreposição dos ladrilhos (px da imagem ampliada): mais que uma linha de texto ampliada. */
const TILE_OVERLAP = 256
/** Refinamento: mínimo de decodificação permitida e teto de tempo de parede (fração da amostragem, mínimo). */
const REFINE_MIN_BUDGET_US = 2_000_000
const REFINE_WALL_FRAC = 0.3
const REFINE_WALL_MIN_MS = 3000

export const SCAN_MESSAGES = {
  ffmpeg: 'Não foi possível ler o vídeo para procurar dados sensíveis.',
  noVideo: 'O arquivo não tem uma faixa de vídeo para procurar dados sensíveis.',
  range: 'O trecho pedido está vazio ou fora do vídeo.'
} as const

const noop = (): void => {}

function countKinds(occ: readonly Occurrence[]): string {
  const m = new Map<string, number>()
  for (const o of occ) m.set(o.kind, (m.get(o.kind) ?? 0) + 1)
  return [...m].map(([k, n]) => `${k}=${n}`).join(' ') || 'nenhuma'
}

export async function runScan(req: ScanRequest, deps: ScanDeps, opts: ScanRunOpts = {}): Promise<ScanResult> {
  const t0 = performance.now()
  const log = deps.log ?? { info: noop, warn: noop }
  const signal = opts.signal
  const progress = opts.onProgress ?? noop
  let framesSampled = 0
  let framesOcr = 0
  let lang = ''
  let occurrences: Occurrence[] = []
  const timings: ScanTimings = { startMs: 0, samplingMs: 0, ocrMs: 0, refineMs: 0 }
  const finish = (extra: { cancelled?: boolean; error?: ScanError } = {}): ScanResult => {
    const ms = Math.round(performance.now() - t0)
    if (extra.cancelled) log.info(`sensitive: varredura cancelada (${framesSampled} quadros, ${framesOcr} lidos, ${ms} ms)`)
    else if (extra.error) log.warn(`sensitive: varredura com erro ${extra.error.code} (${framesSampled} quadros, ${framesOcr} lidos, ${ms} ms)`)
    else log.info(`sensitive: varredura concluída: ${framesSampled} quadros, ${framesOcr} lidos, ${occurrences.length} ocorrências (${countKinds(occurrences)}), ${ms} ms (partida ${timings.startMs}, amostragem ${timings.samplingMs}, OCR ${timings.ocrMs}, refinamento ${timings.refineMs}), idioma ${lang}`)
    return { occurrences: extra.cancelled ? [] : occurrences, framesSampled, framesOcr, ms, lang, timings, ...extra }
  }
  if (signal?.aborted) return finish({ cancelled: true })

  // ---- processos (só os PIDs iniciados aqui são mortos no cancelamento). O helper (partida do PowerShell + WinRT,
  // 0,4–1 s) sobe em paralelo com o probe e o ffmpeg (que espera no pipe até o 1º quadro ser lido).
  let helper: OcrHelper | null = null
  let stream: FrameStream | null = null
  const live: { sub: FrameStream | null } = { sub: null }
  const helperP = OcrHelper.start({
    script: deps.helperScript,
    lang: deps.helperLang,
    frameTimeoutMs: deps.frameTimeoutMs,
    readyTimeoutMs: deps.readyTimeoutMs,
    onSpawn: (pid) => deps.onSpawn?.(pid, 'ocr')
  })
  helperP.catch(noop)
  const dropHelper = (): void => void helperP.then((h) => h.kill(), noop)
  const onAbort = (): void => {
    stream?.kill()
    live.sub?.kill()
    helper?.kill()
    dropHelper()
  }
  signal?.addEventListener('abort', onAbort)
  try {
    // ---- origem
    let W = 0, H = 0, toUs = req.toUs
    try {
      const info = await deps.probe(req.filePath)
      const v = info.video
      if (!v || !(v.width > 0) || !(v.height > 0)) return finish({ error: { code: 'invalid', message: SCAN_MESSAGES.noVideo } })
      const rot = v.rotation ?? 0
      // o ffmpeg gira na decodificação: o quadro da origem é o exibido
      ;[W, H] = rot === 90 || rot === 270 ? [v.height, v.width] : [v.width, v.height]
      if (info.durationUs !== null && info.durationUs > 0) toUs = Math.min(toUs, info.durationUs)
    } catch {
      return finish({ error: { code: 'ffmpeg', message: SCAN_MESSAGES.ffmpeg } })
    }
    const fromUs = Math.max(0, req.fromUs)
    if (!(toUs > fromUs)) return finish({ error: { code: 'invalid', message: SCAN_MESSAGES.range } })
    if (signal?.aborted) return finish({ cancelled: true })
    const total = frameCountFor(fromUs, toUs, SAMPLE_FPS, false)
    progress({ phase: 'amostrando', done: 0, total })
    stream = sampleFrames({ ffmpeg: deps.ffmpeg, file: req.filePath, fromUs, toUs, sourceW: W, sourceH: H, fps: SAMPLE_FPS, upscale: OCR_UPSCALE, onSpawn: (pid) => deps.onSpawn?.(pid, 'ffmpeg') })

    // cancelar durante a partida não espera o helper responder
    const aborted = new Promise<'aborted'>((r) => signal?.addEventListener('abort', () => r('aborted')))
    const started = await Promise.race([helperP, aborted]).catch((e: unknown) => e)
    if (started === 'aborted') return finish({ cancelled: true })
    if (!(started instanceof OcrHelper)) return finish({ error: { code: 'ocrUnavailable', message: started instanceof OcrUnavailableError ? started.message : OCR_UNAVAILABLE_MESSAGE } })
    helper = started
    lang = helper.lang
    timings.startMs = Math.round(performance.now() - t0)
    if (signal?.aborted) return finish({ cancelled: true })

    // ---- amostragem + OCR
    const samples: ScanSample[] = []
    const detectOpts = { kinds: req.kinds, customTerms: req.customTerms }
    let lastFrame: Uint8Array | null = null
    let lastDets: Detection[] = []
    let ocrError: OcrUnavailableError | null = null
    const h = helper
    for await (const f of stream.frames) {
      if (signal?.aborted) break
      framesSampled++
      if (!lastFrame || frameChanged(lastFrame, f.data, f.w, f.h)) {
        try {
          const tOcr = performance.now()
          const lines = await ocrFrame(h, f)
          timings.ocrMs += Math.round(performance.now() - tOcr)
          const fresh = detectSensitive(lines, detectOpts)
          // união entre leituras: o que o OCR deixou de ler sobre pixels que não mudaram continua valendo
          lastDets = lastFrame ? carryDetections(lastDets, fresh, lastFrame, f.data, f.w, f.h) : fresh
          lastFrame = f.data
          framesOcr++
        } catch (e) {
          if (signal?.aborted) break
          if (e instanceof OcrUnavailableError) {
            ocrError = e
            break
          }
          // erro só deste quadro: fica com as detecções do anterior (cobre) e o próximo quadro é lido de novo
        }
      }
      samples.push({ tUs: f.tUs, detections: lastDets })
      progress({ phase: 'lendo', done: framesSampled, total })
    }
    if (signal?.aborted) return finish({ cancelled: true })
    const groupCtx = { fromUs, toUs, sourceW: W, sourceH: H, intervalUs: SAMPLE_INTERVAL_US }
    if (ocrError) {
      stream.kill()
      occurrences = groupOccurrences(samples, groupCtx)
      return finish({ error: { code: 'ocrUnavailable', message: ocrError.message } })
    }
    const res = await stream.done
    if (res.code !== 0 && !res.killed) {
      occurrences = groupOccurrences(samples, groupCtx)
      return finish({ error: { code: 'ffmpeg', message: SCAN_MESSAGES.ffmpeg } })
    }
    const samplingMs = performance.now() - t0
    timings.samplingMs = Math.round(samplingMs)
    // o helper fecha em paralelo com o refinamento (o finally espera)
    void helper.close().catch(noop)

    // ---- ocorrências + refinamento
    occurrences = groupOccurrences(samples, groupCtx)
    occurrences = await refine(occurrences, { deps, file: req.filePath, W, H, rangeUs: toUs - fromUs, samplingMs, signal, progress, setSub: (s) => (live.sub = s) })
    timings.refineMs = Math.round(performance.now() - t0 - samplingMs)
    if (signal?.aborted) return finish({ cancelled: true })
    return finish()
  } finally {
    signal?.removeEventListener('abort', onAbort)
    stream?.kill()
    live.sub?.kill()
    if (helper) await helper.close().catch(noop)
    else dropHelper()
  }
}

/** OCR de um quadro ampliado (ladrilhado se passar do maxDim do motor). */
async function ocrFrame(h: OcrHelper, f: RawFrame): Promise<OcrLine[]> {
  const tiles = tilePlan(f.w, f.h, h.maxDim, TILE_OVERLAP)
  if (tiles.length === 1) return helperLinesToOcr(await h.recognize(f.data, f.w, f.h), f.w, f.h)
  const out: OcrLine[] = []
  for (const t of tiles) {
    const buf = new Uint8Array(t.w * t.h)
    for (let y = 0; y < t.h; y++) buf.set(f.data.subarray((t.y + y) * f.w + t.x, (t.y + y) * f.w + t.x + t.w), y * t.w)
    out.push(...helperLinesToOcr(await h.recognize(buf, t.w, t.h), f.w, f.h, t))
  }
  return out
}

interface RefineCtx {
  deps: ScanDeps
  file: string
  W: number
  H: number
  rangeUs: Us
  samplingMs: number
  signal?: AbortSignal
  progress: (p: ScanProgress) => void
  setSub: (s: FrameStream | null) => void
}

/** Janela de sub-quadros: um intervalo [fromUs, toUs] e os jobs (de várias ocorrências) que o usam. */
interface Window { fromUs: Us; toUs: Us; jobs: RefineJob[]; prio: number }

/**
 * Refinamento por NCC com teto (documentado): decodifica no máximo max(2 s, 0,3 × trecho) de sub-quadros (pré/pós-
 * rolagem antes dos intervalos com movimento) e para quando passa de max(3 s, 0,3 × tempo da amostragem); o que não
 * couber fica com a regra conservadora (pré/pós-rolagem: a caixa da ponta; movimento: a caixa que contém as duas
 * amostras). Janelas encostadas viram uma só decodificação ("corrida"); cada janela é rastreada quando seu último
 * sub-quadro chega (só ela fica em memória).
 */
async function refine(occs: Occurrence[], c: RefineCtx): Promise<Occurrence[]> {
  const byId = new Map(occs.map((o) => [o.id, o]))
  const wins = new Map<string, Window>()
  for (const o of occs) {
    for (const j of refinementJobs(o)) {
      const key = `${j.fromUs}:${j.toUs}`
      const w = wins.get(key) ?? { fromUs: j.fromUs, toUs: j.toUs, jobs: [], prio: 1 }
      w.jobs.push(j)
      if (j.kind !== 'move') w.prio = 0
      wins.set(key, w)
    }
  }
  if (wins.size === 0) return occs
  const budget = Math.max(REFINE_MIN_BUDGET_US, (c.deps.refineBudget ?? 0.3) * c.rangeUs)
  const chosen: Window[] = []
  let used = 0
  for (const w of [...wins.values()].sort((a, b) => a.prio - b.prio || a.fromUs - b.fromUs)) {
    const d = w.toUs - w.fromUs
    if (used + d > budget) continue
    used += d
    chosen.push(w)
  }
  chosen.sort((a, b) => a.fromUs - b.fromUs || a.toUs - b.toUs)
  // corridas: janelas que se tocam/sobrepõem são decodificadas juntas
  const runs: { fromUs: Us; toUs: Us; wins: Window[] }[] = []
  for (const w of chosen) {
    const last = runs[runs.length - 1]
    if (last && w.fromUs <= last.toUs) {
      last.toUs = Math.max(last.toUs, w.toUs)
      last.wins.push(w)
    } else runs.push({ fromUs: w.fromUs, toUs: w.toUs, wins: [w] })
  }
  const wallMax = Math.max(REFINE_WALL_MIN_MS, REFINE_WALL_FRAC * c.samplingMs)
  const tStart = performance.now()
  c.progress({ phase: 'analisando', done: 0, total: runs.length })
  for (let ri = 0; ri < runs.length; ri++) {
    if (c.signal?.aborted || performance.now() - tStart > wallMax) break
    const run = runs[ri]
    const boxes = run.wins.flatMap((w) => w.jobs.map((j) => j.anchorBox))
    const s = refineScale(c.W, c.H, boxes)
    const aw = Math.max(1, Math.round(c.W * s)), ah = Math.max(1, Math.round(c.H * s))
    const st = subFrames({ ffmpeg: c.deps.ffmpeg, file: c.file, fromUs: run.fromUs, toUs: run.toUs, w: aw, h: ah, fps: REFINE_FPS, onSpawn: (pid) => c.deps.onSpawn?.(pid, 'ffmpeg') })
    c.setSub(st)
    const buffers = new Map<Window, { tUs: Us; img: GrayImage }[]>()
    // a janela é rastreada no seu último sub-quadro (o da grade ≤ toUs) ou, se o vídeo acabar antes, no fim da corrida
    const flush = (w: Window): void => {
      const b = buffers.get(w)
      buffers.delete(w)
      if (!b || b.length === 0) return
      for (const j of w.jobs) {
        const r = refineTrack(b, j, c.W, c.H)
        const o = byId.get(j.occId)
        if (r && o) byId.set(j.occId, applyRefinement(o, r))
      }
    }
    try {
      for await (const f of st.frames) {
        // teto de tempo também dentro da corrida: as janelas ainda incompletas ficam com a regra conservadora
        if (c.signal?.aborted || performance.now() - tStart > wallMax) {
          buffers.clear()
          break
        }
        const img: GrayImage = { width: f.w, height: f.h, data: Float32Array.from(f.data) }
        for (const w of run.wins) {
          if (f.tUs < w.fromUs || f.tUs > w.toUs) continue
          const b = buffers.get(w) ?? []
          b.push({ tUs: f.tUs, img })
          buffers.set(w, b)
          if (f.tUs + REFINE_STEP_US > w.toUs) flush(w)
        }
      }
      if (!c.signal?.aborted) for (const w of [...buffers.keys()]) flush(w)
    } finally {
      st.kill()
      c.setSub(null)
    }
    await st.done
    c.progress({ phase: 'analisando', done: ri + 1, total: runs.length })
  }
  return occs.map((o) => byId.get(o.id) ?? o)
}
