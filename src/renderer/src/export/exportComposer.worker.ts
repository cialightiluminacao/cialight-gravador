// Web Worker do compositor de exportação: lê rec.mp4 (mediabunny/UrlSource), decodifica
// tela (v0) e webcam (v1), desenha cada frame CFR com drawFrame (mesmo compositor do
// player e da gravação) num OffscreenCanvas e codifica H.264 (~20 Mbps) num MP4
// fragmentado, cujos bytes são enviados ao cliente (que grava composed.mp4 via IPC).
import {
  ALL_FORMATS,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  UrlSource,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
  type InputVideoTrack,
  type StreamTargetChunk
} from 'mediabunny'
import { drawFrame } from '@shared/compositor'
import { h264LevelFor } from '@/engine/encoderSupport'
import { FrameCursor, composeProgress, frameTimestamp, planFrames, shouldReportProgress } from './composeMath'
import { COMPOSE_MAX_INFLIGHT_CHUNKS, type ComposeInbound, type ComposeOutbound, type ComposeStartMessage } from './composeProtocol'

export const COMPOSED_BITRATE = 20e6
export const COMPOSED_KEYFRAME_INTERVAL_SEC = 2

const post = (msg: ComposeOutbound, transfer: Transferable[] = []): void => {
  self.postMessage(msg, { transfer })
}

class Cancelled extends Error {
  constructor() {
    super('cancelado')
    this.name = 'Cancelled'
  }
}

/** Fila de chunks com contrapressão: espera ack do cliente quando há muitos em voo. */
class ChunkOutbox {
  private seq = 0
  private acked = 0
  private waiter: (() => void) | null = null

  constructor(private readonly signal: AbortSignal) {
    signal.addEventListener('abort', () => this.release())
  }

  get lastSeq(): number {
    return this.seq
  }

  ack(seq: number): void {
    this.acked = Math.max(this.acked, seq)
    if (this.seq - this.acked <= COMPOSE_MAX_INFLIGHT_CHUNKS) this.release()
  }

  private release(): void {
    const w = this.waiter
    this.waiter = null
    w?.()
  }

  async send(chunk: StreamTargetChunk): Promise<void> {
    if (this.signal.aborted) throw new Cancelled()
    const data = chunk.data.slice()
    this.seq++
    post({ type: 'chunk', seq: this.seq, data, position: chunk.position }, [data.buffer])
    if (this.seq - this.acked > COMPOSE_MAX_INFLIGHT_CHUNKS) {
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
      if (this.signal.aborted) throw new Cancelled()
    }
  }
}

async function decodableTrack(track: InputVideoTrack | undefined, label: string): Promise<InputVideoTrack> {
  if (!track) throw new Error(`rec.mp4 não tem a faixa de ${label}`)
  if (!(await track.canDecode())) throw new Error(`Este computador não consegue decodificar a faixa de ${label} (${track.codec ?? 'codec desconhecido'})`)
  return track
}

async function compose(msg: ComposeStartMessage, signal: AbortSignal, outbox: ChunkOutbox): Promise<void> {
  const input = new Input({ source: new UrlSource(msg.recUrl), formats: ALL_FORMATS })
  const cursors: FrameCursor<VideoSample>[] = []
  let output: Output | null = null
  try {
    const tracks = await input.getVideoTracks()
    const screenTrack = await decodableTrack(tracks[0], 'tela')
    const camTrack = msg.includeWebcam ? await decodableTrack(tracks[1], 'webcam') : null
    const plan = planFrames(msg.trimStartMs, msg.trimEndMs, msg.fps)

    const screenCursor = new FrameCursor(new VideoSampleSink(screenTrack).samples(plan.startSec, plan.endSec))
    cursors.push(screenCursor)
    const camCursor = camTrack ? new FrameCursor(new VideoSampleSink(camTrack).samples(plan.startSec, plan.endSec)) : null
    if (camCursor) cursors.push(camCursor)

    const canvas = new OffscreenCanvas(msg.width, msg.height)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('OffscreenCanvas 2D indisponível')

    output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }),
      target: new StreamTarget(new WritableStream<StreamTargetChunk>({ write: (chunk) => outbox.send(chunk) }))
    })
    const source = new VideoSampleSource({
      codec: 'avc',
      fullCodecString: h264LevelFor(msg.width, msg.height, plan.fps),
      bitrate: COMPOSED_BITRATE,
      keyFrameInterval: COMPOSED_KEYFRAME_INTERVAL_SEC,
      latencyMode: 'quality',
      hardwareAcceleration: 'no-preference'
    })
    output.addVideoTrack(source, { frameRate: plan.fps })
    await output.start()

    const drawOpts = {
      includeWebcam: msg.includeWebcam,
      includeAnnotations: msg.includeAnnotations,
      autoFadeMs: msg.autoFadeMs,
      pipOverride: msg.pipOverride
    }

    for (let i = 0; i < plan.frameCount; i++) {
      if (signal.aborted) throw new Cancelled()
      const t = frameTimestamp(plan, i)
      const screen = await screenCursor.advanceTo(t)
      const cam = camCursor ? await camCursor.advanceTo(t) : null

      if (screen) {
        drawFrame(
          ctx,
          msg.width,
          msg.height,
          { screen: screen.toCanvasImageSource(), cam: cam ? cam.toCanvasImageSource() : null, camMirrored: msg.session.camMirrored },
          msg.session,
          t * 1000,
          drawOpts
        )
      } else {
        // Antes do primeiro frame decodificável (raro): quadro preto.
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, msg.width, msg.height)
      }

      if (i === 0 && plan.leadingHold) {
        // Frame "segurado" em t=0 até o início do corte: mantém a linha do tempo igual à do bruto.
        const hold = new VideoSample(canvas, { timestamp: 0, duration: plan.startSec })
        await source.add(hold, { keyFrame: true })
        hold.close()
      }
      const sample = new VideoSample(canvas, { timestamp: t, duration: plan.frameDuration })
      await source.add(sample, i === 0 ? { keyFrame: true } : undefined)
      sample.close()

      if (shouldReportProgress(i, plan.frameCount)) {
        post({ type: 'progress', percent: composeProgress(i + 1, plan.frameCount), framesDone: i + 1, frameCount: plan.frameCount })
      }
    }

    for (const c of cursors) c.dispose()
    cursors.length = 0
    await output.finalize()
    post({ type: 'done', lastSeq: outbox.lastSeq })
  } catch (e) {
    for (const c of cursors) c.dispose()
    if (output && output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {})
    throw e
  } finally {
    input.dispose()
  }
}

let started = false
const abort = new AbortController()
let outbox: ChunkOutbox | null = null

self.addEventListener('message', (evt: MessageEvent<ComposeInbound>) => {
  const msg = evt.data
  if (msg.type === 'cancel') {
    abort.abort()
    return
  }
  if (msg.type === 'ack') {
    outbox?.ack(msg.seq)
    return
  }
  if (started) return
  started = true
  outbox = new ChunkOutbox(abort.signal)
  compose(msg, abort.signal, outbox).catch((e: unknown) => {
    if (abort.signal.aborted || e instanceof Cancelled) {
      post({ type: 'error', message: 'cancelado' })
      return
    }
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  })
})
