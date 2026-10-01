// Teste 2: OffscreenCanvas transferido para Worker + WebGL2 (twgl) + VideoFrame do
// VideoSampleSink como textura; blur separável e pixelização com verificação por leitura.
import { ALL_FORMATS, Input, UrlSource, VideoSampleSink } from 'mediabunny'
import { BLUR_RECT, GlPipeline, OUTSIDE_RECT, PIX_RECT, hfEnergy, lumaVariance, stats, toPng } from './glPipeline'

interface Msg {
  canvas: OffscreenCanvas
  url: string
  frames: number
}

self.addEventListener('message', (e: MessageEvent<Msg>) => {
  run(e.data).then(
    (r) => self.postMessage(r, { transfer: r.png ? [r.png] : [] }),
    (err: unknown) => self.postMessage({ ok: false, error: String(err instanceof Error ? (err.stack ?? err.message) : err) })
  )
})

async function run({ canvas, url, frames }: Msg): Promise<Record<string, unknown> & { png?: ArrayBuffer }> {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' })
  if (!gl) return { ok: false, error: 'webgl2 indisponível no worker' }
  const W = canvas.width
  const H = canvas.height
  const p = new GlPipeline(gl, W, H)
  const renderer = p.rendererInfo()

  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
  const track = await input.getPrimaryVideoTrack()
  if (!track) throw new Error('sem faixa de vídeo')
  const sink = new VideoSampleSink(track)

  const decodeWait: number[] = []
  const uploadMs: number[] = []
  const effectsFullMs: number[] = []
  const effectsDs2Ms: number[] = []
  const plainDrawMs: number[] = []
  const totalMs: number[] = []
  let sampleFormat = ''
  let n = 0
  const tStart = performance.now()
  let tPrev = tStart
  const it = sink.samples(0, frames / 30 + 0.01)
  for (;;) {
    const tw = performance.now()
    const r = await it.next()
    if (r.done) break
    decodeWait.push(performance.now() - tw)
    const sample = r.value
    sampleFormat = `${sample.format} ${sample.codedWidth}x${sample.codedHeight}`
    const frame = sample.toVideoFrame()
    let t0 = performance.now()
    p.upload(frame)
    p.sync()
    uploadMs.push(performance.now() - t0)
    frame.close()
    sample.close()

    // fase A: só desenho do src no canvas (sem efeitos); fase B: blur cheio; fase C: blur com downsample 2×
    const phase = n % 3
    t0 = performance.now()
    if (phase === 0) {
      p.present(null)
      p.sync()
      plainDrawMs.push(performance.now() - t0)
    } else if (phase === 1) {
      p.effects({ blurDownsample: 1, blurRadius: 24, blurSigma: 10, pixelCell: 24 }, null)
      p.sync()
      effectsFullMs.push(performance.now() - t0)
    } else {
      p.effects({ blurDownsample: 2, blurRadius: 24, blurSigma: 10, pixelCell: 24 }, null)
      p.sync()
      effectsDs2Ms.push(performance.now() - t0)
    }
    const now = performance.now()
    totalMs.push(now - tPrev)
    tPrev = now
    n++
    // devolve o controle ao event loop (o OffscreenCanvas transferido é apresentado ao fim da task)
    await new Promise((r2) => setTimeout(r2, 0))
  }
  const elapsed = performance.now() - tStart

  // Verificação: efeitos no último frame, num FBO, e comparação com o original
  p.effects({ blurDownsample: 1, blurRadius: 24, blurSigma: 10, pixelCell: 24 }, p.fboOut)
  const verify: Record<string, unknown> = {}
  for (const [name, rect] of [
    ['blur', BLUR_RECT],
    ['pixelate', PIX_RECT],
    ['outside', OUTSIDE_RECT]
  ] as const) {
    const a = p.read(p.fboSrc, rect)
    const b = p.read(p.fboOut, rect)
    verify[name] = {
      hfOriginal: +hfEnergy(a).toFixed(3),
      hfResult: +hfEnergy(b).toFixed(3),
      varOriginal: +lumaVariance(a).toFixed(1),
      varResult: +lumaVariance(b).toFixed(1)
    }
  }
  const png = await toPng(p.read(p.fboOut, [0, 0, 1, 1]))

  // Verificação robusta: ruído aleatório (alta frequência em toda a imagem) como entrada
  const noise = new OffscreenCanvas(W, H)
  const nctx = noise.getContext('2d')!
  const img = nctx.createImageData(W, H)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = (Math.random() * 255) | 0
    img.data[i] = v
    img.data[i + 1] = v
    img.data[i + 2] = v
    img.data[i + 3] = 255
  }
  nctx.putImageData(img, 0, 0)
  p.upload(noise)
  p.effects({ blurDownsample: 1, blurRadius: 24, blurSigma: 10, pixelCell: 24 }, p.fboOut)
  const verifyNoise: Record<string, unknown> = {}
  for (const [name, rect] of [
    ['blur', BLUR_RECT],
    ['pixelate', PIX_RECT],
    ['outside', OUTSIDE_RECT]
  ] as const) {
    const a = p.read(p.fboSrc, rect)
    const b = p.read(p.fboOut, rect)
    verifyNoise[name] = {
      hfOriginal: +hfEnergy(a).toFixed(3),
      hfResult: +hfEnergy(b).toFixed(3),
      varOriginal: +lumaVariance(a).toFixed(1),
      varResult: +lumaVariance(b).toFixed(1)
    }
  }
  input.dispose()

  return {
    ok: true,
    renderer,
    canvas: `${W}x${H}`,
    sampleFormat,
    frames: n,
    pipelineFps: +((n / elapsed) * 1000).toFixed(1),
    decodeWaitMs: stats(decodeWait),
    uploadMs: stats(uploadMs),
    plainDrawMs: stats(plainDrawMs),
    effectsFullResMs: stats(effectsFullMs),
    effectsDownsample2Ms: stats(effectsDs2Ms),
    frameTotalMs: stats(totalMs),
    verify,
    verifyNoise,
    png
  }
}
