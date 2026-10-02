// Render worker do editor: resolveFrame → fontes (DecoderPool) → Compositor WebGL2 → `rendered`.
// Único caminho de render para preview e exportação ("preview = export"). Pedidos de quadro que chegam
// durante um render são coalescidos (fica só o último); o cliente resolve os intermediários com o resultado dele.
// Todo VideoFrame entregue ao compositor é fechado no mesmo quadro (ver posse em decoderPool.ts).
//
// Exportação (`exportStart`, numa instância própria com o canvas na resolução de saída): para n = 0..N−1,
// tUs = fromUs + frameToUs(n, fps) → o mesmo composeAt do preview (fontes originais/intermediárias, sequencial)
// → VideoSample(canvas) → VideoSampleSource H.264 (ou HEVC, só hardware); o áudio vem em blocos de 100 ms do audio worker de
// exportação pela MessagePort, em ordem, → AudioSampleSource (AAC, ou Opus se AAC indisponível). O MP4
// (mdat antes do moov; o main remuxa com faststart) sai em chunks `exportChunk` com contrapressão por `chunkAck`.
// Quadros (`exportFramesStart`: GIF; fallback libx264): o mesmo laço de quadros, mas cada quadro é lido do canvas
// (RGBA de cima para baixo) e sai em `exportFrame`, com até FRAMES_MAX_INFLIGHT sem ack. Quadro único
// (`exportStill`): composeAt → canvas.convertToBlob PNG (opaco: o contexto não tem alfa e o fundo é desenhado).
import {
  AudioSample,
  AudioSampleSource,
  canEncodeAudio,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  VideoSample,
  VideoSampleSource,
  type StreamTargetChunk
} from 'mediabunny'
import { resolveFrame, type AnnotationsLayer } from '@shared/editor/resolve'
import type { Project, Us } from '@shared/editor/project'
import { frameToUs } from '@shared/editor/time'
import type { Session } from '@shared/types'
import { drawStrokes } from '@shared/compositor'
import { FILE_PROTOCOL } from '@shared/ipc'
import { h264LevelFor, hevcCodecString } from '@/engine/encoderSupport'
import { Compositor, type SourceMeta } from './compositor/compositor'
import { DecoderPool } from './decoderPool'
import { SR } from './audio/mixer'
import type { AudioIn, AudioOut } from './audio/protocol'
import { frameCount } from '../export/exportPlan'
import type { ExportJobSpec, FramesJobSpec, RenderIn, RenderOut } from './protocol'

type FrameMsg = Extract<RenderIn, { t: 'frame' }>

const post = (m: RenderOut, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(m, transfer)

// Sessão indisponível: nova tentativa depois disso.
const SESSION_RETRY_MS = 5000
// Reprodução: decoders dos itens que começam dentro desse intervalo são aquecidos antes.
const PREFETCH_US = 1_000_000

let compositor: Compositor | null = null
let canvas: OffscreenCanvas | null = null
let dpr = 1
const pool = new DecoderPool()
let project: Project | null = null
let selection: string[] = []
let pending: FrameMsg | null = null
let busy = false
// Sessões das anotações: carregadas antes do draw (que é síncrono). Falha → null, nova tentativa após SESSION_RETRY_MS.
const sessions = new Map<string, { load: Promise<void>; session: Session | null; failedAt: number | null }>()
let annCanvas: OffscreenCanvas | null = null
// itens já aquecidos nesta reprodução (zera ao pausar/seek)
const prefetched = new Set<string>()

self.addEventListener('message', (e: MessageEvent<RenderIn>) => {
  const m = e.data
  try {
    switch (m.t) {
      case 'init':
        canvas = m.canvas
        dpr = m.dpr || 1
        compositor = new Compositor(m.canvas)
        compositor.resize(m.width * dpr, m.height * dpr)
        canvas.addEventListener('webglcontextlost', () => post({ t: 'error', message: 'contexto WebGL perdido', fatal: true }))
        post({ t: 'ready' })
        break
      case 'project': {
        project = m.project
        const urls: Record<string, string> = {}
        const videoTracks: Record<string, number> = {}
        for (const [id, u] of Object.entries(m.mediaUrls)) {
          const asset = m.project.assets.find((a) => a.id === id)
          const idx = asset?.videoTrackIndex
          // proxy e intermediário levam só 0:v:0: faixa v:N > 0 lê sempre o original (sessões nem têm proxy)
          const proxy = m.useProxy && u.proxy && !idx
          urls[id] = proxy ? u.proxy! : u.original
          if (!proxy && !asset?.intermediate && idx !== undefined) videoTracks[id] = idx
        }
        pool.setSources(urls, videoTracks)
        if (!busy) pool.flushRetired()
        break
      }
      case 'resize':
        compositor?.resize(m.width * dpr, m.height * dpr)
        break
      case 'frame':
        pending = m
        if (!busy) void pump()
        break
      case 'overlay':
        selection = m.selection
        break
      case 'idle':
        pool.releaseAll()
        break
      case 'testStall': {
        const until = performance.now() + m.ms
        while (performance.now() < until) {
          // espera ocupada de propósito: nenhum quadro sai até o watchdog trocar o worker
        }
        break
      }
      case 'testBench':
        void bench(m)
        break
      case 'readPixels': {
        const data = compositor ? compositor.readPixels(m.x, m.y, m.w, m.h) : new Uint8Array(0)
        post({ t: 'pixels', id: m.id, data }, [data.buffer])
        break
      }
      case 'dispose':
        pending = null
        project = null
        compositor?.dispose()
        compositor = null
        pool.dispose()
        post({ t: 'disposed' })
        break
      case 'exportStart':
        startExport(m.job, m.audioPort)
        break
      case 'exportCancel':
        if (exporting?.jobId === m.jobId) exporting.abort.abort()
        break
      case 'chunkAck':
        if (exporting?.jobId === m.jobId) exporting.outbox.ack(m.seq)
        break
      case 'exportFramesStart':
        startFrames(m.job)
        break
      case 'exportStill':
        void exportStill(m.id, m.tUs)
        break
    }
  } catch (err) {
    post({ t: 'error', message: errMsg(err), fatal: m.t === 'init' })
  }
})

async function pump(): Promise<void> {
  busy = true
  try {
    while (pending) {
      const m = pending
      pending = null
      try {
        await renderFrame(m)
      } catch (err) {
        post({ t: 'error', message: errMsg(err), fatal: false, seq: m.seq })
      }
      pool.flushRetired() // nenhuma ImageBitmap substituída está em uso entre quadros
    }
  } finally {
    busy = false
  }
}

async function renderFrame(m: FrameMsg): Promise<void> {
  const t0 = performance.now()
  const p = project
  if (!compositor || !p || !canvas) throw new Error('render antes de init/project')
  const { missing, used } = await composeAt(p, m.tUs, m.playing)
  // buffers de reprodução só para o que está no quadro (e o que vai começar) e só durante a reprodução
  if (m.playing) pool.releaseExcept([...used, ...prefetchUpcoming(p, m.tUs, used)])
  else {
    prefetched.clear()
    pool.releaseAll()
  }
  post({ t: 'rendered', seq: m.seq, tUs: m.tUs, ms: performance.now() - t0, missing: [...missing] })
}

/**
 * Desenha o quadro tUs no canvas (resolveFrame → fontes → compositor). Os VideoFrames obtidos são fechados
 * antes de retornar; o desenho fica no canvas (preserveDrawingBuffer). `sequential`: reprodução/exportação
 * (iterador por entrada do pool); senão, seek. Devolve os assets ausentes e as entradas [asset, slot] usadas.
 */
async function composeAt(p: Project, tUs: Us, sequential: boolean, timing?: { drawMs: number }): Promise<{ missing: Set<string>; missingAnnotations: Set<string>; used: [string, number][] }> {
  const comp = compositor
  if (!comp || !canvas) throw new Error('render antes de init')
  const W = canvas.width
  const H = canvas.height
  const layers = resolveFrame(p, tUs)
  const sources = new Map<string, TexImageSource | VideoFrame | null>()
  const meta = new Map<string, SourceMeta>()
  const missing = new Set<string>()
  const missingAnnotations = new Set<string>()
  const frames: VideoFrame[] = []
  // mesmo asset em mais de uma camada no quadro: cada uma com seu slot (iterador próprio)
  const slots = new Map<string, number>()
  const used: [string, number][] = []

  try {
    // allSettled + try/catch por camada: nenhuma camada aborta a coleta das outras, e todo quadro
    // obtido entra em `frames` antes do finally (sem vazamento quando uma camada falha).
    await Promise.allSettled(
      layers.map(async (layer) => {
        if (layer.kind === 'annotations') {
          await loadSession(layer.sessionId)
          if (!sessions.get(layer.sessionId)?.session) missingAnnotations.add(layer.sessionId)
          return
        }
        if (layer.kind !== 'media') return
        const asset = p.assets.find((a) => a.id === layer.assetId)
        let src: TexImageSource | VideoFrame | null = null
        try {
          if (asset && asset.status !== 'missing') {
            if (layer.srcUs === null) {
              const bmp = await pool.image(asset.id)
              if (bmp) {
                src = bmp
                meta.set(layer.itemId, { w: bmp.width, h: bmp.height, rotation: 0 })
              }
            } else {
              const slot = slots.get(asset.id) ?? 0
              slots.set(asset.id, slot + 1)
              used.push([asset.id, slot])
              const sample = await pool.frameAt(asset.id, layer.srcUs, sequential, slot)
              if (sample) {
                try {
                  // O VideoFrame do decoder vem sem rotação (mediabunny guarda a do arquivo em sample.rotation)
                  const frame = sample.toVideoFrame()
                  frames.push(frame)
                  src = frame
                  meta.set(layer.itemId, { w: frame.displayWidth, h: frame.displayHeight, rotation: sample.rotation })
                } finally {
                  sample.close()
                }
              }
            }
          }
        } catch {
          src = null
        }
        if (!src) {
          missing.add(layer.assetId)
          meta.set(layer.itemId, asset?.video ? { w: asset.video.width, h: asset.video.height, rotation: asset.video.rotation } : { w: W, h: H, rotation: 0 })
        }
        sources.set(layer.itemId, src)
      })
    )
    const t0 = timing ? performance.now() : 0
    comp.draw(layers, sources, p.canvas.background, { meta, annotations: drawAnnotations, selectionOutline: selection.map((itemId) => ({ itemId })) })
    if (timing) {
      comp.finish()
      timing.drawMs = performance.now() - t0
    }
  } finally {
    for (const f of frames) f.close()
  }
  return { missing, missingAnnotations, used }
}

/** Teste de desempenho: quadros sequenciais (como na reprodução), com o tempo do compositor medido com sync da GPU. */
async function bench(m: Extract<RenderIn, { t: 'testBench' }>): Promise<void> {
  const drawMs: number[] = []
  const frameMs: number[] = []
  try {
    const p = project
    if (!p) throw new Error('bench antes de project')
    for (let n = 0; n < m.frames; n++) {
      const t0 = performance.now()
      const timing = { drawMs: 0 }
      await composeAt(p, m.tUs + frameToUs(n, m.fps), true, timing)
      frameMs.push(performance.now() - t0)
      drawMs.push(timing.drawMs)
    }
    pool.releaseAll()
    post({ t: 'bench', id: m.id, drawMs, frameMs })
  } catch (err) {
    post({ t: 'bench', id: m.id, drawMs, frameMs, error: errMsg(err) })
  }
}

/**
 * Reprodução: aquece o decoder dos itens que começam em até PREFETCH_US (uma vez por item), no slot e
 * na posição da fonte do quadro em que começam. Devolve as entradas a manter fora do releaseExcept.
 * Não mexe numa entrada em uso no quadro atual (reposicionar o iterador quebraria a reprodução dela).
 */
function prefetchUpcoming(p: Project, tUs: number, used: [string, number][]): [string, number][] {
  const busyKeys = new Set(used.map(([a, s]) => `${a}#${s}`))
  const keep: [string, number][] = []
  for (const track of p.tracks) {
    if (track.hidden) continue
    for (const item of track.items) {
      if (item.type !== 'media' || item.enabled === false || item.startUs <= tUs || item.startUs > tUs + PREFETCH_US) continue
      // slots como em renderFrame: ordem das camadas de vídeo com asset disponível
      const slots = new Map<string, number>()
      for (const layer of resolveFrame(p, item.startUs)) {
        if (layer.kind !== 'media' || layer.srcUs === null) continue
        const asset = p.assets.find((a) => a.id === layer.assetId)
        if (!asset || asset.status === 'missing') continue
        const slot = slots.get(asset.id) ?? 0
        slots.set(asset.id, slot + 1)
        if (layer.itemId !== item.id) continue
        if (busyKeys.has(`${asset.id}#${slot}`)) break
        keep.push([asset.id, slot])
        if (!prefetched.has(item.id)) {
          prefetched.add(item.id)
          pool.prefetch(asset.id, layer.srcUs, slot)
        }
        break
      }
    }
  }
  return keep
}

function loadSession(sessionId: string): Promise<void> {
  const cur = sessions.get(sessionId)
  if (cur && (cur.failedAt === null || Date.now() - cur.failedAt < SESSION_RETRY_MS)) return cur.load
  const entry: { load: Promise<void>; session: Session | null; failedAt: number | null } = { load: Promise.resolve(), session: null, failedAt: null }
  entry.load = fetch(`${FILE_PROTOCOL}://${encodeURIComponent(sessionId)}/session.json`)
    .then((r) => (r.ok ? (r.json() as Promise<Session>) : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((s) => {
      entry.session = s
    })
    .catch(() => {
      entry.failedAt = Date.now()
    })
  sessions.set(sessionId, entry)
  return entry.load
}

function drawAnnotations(layer: AnnotationsLayer): OffscreenCanvas | null {
  const session = sessions.get(layer.sessionId)?.session
  if (!session || !canvas || session.strokes.length === 0) return null
  const W = canvas.width
  const H = canvas.height
  if (!annCanvas || annCanvas.width !== W || annCanvas.height !== H) annCanvas = new OffscreenCanvas(W, H)
  const ctx = annCanvas.getContext('2d')
  if (!ctx) return null
  ctx.clearRect(0, 0, W, H)
  drawStrokes(ctx, W, H, session, layer.sessionMs, layer.autoFadeMs)
  return annCanvas
}

// ---------------------------------------------------------------- exportação

// Chunks do StreamTarget (agrupados) e quantos podem estar em voo antes de esperar o ack do cliente.
const EXPORT_CHUNK_BYTES = 2 * 1024 * 1024
const EXPORT_MAX_INFLIGHT = 4
// Áudio: blocos de 100 ms; até AUDIO_AHEAD pedidos adiantados; o áudio anda AUDIO_LEAD_US à frente do vídeo.
const AUDIO_BLOCK_FRAMES = SR / 10
const AUDIO_BLOCK_US = 100_000
const AUDIO_AHEAD = 4
const AUDIO_LEAD_US = 200_000
const AUDIO_CHANNELS = 2
// taxas de AAC tentadas abaixo da pedida antes de cair para Opus
const AAC_FALLBACK_BPS = [256_000, 192_000, 160_000, 128_000]

// quadros RGBA em voo (GIF: o renderer espera cada pipeWrite antes do ack)
const FRAMES_MAX_INFLIGHT = 2

let exporting: { jobId: string; abort: AbortController; outbox: { ack(seq: number): void } } | null = null

class Cancelled extends Error {
  constructor() {
    super('cancelado')
    this.name = 'Cancelled'
  }
}

/** Falha do codificador (start/add/finalize do Output): só ela justifica tentar outro modo de hardware. */
class EncoderError extends Error {
  constructor(cause: unknown) {
    super(errMsg(cause))
    this.name = 'EncoderError'
  }
}

/** Chamada ao encoder: falha vira EncoderError (cancelamento continua Cancelled). */
async function encoderCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw e instanceof Cancelled || e instanceof EncoderError ? e : new EncoderError(e)
  }
}

// Bloco de áudio que não chega nesse tempo: o audio worker morreu ou travou → erro claro (sem pendurar).
const AUDIO_BLOCK_TIMEOUT_MS = 20_000

/** Janela de contrapressão: numera o que sai e, com mais de `max` sem ack do cliente, espera. */
class AckWindow {
  private seq = 0
  private acked = 0
  private waiter: (() => void) | null = null

  constructor(private readonly max: number, private readonly signal: AbortSignal) {
    signal.addEventListener('abort', () => this.release())
  }

  get lastSeq(): number {
    return this.seq
  }

  next(): number {
    return ++this.seq
  }

  ack(seq: number): void {
    this.acked = Math.max(this.acked, seq)
    if (this.seq - this.acked <= this.max) this.release()
  }

  private release(): void {
    const w = this.waiter
    this.waiter = null
    w?.()
  }

  /** Depois de enviar: espera enquanto houver mais de `max` em voo (cancelado → Cancelled). */
  async wait(): Promise<void> {
    if (this.signal.aborted) throw new Cancelled()
    if (this.seq - this.acked > this.max) {
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
      if (this.signal.aborted) throw new Cancelled()
    }
  }
}

/** Fila de chunks do MP4 com contrapressão: com muitos em voo, espera o ack do cliente (gravou no disco). */
class ChunkOutbox {
  private readonly win: AckWindow

  constructor(private readonly jobId: string, private readonly signal: AbortSignal) {
    this.win = new AckWindow(EXPORT_MAX_INFLIGHT, signal)
  }

  get lastSeq(): number {
    return this.win.lastSeq
  }

  ack(seq: number): void {
    this.win.ack(seq)
  }

  async send(chunk: StreamTargetChunk): Promise<void> {
    if (this.signal.aborted) throw new Cancelled()
    const data = chunk.data.slice()
    post({ t: 'exportChunk', jobId: this.jobId, seq: this.win.next(), data, position: chunk.position }, [data.buffer])
    await this.win.wait()
  }
}

/** Blocos de áudio mixado pedidos em ordem ao audio worker de exportação (memória constante). */
class AudioFeed {
  private readonly totalFrames: number
  private readonly blocks: number
  private next = 0
  private readonly pending = new Map<number, Promise<Float32Array>>()
  private readonly waiting = new Map<number, { resolve: (pcm: Float32Array) => void; reject: (e: Error) => void }>()

  constructor(private readonly port: MessagePort, private readonly fromUs: Us, durationUs: Us, signal: AbortSignal) {
    this.totalFrames = Math.round((durationUs * SR) / 1e6)
    this.blocks = Math.ceil(this.totalFrames / AUDIO_BLOCK_FRAMES)
    port.onmessage = (e: MessageEvent<AudioOut>) => {
      const m = e.data
      if (m.t === 'speechError' || m.seq === undefined) return // aviso de mídia/fala (o bloco sai com silêncio no lugar dela)
      const w = this.waiting.get(m.seq)
      this.waiting.delete(m.seq)
      if (m.t === 'block') w?.resolve(m.pcm)
      else w?.reject(new Error(`falha ao mixar o áudio: ${m.message}`))
    }
    signal.addEventListener('abort', () => {
      for (const w of this.waiting.values()) w.reject(new Cancelled())
      this.waiting.clear()
    })
  }

  /** Adiciona ao encoder os blocos que começam antes de `untilRelUs` (tempo do arquivo, 0 = início). */
  async feed(src: AudioSampleSource, untilRelUs: number): Promise<void> {
    while (this.next < this.blocks && this.next * AUDIO_BLOCK_US < untilRelUs) {
      for (let k = this.next; k < Math.min(this.blocks, this.next + AUDIO_AHEAD); k++) if (!this.pending.has(k)) this.request(k)
      const k = this.next
      const pcm = await withTimeout(this.pending.get(k)!, AUDIO_BLOCK_TIMEOUT_MS, 'O áudio parou de responder durante a exportação (mixagem do bloco em ' + ((k * AUDIO_BLOCK_US) / 1e6).toFixed(1) + ' s).')
      this.pending.delete(k)
      const sample = new AudioSample({ data: pcm, format: 'f32', numberOfChannels: AUDIO_CHANNELS, sampleRate: SR, timestamp: (k * AUDIO_BLOCK_FRAMES) / SR })
      try {
        await src.add(sample)
      } finally {
        sample.close()
      }
      this.next++
    }
  }

  close(): void {
    this.port.onmessage = null
    this.port.close()
  }

  private request(k: number): void {
    const frames = Math.min(AUDIO_BLOCK_FRAMES, this.totalFrames - k * AUDIO_BLOCK_FRAMES)
    const p = new Promise<Float32Array>((resolve, reject) => this.waiting.set(k, { resolve, reject }))
    p.catch(() => {}) // tratado em feed (ou abandonado no cancelamento)
    this.pending.set(k, p)
    this.port.postMessage({ t: 'render', fromUs: this.fromUs + k * AUDIO_BLOCK_US, frames, seq: k } satisfies AudioIn)
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([p, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]).finally(() => clearTimeout(timer))
}

function startExport(job: ExportJobSpec, audioPort: MessagePort | null): void {
  if (exporting) {
    post({ t: 'exportError', jobId: job.jobId, message: 'Já existe uma exportação em andamento neste worker', cancelled: false, beforeFirstPacket: false, encoderError: false })
    return
  }
  const abort = new AbortController()
  const outbox = new ChunkOutbox(job.jobId, abort.signal)
  const me = { jobId: job.jobId, abort, outbox }
  exporting = me
  const state = { packets: 0 }
  runExport(job, audioPort, abort.signal, outbox, state)
    .then((done) => post({ t: 'exportDone', jobId: job.jobId, lastSeq: outbox.lastSeq, ...done }))
    .catch((err: unknown) => {
      const cancelled = abort.signal.aborted || err instanceof Cancelled
      post({ t: 'exportError', jobId: job.jobId, message: cancelled ? 'cancelado' : errMsg(err), cancelled, beforeFirstPacket: !cancelled && state.packets === 0, encoderError: err instanceof EncoderError })
    })
    .finally(() => {
      if (exporting === me) exporting = null
      prefetched.clear()
      pool.releaseAll()
    })
}

async function runExport(
  job: ExportJobSpec,
  audioPort: MessagePort | null,
  signal: AbortSignal,
  outbox: ChunkOutbox,
  state: { packets: number }
): Promise<{ videoCodec: string; audioCodec: 'aac' | 'opus' | null; audioBitrate: number; hardware: ExportJobSpec['video']['hw']; missing: { assetId: string; frames: number }[]; missingAnnotations: string[] }> {
  const p = project
  if (!compositor || !canvas || !p) throw new Error('exportação antes de init/project')
  compositor.resize(job.width, job.height)
  selection = []
  prefetched.clear()
  const durationUs = job.toUs - job.fromUs
  const total = frameCount(job.fromUs, job.toUs, job.fps)
  if (total <= 0) throw new Error('Intervalo de exportação vazio')

  let audioCodec: 'aac' | 'opus' | null = null
  let audioBitrate = job.audio?.bitrate ?? 0
  if (job.audio && audioPort) {
    const opts = (bitrate: number): Parameters<typeof canEncodeAudio>[1] => ({ numberOfChannels: AUDIO_CHANNELS, sampleRate: SR, quality: new Quality({ bitrate }) })
    // AAC primeiro, na taxa pedida ou na maior aceita abaixo dela (o AAC do Windows não aceita 320 kbps); Opus só sem AAC
    const aacRate = [job.audio.bitrate, ...AAC_FALLBACK_BPS.filter((b) => b < job.audio!.bitrate)]
    for (const b of aacRate) {
      if (await canEncodeAudio('aac', opts(b))) {
        audioCodec = 'aac'
        audioBitrate = b
        break
      }
    }
    if (!audioCodec && (await canEncodeAudio('opus', opts(job.audio.bitrate)))) audioCodec = 'opus'
    if (!audioCodec) throw new Error('Nenhum codificador de áudio disponível (AAC ou Opus)')
  }

  const hevc = job.video.codec === 'hevc'
  const videoCodec = hevc ? hevcCodecString(job.width, job.height, job.fps) : h264LevelFor(job.width, job.height, job.fps)
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(new WritableStream<StreamTargetChunk>({ write: (chunk) => outbox.send(chunk) }), { chunked: true, chunkSize: EXPORT_CHUNK_BYTES })
  })
  const video = new VideoSampleSource({
    codec: job.video.codec,
    fullCodecString: videoCodec,
    quality: new Quality({ bitrate: job.video.bitrate }),
    keyFrameInterval: job.video.keyFrameIntervalS,
    latencyMode: 'quality',
    hardwareAcceleration: job.video.hw,
    onEncodedPacket: () => {
      state.packets++
    }
  })
  output.addVideoTrack(video, { frameRate: job.fps })
  const audio = audioCodec ? new AudioSampleSource({ codec: audioCodec, quality: new Quality({ bitrate: audioBitrate }) }) : null
  if (audio) output.addAudioTrack(audio)
  const feed = audio && audioPort ? new AudioFeed(audioPort, job.fromUs, durationUs, signal) : null

  try {
    await encoderCall(() => output.start())
    if (job.simulateHevcFailure && hevc) throw new EncoderError('falha simulada do encoder HEVC')
    if (job.simulateHwFailure && job.video.hw === 'prefer-hardware') throw new EncoderError('falha simulada do encoder de hardware')
    if (job.simulateSoftwareFailure && job.video.hw === 'prefer-software') throw new EncoderError('falha simulada do encoder em software')
    const frameDur = 1 / job.fps
    let lastReport = 0
    // fontes que falharam (arquivo ausente, decoder que quebrou no meio…): o quadro sai com o placeholder,
    // e a contagem vira aviso no fim — nunca uma exportação "ok" silenciosa
    const missingFrames = new Map<string, number>()
    const missingAnnotations = new Set<string>()
    for (let n = 0; n < total; n++) {
      if (signal.aborted) throw new Cancelled()
      const relUs = frameToUs(n, job.fps)
      const tUs = job.fromUs + relUs
      if (feed) await feed.feed(audio!, relUs + AUDIO_LEAD_US)
      const composed = await composeAt(p, tUs, true)
      const { used } = composed
      for (const id of composed.missing) missingFrames.set(id, (missingFrames.get(id) ?? 0) + 1)
      for (const s of composed.missingAnnotations) missingAnnotations.add(s)
      // VideoSample(canvas) copia o quadro já desenhado (mesma task do draw: nada o altera no meio)
      const sample = new VideoSample(canvas, { timestamp: relUs / 1e6, duration: frameDur })
      try {
        await encoderCall(() => video.add(sample, n === 0 ? { keyFrame: true } : undefined))
      } finally {
        sample.close()
      }
      pool.releaseExcept([...used, ...prefetchUpcoming(p, tUs, used)])
      const now = performance.now()
      if (n === total - 1 || now - lastReport > 200) {
        lastReport = now
        post({ t: 'exportProgress', jobId: job.jobId, frame: n + 1, total })
      }
    }
    if (feed) await feed.feed(audio!, Infinity)
    if (signal.aborted) throw new Cancelled()
    await encoderCall(() => output.finalize())
    return { videoCodec, audioCodec, audioBitrate: audioCodec ? audioBitrate : 0, hardware: job.video.hw, missing: [...missingFrames].map(([assetId, frames]) => ({ assetId, frames })), missingAnnotations: [...missingAnnotations] }
  } catch (err) {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {})
    throw err
  } finally {
    feed?.close()
  }
}

function startFrames(job: FramesJobSpec): void {
  if (exporting) {
    post({ t: 'exportError', jobId: job.jobId, message: 'Já existe uma exportação em andamento neste worker', cancelled: false, beforeFirstPacket: false, encoderError: false })
    return
  }
  const abort = new AbortController()
  const win = new AckWindow(FRAMES_MAX_INFLIGHT, abort.signal)
  const me = { jobId: job.jobId, abort, outbox: win }
  exporting = me
  runFrames(job, abort.signal, win)
    .then((done) => post({ t: 'exportFramesDone', jobId: job.jobId, ...done }))
    .catch((err: unknown) => {
      const cancelled = abort.signal.aborted || err instanceof Cancelled
      post({ t: 'exportError', jobId: job.jobId, message: cancelled ? 'cancelado' : errMsg(err), cancelled, beforeFirstPacket: false, encoderError: false })
    })
    .finally(() => {
      if (exporting === me) exporting = null
      prefetched.clear()
      pool.releaseAll()
    })
}

/** Laço de quadros da exportação (o mesmo do vídeo), com cada quadro lido do canvas e enviado em RGBA. */
async function runFrames(job: FramesJobSpec, signal: AbortSignal, win: AckWindow): Promise<{ frames: number; missing: { assetId: string; frames: number }[]; missingAnnotations: string[] }> {
  const p = project
  const comp = compositor
  if (!comp || !canvas || !p) throw new Error('exportação antes de init/project')
  comp.resize(job.width, job.height)
  selection = []
  prefetched.clear()
  const total = frameCount(job.fromUs, job.toUs, job.fps)
  if (total <= 0) throw new Error('Intervalo de exportação vazio')
  const missingFrames = new Map<string, number>()
  const missingAnnotations = new Set<string>()
  for (let n = 0; n < total; n++) {
    if (signal.aborted) throw new Cancelled()
    const tUs = job.fromUs + frameToUs(n, job.fps)
    const composed = await composeAt(p, tUs, true)
    for (const id of composed.missing) missingFrames.set(id, (missingFrames.get(id) ?? 0) + 1)
    for (const id of composed.missingAnnotations) missingAnnotations.add(id)
    // RGBA de cima para baixo (o readPixels do compositor já desvira o framebuffer)
    const px = comp.readPixels(0, 0, job.width, job.height)
    post({ t: 'exportFrame', jobId: job.jobId, seq: win.next(), total, rgba: px.buffer as ArrayBuffer, w: job.width, h: job.height }, [px.buffer])
    pool.releaseExcept([...composed.used, ...prefetchUpcoming(p, tUs, composed.used)])
    await win.wait()
  }
  return { frames: total, missing: [...missingFrames].map(([assetId, frames]) => ({ assetId, frames })), missingAnnotations: [...missingAnnotations] }
}

/** Quadro único (PNG) no tamanho do canvas: composeAt (seek) → convertToBlob. */
async function exportStill(id: number, tUs: Us): Promise<void> {
  let missing: string[] = []
  let missingAnnotations: string[] = []
  try {
    const p = project
    if (!compositor || !canvas || !p) throw new Error('quadro antes de init/project')
    selection = []
    const composed = await composeAt(p, tUs, false)
    missing = [...composed.missing]
    missingAnnotations = [...composed.missingAnnotations]
    // preserveDrawingBuffer: o desenho continua no canvas até o blob ficar pronto (nada mais desenha nesta instância)
    const png = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()
    post({ t: 'still', id, png, missing, missingAnnotations }, [png])
  } catch (err) {
    post({ t: 'still', id, png: null, error: errMsg(err), missing, missingAnnotations })
  } finally {
    pool.releaseAll()
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
