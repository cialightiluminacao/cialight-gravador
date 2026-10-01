// Testes 3 (decodificação: canDecode, seek aleatório, iteração sequencial, decoders
// simultâneos) e 7 (AudioSampleSink lendo PCM de MP3 e de AAC no MP4).
import { ALL_FORMATS, AudioSampleSink, Input, UrlSource, VideoSampleSink, type VideoSample } from 'mediabunny'
import { stats } from './glPipeline'

type Cmd = { cmd: 'decode'; files: string[]; base: string } | { cmd: 'concurrent'; url: string; max: number; hw: 'prefer-hardware' | 'no-preference' } | { cmd: 'audio'; files: string[]; base: string } | { cmd: 'image'; url: string }

self.addEventListener('message', (e: MessageEvent<Cmd>) => {
  const m = e.data
  const job = m.cmd === 'decode' ? decodeAll(m.files, m.base) : m.cmd === 'concurrent' ? concurrent(m.url, m.max, m.hw) : m.cmd === 'audio' ? audioAll(m.files, m.base) : image(m.url)
  job.then(
    (r) => self.postMessage({ ok: true, result: r }),
    (err: unknown) => self.postMessage({ ok: false, error: String(err instanceof Error ? (err.stack ?? err.message) : err) })
  )
})

const err = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))

// PRNG determinístico (mesmos timestamps em todas as execuções)
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

async function decodeOne(url: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
  try {
    out.format = (await input.getFormat()).name
    const track = await input.getPrimaryVideoTrack()
    if (!track) return { ...out, error: 'sem vídeo' }
    out.codec = track.codec
    out.size = `${track.codedWidth}x${track.codedHeight}`
    const cfg = await track.getDecoderConfig()
    out.codecString = cfg?.codec
    out.canDecode = await track.canDecode()
    if (cfg) {
      for (const hw of ['prefer-hardware', 'prefer-software'] as const) {
        try {
          const s = await VideoDecoder.isConfigSupported({ ...cfg, hardwareAcceleration: hw })
          out[`isConfigSupported_${hw}`] = s.supported
        } catch (e) {
          out[`isConfigSupported_${hw}`] = err(e)
        }
      }
    }
    const stats0 = await track.computePacketStats(300).catch(() => null)
    if (stats0) out.packetStats = { avgFps: +stats0.averagePacketRate.toFixed(2), avgBitrate: Math.round(stats0.averageBitrate) }
    if (!out.canDecode) return out
    const duration = await input.computeDuration()
    out.duration = +duration.toFixed(3)
    const sink = new VideoSampleSink(track)

    // primeiro frame (inclui criação do decoder)
    let t0 = performance.now()
    const first = await sink.getSample(0)
    out.firstFrameMs = +(performance.now() - t0).toFixed(1)
    out.firstFrameFormat = first ? `${first.format} ${first.displayWidth}x${first.displayHeight} ts=${first.timestamp}` : null
    first?.close()

    // iteração sequencial: 5 s
    t0 = performance.now()
    let n = 0
    for await (const s of sink.samples(0, 5)) {
      n++
      s.close()
    }
    const seqMs = performance.now() - t0
    out.sequential = { frames: n, ms: Math.round(seqMs), fps: +((n / seqMs) * 1000).toFixed(1) }

    // seek aleatório (getSample) em 20 timestamps
    const r = rng(42)
    const lat: number[] = []
    const ts: number[] = []
    let bad = 0
    for (let i = 0; i < 20; i++) {
      const t = +(r() * (duration - 0.2)).toFixed(3)
      t0 = performance.now()
      const s: VideoSample | null = await sink.getSample(t)
      lat.push(performance.now() - t0)
      ts.push(t)
      // deve devolver o frame com maior timestamp <= t
      if (!s || s.timestamp > t + 1e-6 || t - s.timestamp > 1 / 30 + 1e-3) bad++
      s?.close()
    }
    out.randomSeekMs = stats(lat)
    out.randomSeekWrongFrame = bad
    // samplesAtTimestamps (lote) nos mesmos tempos ordenados
    t0 = performance.now()
    let got = 0
    for await (const s of sink.samplesAtTimestamps([...ts].sort((a, b) => a - b))) {
      if (s) got++
      s?.close()
    }
    out.samplesAtTimestamps20Ms = Math.round(performance.now() - t0)
    out.samplesAtTimestampsGot = got
  } catch (e) {
    out.error = err(e)
  } finally {
    input.dispose()
  }
  return out
}

async function decodeAll(files: string[], base: string): Promise<Record<string, unknown>> {
  const res: Record<string, unknown> = {}
  for (const f of files) res[f] = await decodeOne(base + f)
  return res
}

/** N decoders (Inputs separados) decodificando ao mesmo tempo, N = 1..max. */
async function concurrent(url: string, max: number, hw: 'prefer-hardware' | 'no-preference'): Promise<unknown[]> {
  const rows: unknown[] = []
  for (let n = 1; n <= max; n++) {
    const inputs = Array.from({ length: n }, () => new Input({ source: new UrlSource(url), formats: ALL_FORMATS }))
    const t0 = performance.now()
    const results = await Promise.all(
      inputs.map(async (input, i) => {
        try {
          const track = await input.getPrimaryVideoTrack()
          if (!track) throw new Error('sem vídeo')
          const sink = new VideoSampleSink(track, { hardwareAcceleration: hw })
          let frames = 0
          // cada decoder começa num ponto diferente (como faixas diferentes da timeline)
          const start = (i * 2) % 8
          for await (const s of sink.samples(start, start + 2)) {
            frames++
            s.close()
          }
          return { frames }
        } catch (e) {
          return { frames: 0, error: err(e) }
        }
      })
    )
    const ms = performance.now() - t0
    const totalFrames = results.reduce((a, r) => a + r.frames, 0)
    const errors = results.filter((r) => 'error' in r && r.error).map((r) => (r as { error: string }).error)
    rows.push({ n, ms: Math.round(ms), totalFrames, aggregateFps: +((totalFrames / ms) * 1000).toFixed(1), perDecoderFps: +((totalFrames / n / ms) * 1000).toFixed(1), failures: errors.length, errors: [...new Set(errors)] })
    for (const i of inputs) i.dispose()
  }
  return rows
}

/** Frequência dominante por cruzamentos de zero (sinal senoidal). */
function zeroCrossHz(x: Float32Array, sr: number): number {
  let c = 0
  for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0 && x[i] >= 0) || (x[i - 1] >= 0 && x[i] < 0)) c++
  return (c / 2) * (sr / x.length)
}

async function audioOne(url: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
  try {
    out.format = (await input.getFormat()).name
    const track = await input.getPrimaryAudioTrack()
    if (!track) return { ...out, error: 'sem áudio' }
    out.codec = track.codec
    out.codecString = (await track.getDecoderConfig())?.codec
    out.sampleRate = track.sampleRate
    out.channels = track.numberOfChannels
    out.canDecode = await track.canDecode()
    if (!out.canDecode) return out
    const sink = new AudioSampleSink(track)
    const t0 = performance.now()
    let frames = 0
    let samples = 0
    let fmt = ''
    let firstTs = NaN
    let lastEnd = 0
    const mono: Float32Array[] = []
    for await (const s of sink.samples()) {
      if (Number.isNaN(firstTs)) firstTs = s.timestamp
      fmt = s.format
      samples++
      frames += s.numberOfFrames
      lastEnd = s.timestamp + s.duration
      const buf = new Float32Array(s.numberOfFrames)
      s.copyTo(buf, { planeIndex: 0, format: 'f32-planar' })
      mono.push(buf)
      s.close()
    }
    const ms = performance.now() - t0
    const all = new Float32Array(frames)
    let o = 0
    for (const b of mono) {
      all.set(b, o)
      o += b.length
    }
    const sr = track.sampleRate
    const mid = all.subarray(Math.floor(sr * 1), Math.floor(sr * 3))
    let peak = 0
    for (const v of all) peak = Math.max(peak, Math.abs(v))
    out.decode = {
      samples,
      sampleFormat: fmt,
      pcmFrames: frames,
      pcmSeconds: +(frames / sr).toFixed(3),
      firstTs: +firstTs.toFixed(4),
      lastEnd: +lastEnd.toFixed(4),
      ms: Math.round(ms),
      realtimeFactor: +(frames / sr / (ms / 1000)).toFixed(1),
      dominantHz: +zeroCrossHz(mid, sr).toFixed(1),
      peak: +peak.toFixed(3)
    }
    const lat: number[] = []
    const r = rng(7)
    for (let i = 0; i < 10; i++) {
      const t = r() * 4
      const t1 = performance.now()
      const s = await sink.getSample(t)
      lat.push(performance.now() - t1)
      s?.close()
    }
    out.getSampleMs = stats(lat)
  } catch (e) {
    out.error = err(e)
  } finally {
    input.dispose()
  }
  return out
}

async function audioAll(files: string[], base: string): Promise<Record<string, unknown>> {
  const res: Record<string, unknown> = {}
  for (const f of files) res[f] = await audioOne(base + f)
  return res
}

async function image(url: string): Promise<Record<string, unknown>> {
  const t0 = performance.now()
  const blob = await (await fetch(url)).blob()
  const bmp = await createImageBitmap(blob)
  const r = { ok: true, size: `${bmp.width}x${bmp.height}`, ms: Math.round(performance.now() - t0) }
  bmp.close()
  return r
}
