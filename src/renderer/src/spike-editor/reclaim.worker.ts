// Teste 6: decoders ociosos são "recuperados" (reclaim) pelo Chromium? Mantém um
// VideoDecoder cru e um iterador do VideoSampleSink abertos, espera `idleSec` (janela
// minimizada pelo main) e tenta continuar decodificando.
import { ALL_FORMATS, EncodedPacketSink, Input, UrlSource, VideoSampleSink } from 'mediabunny'

type Msg = { cmd: 'prepare'; url: string } | { cmd: 'resume' }

const errStr = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))

let input: Input | null = null
let decoder: VideoDecoder | null = null
let chunks: EncodedVideoChunk[] = []
let it: AsyncGenerator<{ close(): void; timestamp: number }, void, unknown> | null = null
const decoderErrors: string[] = []
let outputs = 0
let preparedAt = 0

async function prepare(url: string): Promise<Record<string, unknown>> {
  input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
  const track = await input.getPrimaryVideoTrack()
  if (!track) throw new Error('sem vídeo')
  const cfg = await track.getDecoderConfig()
  if (!cfg) throw new Error('sem config')
  const ps = new EncodedPacketSink(track)
  chunks = []
  for await (const p of ps.packets()) {
    chunks.push(p.toEncodedVideoChunk())
    if (chunks.length >= 30) break
  }
  decoder = new VideoDecoder({
    output: (f) => {
      outputs++
      f.close()
    },
    error: (e) => decoderErrors.push(`${(performance.now() - preparedAt) / 1000}s: ${errStr(e)}`)
  })
  decoder.configure({ ...cfg, hardwareAcceleration: 'prefer-hardware' })
  for (const c of chunks) decoder.decode(c)
  await decoder.flush()
  const firstOutputs = outputs

  const sink = new VideoSampleSink(track)
  it = sink.samples(0, 10)
  let n = 0
  for (let i = 0; i < 10; i++) {
    const r = await it.next()
    if (r.done) break
    r.value.close()
    n++
  }
  preparedAt = performance.now()
  return { rawDecoderOutputs: firstOutputs, rawDecoderState: decoder.state, sinkFramesBefore: n }
}

async function resume(): Promise<Record<string, unknown>> {
  const idle = Math.round((performance.now() - preparedAt) / 1000)
  const out: Record<string, unknown> = { idleSec: idle, rawStateAfterIdle: decoder?.state, decoderErrorsDuringIdle: [...decoderErrors] }
  const before = outputs
  try {
    if (!decoder || decoder.state !== 'configured') throw new Error(`decoder em estado ${decoder?.state}`)
    for (const c of chunks) decoder.decode(c)
    await decoder.flush()
    out.rawDecodeAfterIdle = { ok: true, outputs: outputs - before }
  } catch (e) {
    out.rawDecodeAfterIdle = { ok: false, error: errStr(e), errors: [...decoderErrors] }
  }
  try {
    let n = 0
    for (let i = 0; i < 30; i++) {
      const r = await it!.next()
      if (r.done) break
      r.value.close()
      n++
    }
    out.sinkIteratorAfterIdle = { ok: true, frames: n }
  } catch (e) {
    out.sinkIteratorAfterIdle = { ok: false, error: errStr(e) }
  }
  try {
    await it?.return()
  } catch {
    /* ignora */
  }
  decoder?.close()
  input?.dispose()
  return out
}

self.addEventListener('message', (e: MessageEvent<Msg>) => {
  const m = e.data
  const job = m.cmd === 'prepare' ? prepare(m.url) : resume()
  job.then(
    (r) => self.postMessage({ ok: true, result: r }),
    (err: unknown) => self.postMessage({ ok: false, error: String(err instanceof Error ? (err.stack ?? err.message) : err) })
  )
})
