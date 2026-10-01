// Teste 4: suporte de encoders (WebCodecs) e codificação MP4 com mediabunny:
// VideoSampleSource (H.264 HW/SW, HEVC) + AudioSampleSource (AAC), e um caso ponta a ponta
// (decodifica → WebGL2 com blur/pixelate → VideoSample(canvas) → H.264 HW + AAC).
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  Input,
  Mp4OutputFormat,
  Output,
  UrlSource,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
  canEncodeAudio,
  canEncodeVideo,
  type VideoCodec
} from 'mediabunny'
import { GlPipeline, stats } from './glPipeline'

type Cmd = { cmd: 'support' } | { cmd: 'raw' } | { cmd: 'encode'; name: string; codec: VideoCodec; hw: 'prefer-hardware' | 'prefer-software' | 'no-preference'; seconds: number; e2eUrl?: string }

self.addEventListener('message', (e: MessageEvent<Cmd>) => {
  const m = e.data
  const job = m.cmd === 'support' ? support() : m.cmd === 'raw' ? rawEncode() : encode(m)
  job.then(
    (r) => self.postMessage({ ok: true, result: r }, { transfer: r && typeof r === 'object' && 'file' in r && r.file instanceof ArrayBuffer ? [r.file] : [] }),
    (err: unknown) => self.postMessage({ ok: false, error: String(err instanceof Error ? (err.stack ?? err.message) : err) })
  )
})

const errStr = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))

async function support(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const W = 1920
  const H = 1080
  const video: Record<string, string> = {
    'avc1.640028 (H.264 High 4.0)': 'avc1.640028',
    'avc1.4d0028 (H.264 Main 4.0)': 'avc1.4d0028',
    'avc1.640033 (H.264 High 5.1, 4K)': 'avc1.640033',
    'hvc1.1.6.L123.B0 (HEVC Main)': 'hvc1.1.6.L123.B0',
    'hev1.1.6.L120.90': 'hev1.1.6.L120.90',
    'vp09.00.40.08 (VP9)': 'vp09.00.40.08',
    'av01.0.08M.08 (AV1)': 'av01.0.08M.08'
  }
  for (const [label, codec] of Object.entries(video)) {
    const big = codec === 'avc1.640033'
    for (const hw of ['prefer-hardware', 'prefer-software'] as const) {
      try {
        const s = await VideoEncoder.isConfigSupported({ codec, width: big ? 3840 : W, height: big ? 2160 : H, bitrate: 8e6, framerate: 30, hardwareAcceleration: hw, avc: codec.startsWith('avc') ? { format: 'avc' } : undefined })
        out[`VideoEncoder ${label} ${hw}`] = s.supported
      } catch (e) {
        out[`VideoEncoder ${label} ${hw}`] = errStr(e)
      }
    }
  }
  const audio: [string, AudioEncoderConfig][] = [
    ['mp4a.40.2 AAC-LC 48k stereo 128k', { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 }],
    ['mp4a.40.2 AAC-LC 44.1k stereo', { codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2, bitrate: 128000 }],
    ['mp4a.40.5 HE-AAC', { codec: 'mp4a.40.5', sampleRate: 48000, numberOfChannels: 2, bitrate: 64000 }],
    ['opus 48k stereo', { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 }],
    ['flac', { codec: 'flac', sampleRate: 48000, numberOfChannels: 2 }]
  ]
  for (const [label, cfg] of audio) {
    try {
      out[`AudioEncoder ${label}`] = (await AudioEncoder.isConfigSupported(cfg)).supported
    } catch (e) {
      out[`AudioEncoder ${label}`] = errStr(e)
    }
  }
  // helpers do mediabunny
  for (const c of ['avc', 'hevc', 'vp9', 'av1'] as const) out[`mediabunny canEncodeVideo(${c}) 1080p`] = await canEncodeVideo(c, { width: W, height: H }).catch(errStr)
  for (const c of ['aac', 'opus'] as const) out[`mediabunny canEncodeAudio(${c}) 48k/2ch`] = await canEncodeAudio(c, { sampleRate: 48000, numberOfChannels: 2 }).catch(errStr)
  return out
}

/** Cena sintética 2D: barras + texto + retângulo animado (força movimento real para o encoder). */
function drawSynthetic(ctx: OffscreenCanvasRenderingContext2D, i: number, w: number, h: number): void {
  const colors = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0']
  colors.forEach((c, k) => {
    ctx.fillStyle = c
    ctx.fillRect((k * w) / 7, 0, w / 7, h)
  })
  ctx.fillStyle = '#111'
  ctx.fillRect(((i * 12) % (w + 300)) - 300, h / 2 - 150, 300, 300)
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 96px sans-serif'
  ctx.fillText(`frame ${i}`, 60, h - 80)
}

async function encode(m: Extract<Cmd, { cmd: 'encode' }>): Promise<Record<string, unknown>> {
  const W = 1920
  const H = 1080
  const FPS = 30
  const total = Math.round(m.seconds * FPS)
  const SR = 48000
  const out: Record<string, unknown> = { name: m.name, codec: m.codec, hw: m.hw, e2e: !!m.e2eUrl }
  let encoderConfig: VideoEncoderConfig | null = null
  let audioEncoderConfig: AudioEncoderConfig | null = null
  let videoPackets = 0
  let audioPackets = 0

  const target = new BufferTarget()
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target })
  const vsrc = new VideoSampleSource({
    codec: m.codec,
    bitrate: 8e6,
    keyFrameInterval: 2,
    latencyMode: 'quality',
    hardwareAcceleration: m.hw,
    onEncoderConfig: (c) => (encoderConfig = c),
    onEncodedPacket: () => videoPackets++
  })
  const asrc = new AudioSampleSource({
    codec: 'aac',
    bitrate: 128e3,
    onEncoderConfig: (c) => (audioEncoderConfig = c),
    onEncodedPacket: () => audioPackets++
  })
  output.addVideoTrack(vsrc, { frameRate: FPS })
  output.addAudioTrack(asrc)
  await output.start()

  // fonte de quadros: 2D sintético ou pipeline ponta a ponta (decode + WebGL2)
  let ctx2d: OffscreenCanvasRenderingContext2D | null = null
  let canvas: OffscreenCanvas
  let pipe: GlPipeline | null = null
  let input: Input | null = null
  let it: AsyncGenerator<VideoSample, void, unknown> | null = null
  if (m.e2eUrl) {
    canvas = new OffscreenCanvas(W, H)
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: false })
    if (!gl) throw new Error('webgl2 indisponível')
    pipe = new GlPipeline(gl, W, H)
    input = new Input({ source: new UrlSource(m.e2eUrl), formats: ALL_FORMATS })
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('sem vídeo')
    it = new VideoSampleSink(track).samples(0, m.seconds)
  } else {
    canvas = new OffscreenCanvas(W, H)
    ctx2d = canvas.getContext('2d', { alpha: false })
  }

  // áudio: senoide 440 Hz estéreo em blocos de 1024 frames, intercalada com o vídeo
  const BLOCK = 1024
  let audioFrames = 0
  const audioTotal = Math.round(m.seconds * SR)
  const pushAudioUntil = async (tSec: number): Promise<void> => {
    while (audioFrames < audioTotal && audioFrames / SR < tSec) {
      const n = Math.min(BLOCK, audioTotal - audioFrames)
      const data = new Float32Array(n * 2)
      for (let k = 0; k < n; k++) {
        const v = 0.3 * Math.sin((2 * Math.PI * 440 * (audioFrames + k)) / SR)
        data[k] = v
        data[n + k] = v
      }
      const s = new AudioSample({ data, format: 'f32-planar', numberOfChannels: 2, sampleRate: SR, timestamp: audioFrames / SR })
      await asrc.add(s)
      s.close()
      audioFrames += n
    }
  }

  const frameMs: number[] = []
  const addMs: number[] = []
  const t0 = performance.now()
  for (let i = 0; i < total; i++) {
    const tf = performance.now()
    if (pipe && it) {
      const r = await it.next()
      if (r.done) break
      const f = r.value.toVideoFrame()
      pipe.upload(f)
      f.close()
      r.value.close()
      pipe.effects({ blurDownsample: 2, blurRadius: 24, blurSigma: 10, pixelCell: 24 }, null)
    } else if (ctx2d) {
      drawSynthetic(ctx2d, i, W, H)
    }
    const sample = new VideoSample(canvas, { timestamp: i / FPS, duration: 1 / FPS })
    const ta = performance.now()
    await vsrc.add(sample)
    addMs.push(performance.now() - ta)
    sample.close()
    await pushAudioUntil((i + 1) / FPS)
    frameMs.push(performance.now() - tf)
  }
  await pushAudioUntil(m.seconds)
  const tLoop = performance.now() - t0
  vsrc.close()
  asrc.close()
  await output.finalize()
  const tAll = performance.now() - t0
  if (it) await it.return()
  input?.dispose()

  const buf = target.buffer!
  out.frames = frameMs.length
  out.loopMs = Math.round(tLoop)
  out.totalMsWithFinalize = Math.round(tAll)
  out.fps = +((frameMs.length / tAll) * 1000).toFixed(1)
  out.realtimeFactor = +((frameMs.length / FPS / tAll) * 1000).toFixed(2)
  out.frameMs = stats(frameMs)
  out.addMs = stats(addMs)
  out.videoPackets = videoPackets
  out.audioPackets = audioPackets
  out.audioSeconds = +(audioFrames / SR).toFixed(3)
  out.encoderConfig = encoderConfig
  out.audioEncoderConfig = audioEncoderConfig
  out.bytes = buf.byteLength
  out.file = buf
  return out
}

/** Vazão do VideoEncoder cru (sem canvas/mediabunny): mesmo quadro NV12 1080p, 300 vezes. */
async function rawEncode(): Promise<Record<string, unknown>> {
  const W = 1920
  const H = 1080
  const c = new OffscreenCanvas(W, H)
  drawSynthetic(c.getContext('2d')!, 0, W, H)
  const base = new VideoFrame(c, { timestamp: 0 })
  const out: Record<string, unknown> = {}
  for (const [codec, hw] of [
    ['avc1.640028', 'prefer-hardware'],
    ['avc1.640028', 'prefer-software'],
    ['hvc1.1.6.L123.B0', 'prefer-hardware']
  ] as const) {
    let chunks = 0
    let error = ''
    const enc = new VideoEncoder({ output: () => chunks++, error: (e) => (error = errStr(e)) })
    try {
      enc.configure({ codec, width: W, height: H, bitrate: 8e6, framerate: 30, hardwareAcceleration: hw, latencyMode: 'quality', ...(codec.startsWith('avc') ? { avc: { format: 'avc' as const } } : {}) })
      const t0 = performance.now()
      for (let i = 0; i < 300; i++) {
        const f = new VideoFrame(base, { timestamp: Math.round((i * 1e6) / 30) })
        while (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0))
        enc.encode(f, { keyFrame: i % 60 === 0 })
        f.close()
      }
      await enc.flush()
      const ms = performance.now() - t0
      out[`${codec} ${hw}`] = { fps: +((300 / ms) * 1000).toFixed(1), chunks, error: error || undefined }
    } catch (e) {
      out[`${codec} ${hw}`] = { error: error || errStr(e) }
    } finally {
      if (enc.state !== 'closed') enc.close()
    }
  }
  base.close()
  return out
}
