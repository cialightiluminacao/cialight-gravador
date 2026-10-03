import { ALL_FORMATS, Input, UrlSource, VideoSampleSink } from 'mediabunny'
import type { CropValues, MediaLayer } from '@shared/editor/resolve'
import { colorEdgeMask, refDiffMax, rgbDiffStats, type YuvCase, type YuvReport, type YuvTiming } from '@shared/testing/yuvReport'
import { Compositor, type SourceMeta } from '../engine/compositor/compositor'
import { planeSpecs, rgbToYuv, yuvToRgb, type YuvColor, type YuvFormat } from '../engine/compositor/yuv'
import { applySourceColorRule } from '../engine/decoderPool'

// Caminho de upload YUV (G1) no compositor real (CIALIGHT_TEST=editor-render): para cada quadro, compõe com o caminho
// antigo (VideoFrame direto → texImage2D do Chromium) e com o novo (mesmo quadro em cpuFrames → planos R8/RG8 +
// conversão na GPU), lê os pixels e compara (o main exige diferença máxima ≤ 2 por canal). Quadros: barras 75 %
// construídas em I420/NV12/I420A (BT.709/BT.601, faixa limitada/cheia), quadros reais de testsrc2 decodificados em
// software (1080p e SD sem marcação) e um quadro girado 90° com corte. Mede também o custo por quadro 1080p I420.
// Compositor direto num OffscreenCanvas (mesmo código do render worker); todo VideoFrame é fechado aqui.

const ID = 'L'
const CPU: ReadonlySet<string> = new Set([ID])
const NO_CROP: CropValues = { l: 0, t: 0, r: 0, b: 0 }
const TIMING_FRAMES = 10
const TIMING_ROUNDS = 3

export interface YuvSources { hd?: string; rot?: string; sd?: string }

function mediaLayer(crop: CropValues, fit: MediaLayer['fit']): MediaLayer {
  return { kind: 'media', itemId: ID, trackId: 't', assetId: 'a', srcUs: 0, rect: { cx: 0.5, cy: 0.5, scale: 1, rotation: 0 }, opacity: 1, crop, fit, shape: 'rect', radius: 0, mirror: false }
}

const clamp8 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)))

/** RGB 0–255 do pixel (x, y) das barras: 75 % em cima (2/3), rampa de cinza, 100 % saturadas embaixo. */
function barsRgb(x: number, y: number, w: number, h: number): [number, number, number] {
  const BARS: [number, number, number][] = [[1, 1, 1], [1, 1, 0], [0, 1, 1], [0, 1, 0], [1, 0, 1], [1, 0, 0], [0, 0, 1]]
  const FULL: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 1, 1], [1, 0, 1], [1, 1, 0], [0, 0, 0], [1, 1, 1]]
  if (y < (h * 2) / 3) return BARS[Math.min(6, Math.floor((x * 7) / w))].map((v) => v * 0.75 * 255) as [number, number, number]
  if (y < (h * 5) / 6) {
    const g = (x / (w - 1)) * 255
    return [g, g, g]
  }
  return FULL[Math.min(7, Math.floor((x * 8) / w))].map((v) => v * 255) as [number, number, number]
}

type Ref = (x: number, y: number) => number[] | null

/**
 * Quadro de barras em memória de CPU no formato pedido (croma = média do bloco 2×2; alfa do I420A = rampa vertical) e a
 * referência por pixel (conta de yuvToRgb sobre os códigos gravados, pré-multiplicada pelo alfa sobre o fundo preto) —
 * só onde o croma do bloco e dos 8 vizinhos é igual (longe das bordas de croma, onde a amostragem não importa).
 */
function barsFrame(format: YuvFormat, w: number, h: number, c: YuvColor, colorSpace: VideoColorSpaceInit): { frame: VideoFrame; ref: Ref } {
  const planes = planeSpecs(format, w, h)
  const sizes = planes.map((p) => p.width * p.height * p.channels)
  const buf = new Uint8Array(sizes.reduce((s, n) => s + n, 0))
  const offs = sizes.map((_, i) => sizes.slice(0, i).reduce((s, n) => s + n, 0))
  const cw = planes[1].width
  const ch = planes[1].height
  const uAcc = new Float64Array(cw * ch)
  const vAcc = new Float64Array(cw * ch)
  const cnt = new Uint8Array(cw * ch)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = barsRgb(x, y, w, h)
      const [Y, U, V] = rgbToYuv(r, g, b, c)
      buf[offs[0] + y * w + x] = clamp8(Y)
      const ci = (y >> 1) * cw + (x >> 1)
      uAcc[ci] += U
      vAcc[ci] += V
      cnt[ci]++
      if (format === 'I420A') buf[offs[3] + y * w + x] = clamp8((y / (h - 1)) * 255)
    }
  }
  const U = new Uint8Array(cw * ch)
  const V = new Uint8Array(cw * ch)
  for (let i = 0; i < cw * ch; i++) {
    const u = clamp8(uAcc[i] / cnt[i])
    const v = clamp8(vAcc[i] / cnt[i])
    U[i] = u
    V[i] = v
    if (format === 'NV12') {
      buf[offs[1] + 2 * i] = u
      buf[offs[1] + 2 * i + 1] = v
    } else {
      buf[offs[1] + i] = u
      buf[offs[2] + i] = v
    }
  }
  const ref: Ref = (x, y) => {
    const bx = x >> 1
    const by = y >> 1
    const ci = by * cw + bx
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = bx + dx
        const ny = by + dy
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) return null
        const ni = ny * cw + nx
        if (U[ni] !== U[ci] || V[ni] !== V[ci]) return null
      }
    }
    const a = format === 'I420A' ? buf[offs[3] + y * w + x] / 255 : 1
    return yuvToRgb(buf[offs[0] + y * w + x], U[ci], V[ci], c).map((v) => Math.round(clamp8(v) * a))
  }
  return { frame: new VideoFrame(buf, { format, codedWidth: w, codedHeight: h, timestamp: 0, colorSpace }), ref }
}

/** Quadro do caminho antigo e do novo, comparados; o "novo" tem de ter passado pelo caminho YUV. */
async function parity(comp: Compositor, name: string, frame: VideoFrame, meta: SourceMeta, layer: MediaLayer, canvas: { w: number; h: number }, informative = false, ref?: Ref): Promise<YuvCase> {
  const cs = frame.colorSpace
  const out: YuvCase = { name, format: frame.format, colorSpace: { matrix: cs.matrix, fullRange: cs.fullRange, primaries: cs.primaries, transfer: cs.transfer }, ...(informative ? { informative } : {}) }
  comp.resize(canvas.w, canvas.h)
  const sources = new Map<string, VideoFrame>([[ID, frame]])
  const metaMap = new Map([[ID, meta]])
  comp.draw([layer], sources, '#000000', { meta: metaMap })
  const old = comp.readPixels(0, 0, canvas.w, canvas.h)
  const before = comp.yuvConversions
  await comp.prepareCpuFrames(sources, CPU)
  comp.draw([layer], sources, '#000000', { meta: metaMap, cpuFrames: CPU })
  const neu = comp.readPixels(0, 0, canvas.w, canvas.h)
  out.yuv = comp.yuvConversions === before + 1
  const s = rgbDiffStats(old, neu, 2)
  // exceção do brief: 1 px nas bordas de cor (croma subamostrado) — medida à parte
  const mask = colorEdgeMask(old, neu, canvas.w, canvas.h, 16)
  const off = rgbDiffStats(old, neu, 2, mask)
  let edgePx = 0
  for (const m of mask) edgePx += m
  const refs = ref ? { refOld: refDiffMax(old, ref, canvas.w, canvas.h, mask), refNew: refDiffMax(neu, ref, canvas.w, canvas.h, mask) } : {}
  let sum = 0
  for (let i = 0; i < old.length; i += 4) sum += old[i] + old[i + 1] + old[i + 2]
  let worst: YuvCase['worst']
  let wd = -1
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, nb = 0
  for (let i = 0; i < old.length; i += 4) {
    const d = Math.max(Math.abs(old[i] - neu[i]), Math.abs(old[i + 1] - neu[i + 1]), Math.abs(old[i + 2] - neu[i + 2]))
    const x = (i / 4) % canvas.w
    const y = Math.floor(i / 4 / canvas.w)
    if (d > wd) {
      wd = d
      worst = { x, y, old: [...old.subarray(i, i + 3)], neu: [...neu.subarray(i, i + 3)] }
    }
    if (d > 2) {
      nb++
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1)
    }
  }
  return { ...out, max: s.max, p99: s.p99, over: s.over, maxOffEdge: off.max, edgePx, ...refs, mean: Math.round((sum / (old.length * 0.75)) * 10) / 10, worst, box: nb ? { x0, y0, x1, y1, n: nb } : null }
}

/** Abre a faixa de vídeo com o decoder em software (como a exportação da Task 2) e a regra de cor do DecoderPool. */
async function softwareSink(url: string): Promise<{ input: Input; sink: VideoSampleSink }> {
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
  const track = await input.getPrimaryVideoTrack()
  if (!track) throw new Error(`sem faixa de vídeo: ${url}`)
  await applySourceColorRule(track)
  return { input, sink: new VideoSampleSink(track, { hardwareAcceleration: 'prefer-software' }) }
}

async function realCase(comp: Compositor, name: string, url: string | undefined, tS: number, opts: { crop?: CropValues; fit?: MediaLayer['fit']; canvas?: { w: number; h: number } } = {}): Promise<YuvCase> {
  if (!url) return { name, error: 'URL ausente' }
  let input: Input | null = null
  try {
    const s = await softwareSink(url)
    input = s.input
    const sample = await s.sink.getSample(tS)
    if (!sample) return { name, error: `sem quadro em ${tS} s` }
    const frame = sample.toVideoFrame()
    const rotation = sample.rotation
    sample.close()
    try {
      const meta: SourceMeta = { w: frame.displayWidth, h: frame.displayHeight, rotation }
      const canvas = opts.canvas ?? { w: rotation % 180 ? frame.displayHeight : frame.displayWidth, h: rotation % 180 ? frame.displayWidth : frame.displayHeight }
      const c = await parity(comp, name, frame, meta, mediaLayer(opts.crop ?? NO_CROP, opts.fit ?? 'fill'), canvas)
      return { ...c, name: `${name} (${frame.codedWidth}×${frame.codedHeight}, visível ${frame.visibleRect?.width}×${frame.visibleRect?.height}, rotação ${rotation})` }
    } finally {
      frame.close()
    }
  } catch (e) {
    return { name, error: e instanceof Error ? e.message : String(e) }
  } finally {
    input?.dispose()
  }
}

/** Custo por quadro 1080p I420 (decoder em software): caminho antigo × copyTo + upload + conversão, com gl.finish. */
async function timing(comp: Compositor, url: string | undefined): Promise<YuvTiming | { error: string }> {
  if (!url) return { error: 'URL ausente' }
  let input: Input | null = null
  const frames: VideoFrame[] = []
  try {
    const s = await softwareSink(url)
    input = s.input
    for await (const sample of s.sink.samples(0, 1)) {
      frames.push(sample.toVideoFrame())
      sample.close()
      if (frames.length >= TIMING_FRAMES) break
    }
    if (!frames.length || frames[0].format !== 'I420') return { error: `quadros ${frames.length}, formato ${frames[0]?.format}` }
    comp.resize(1920, 1080)
    const layer = mediaLayer(NO_CROP, 'fill')
    const meta = new Map([[ID, { w: 1920, h: 1080, rotation: 0 as const }]])
    let oldMs = 0
    let copyMs = 0
    let drawMs = 0
    let n = 0
    for (let round = 0; round <= TIMING_ROUNDS; round++) {
      for (const f of frames) {
        const sources = new Map([[ID, f]])
        const t0 = performance.now()
        comp.draw([layer], sources, '#000000', { meta })
        comp.finish()
        const t1 = performance.now()
        await comp.prepareCpuFrames(sources, CPU)
        const t2 = performance.now()
        comp.draw([layer], sources, '#000000', { meta, cpuFrames: CPU })
        comp.finish()
        const t3 = performance.now()
        if (round === 0) continue // aquecimento
        oldMs += t1 - t0
        copyMs += t2 - t1
        drawMs += t3 - t2
        n++
      }
    }
    const r = (v: number): number => Math.round((v / n) * 100) / 100
    return { frames: n, oldMs: r(oldMs), newMs: r(copyMs + drawMs), copyMs: r(copyMs), drawMs: r(drawMs) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  } finally {
    for (const f of frames) f.close()
    input?.dispose()
  }
}

export async function yuvCheck(src: YuvSources): Promise<YuvReport> {
  const report: YuvReport = { cases: [] }
  const comp = new Compositor(new OffscreenCanvas(1920, 1080))
  try {
    const W = 1920
    const H = 1080
    const canvas = { w: W, h: H }
    const meta: SourceMeta = { w: W, h: H, rotation: 0 }
    const full = mediaLayer(NO_CROP, 'fill')
    const bars: [string, YuvColor, VideoColorSpaceInit, boolean][] = [
      ['BT.709 limitada', { matrix: 'bt709', fullRange: false }, { matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', fullRange: false }, false],
      ['BT.709 cheia', { matrix: 'bt709', fullRange: true }, { matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', fullRange: true }, false],
      // primárias/transferência BT.709 como o DecoderPool declara para SD sem marcação (só a matriz muda)
      ['BT.601 limitada', { matrix: 'bt601', fullRange: false }, { matrix: 'smpte170m', primaries: 'bt709', transfer: 'bt709', fullRange: false }, false],
      ['BT.601 cheia', { matrix: 'bt601', fullRange: true }, { matrix: 'smpte170m', primaries: 'bt709', transfer: 'bt709', fullRange: true }, false],
      // informativo: marcação BT.601 completa (primárias/transferência smpte170m) — o Chromium converte a gama?
      ['BT.601 limitada, primárias smpte170m', { matrix: 'bt601', fullRange: false }, { matrix: 'smpte170m', primaries: 'smpte170m', transfer: 'smpte170m', fullRange: false }, true]
    ]
    for (const format of ['I420', 'NV12'] as const) {
      for (const [name, c, cs, informative] of bars) {
        const { frame, ref } = barsFrame(format, W, H, c, cs)
        try {
          report.cases.push(await parity(comp, `barras ${format} ${name}`, frame, meta, full, canvas, informative, ref))
        } catch (e) {
          report.cases.push({ name: `barras ${format} ${name}`, error: e instanceof Error ? e.message : String(e) })
        } finally {
          frame.close()
        }
      }
    }
    const { frame: alpha, ref: alphaRef } = barsFrame('I420A', W, H, { matrix: 'bt709', fullRange: false }, { matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', fullRange: false })
    try {
      report.cases.push(await parity(comp, 'barras I420A BT.709 limitada (alfa em rampa)', alpha, meta, full, canvas, false, alphaRef))
    } finally {
      alpha.close()
    }
    report.cases.push(await realCase(comp, 'testsrc2 1080p em software', src.hd, 1.0))
    report.cases.push(await realCase(comp, 'testsrc2 SD sem marcação em software', src.sd, 1.0))
    report.cases.push(await realCase(comp, 'girado 90° com corte em software', src.rot, 0.5, { crop: { l: 0.1, t: 0.05, r: 0.2, b: 0.15 }, fit: 'contain', canvas }))
    const t = await timing(comp, src.hd)
    if ('error' in t) report.error = `tempo: ${t.error}`
    else report.timing = t
  } catch (e) {
    report.error = e instanceof Error ? (e.stack ?? e.message) : String(e)
  } finally {
    comp.dispose()
  }
  return report
}
