import { ALL_FORMATS, Input, UrlSource, VideoSampleSink } from 'mediabunny'
import type { CropValues, MediaLayer } from '@shared/editor/resolve'
import { colorEdgeMask, refDiffMax, rgbDiffStats, type YuvCase, type YuvReport, type YuvTiming } from '@shared/testing/yuvReport'
import { Compositor, type SourceMeta } from '../engine/compositor/compositor'
import { planeSpecs, resolveYuvColor, rgbToYuv, yuvToRgb, type PlanarFormat, type YuvColor } from '../engine/compositor/yuv'
import { applySourceColorRule } from '../engine/decoderPool'

// Caminho de upload YUV (G1) no compositor real (CIALIGHT_TEST=editor-render): para cada quadro, compõe com o caminho
// antigo (VideoFrame direto → texImage2D do Chromium) e com o novo (mesmo quadro em cpuFrames → planos R8 + conversão
// na GPU), lê os pixels e compara (o main exige diferença máxima ≤ 2 por canal). Quadros: barras 75 % construídas em
// I420 (BT.709/BT.601, faixa limitada/cheia), quadros reais de testsrc2 decodificados em software (1080p e SD sem
// marcação), um quadro girado 90° com corte e um I420 com linhas codificadas abaixo do visível de outra cor (a última
// linha visível não pode puxar cor de fora do visibleRect). R4: NV12/I420A marcados como CPU têm de cair no caminho
// antigo (imagem idêntica). Mede também o custo por quadro 1080p I420.
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
function barsFrame(format: PlanarFormat, w: number, h: number, c: YuvColor, colorSpace: VideoColorSpaceInit): { frame: VideoFrame; ref: Ref } {
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

interface ParityOpts {
  /** 'yuv': o novo desenho tem de passar pelo caminho YUV; 'fallback': marcado como CPU, mas fica no antigo (R4). */
  expect: YuvCase['expect']
  informative?: boolean
  /** Referência (conta da matriz) por pixel do canvas; null = sem referência ali. */
  ref?: Ref
  /**
   * A última linha do canvas (= última linha visível do quadro, desenho 1:1) fica fora das estatísticas contra o
   * envio completo do caminho antigo e é medida à parte (lastRow): nela o texImage2D completo do Chromium difere do
   * texSubImage2D do mesmo quadro (medido no SD real). Contra o envio parcial, o quadro inteiro conta.
   */
  lastRowApart?: boolean
  /** Referências só da última linha visível (lastRowRefs): `visible` = conta pelos planos visíveis. */
  lastRowRef?: { visible: Ref; leak?: Ref; n: number }
}

/** Maior diferença por canal RGB entre a linha `ra` de `a` e a linha `rb` de `b` (imagens RGBA de largura w). */
function rowMax(a: Uint8Array, ra: number, b: Uint8Array, rb: number, w: number): number {
  let m = 0
  for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(a[(ra * w + x) * 4 + c] - b[(rb * w + x) * 4 + c]))
  return m
}

let caseSeq = 0

/**
 * Compõe o quadro pelo caminho antigo duas vezes — a 1ª numa entrada de textura nova (texImage2D completo, como no 1º
 * quadro de um item) e a 2ª na mesma entrada (texSubImage2D, como nos quadros seguintes) — e pelo novo (cpuFrames),
 * e compara. Cada caso usa um itemId próprio (entrada de cache nova). Registra se o novo passou mesmo pelo caminho YUV.
 */
async function parity(comp: Compositor, name: string, frame: VideoFrame, meta: SourceMeta, layer0: MediaLayer, canvas: { w: number; h: number }, opts: ParityOpts): Promise<YuvCase> {
  const cs = frame.colorSpace
  const out: YuvCase = { name, expect: opts.expect, format: frame.format, colorSpace: { matrix: cs.matrix, fullRange: cs.fullRange, primaries: cs.primaries, transfer: cs.transfer }, ...(opts.informative ? { informative: true } : {}) }
  const id = `yuv${++caseSeq}`
  const cpu = new Set([id])
  const layer: MediaLayer = { ...layer0, itemId: id }
  comp.resize(canvas.w, canvas.h)
  const sources = new Map<string, VideoFrame>([[id, frame]])
  const metaMap = new Map([[id, meta]])
  comp.draw([layer], sources, '#000000', { meta: metaMap })
  const oldFull = comp.readPixels(0, 0, canvas.w, canvas.h)
  comp.draw([layer], sources, '#000000', { meta: metaMap })
  const oldSub = comp.readPixels(0, 0, canvas.w, canvas.h)
  const before = comp.yuvConversions
  await comp.prepareCpuFrames(sources, cpu)
  comp.draw([layer], sources, '#000000', { meta: metaMap, cpuFrames: cpu })
  const fullNew = comp.readPixels(0, 0, canvas.w, canvas.h)
  out.yuv = comp.yuvConversions === before + 1
  // contra o envio parcial do caminho antigo: o quadro inteiro, sem exceção nenhuma
  const sub = rgbDiffStats(oldSub, fullNew, 2)
  out.subMax = sub.max
  out.subP99 = sub.p99
  const h = opts.lastRowApart ? canvas.h - 1 : canvas.h
  if (opts.lastRowApart) {
    const r = canvas.h - 1
    out.lastRow = { oldVsNew: rowMax(oldFull, r, fullNew, r, canvas.w), oldSubVsNew: rowMax(oldSub, r, fullNew, r, canvas.w), oldFullVsSub: rowMax(oldFull, r, oldSub, r, canvas.w) }
    const lr = opts.lastRowRef
    if (lr) {
      out.lastRow.refPx = lr.n
      out.lastRow.newRef = refDiffMax(fullNew, lr.visible, canvas.w, canvas.h)
      out.lastRow.oldRef = refDiffMax(oldFull, lr.visible, canvas.w, canvas.h)
      out.lastRow.oldSubRef = refDiffMax(oldSub, lr.visible, canvas.w, canvas.h)
      if (lr.leak) {
        out.lastRow.oldLeakRef = refDiffMax(oldFull, lr.leak, canvas.w, canvas.h)
        out.lastRow.newLeakRef = refDiffMax(fullNew, lr.leak, canvas.w, canvas.h)
      }
    }
  }
  // contra o envio completo: sem a última linha quando ela é medida à parte
  const o = oldFull.subarray(0, canvas.w * h * 4)
  const neu = fullNew.subarray(0, canvas.w * h * 4)
  const s = rgbDiffStats(o, neu, 2)
  // exceção do brief: 1 px nas bordas de cor da fonte (croma subamostrado) — só bordas presentes nas duas imagens
  const mask = colorEdgeMask(o, neu, canvas.w, h, 16)
  const off = rgbDiffStats(o, neu, 2, mask)
  let edgePx = 0
  for (const m of mask) edgePx += m
  if (opts.ref) {
    out.refOld = refDiffMax(oldFull, opts.ref, canvas.w, canvas.h)
    out.refNew = refDiffMax(fullNew, opts.ref, canvas.w, canvas.h)
  }
  let sum = 0
  for (let i = 0; i < o.length; i += 4) sum += o[i] + o[i + 1] + o[i + 2]
  let worst: YuvCase['worst']
  let wd = -1
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, nb = 0
  for (let i = 0; i < o.length; i += 4) {
    const d = Math.max(Math.abs(o[i] - neu[i]), Math.abs(o[i + 1] - neu[i + 1]), Math.abs(o[i + 2] - neu[i + 2]))
    const x = (i / 4) % canvas.w
    const y = Math.floor(i / 4 / canvas.w)
    if (d > wd) {
      wd = d
      worst = { x, y, old: [...o.subarray(i, i + 3)], neu: [...neu.subarray(i, i + 3)] }
    }
    if (d > 2) {
      nb++
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1)
    }
  }
  return { ...out, max: s.max, p99: s.p99, over: s.over, maxOffEdge: off.max, edgePx, mean: Math.round((sum / (o.length * 0.75)) * 10) / 10, worst, box: nb ? { x0, y0, x1, y1, n: nb } : null }
}

/** Abre a faixa de vídeo com o decoder em software (como a exportação da Task 2) e a regra de cor do DecoderPool. */
async function softwareSink(url: string): Promise<{ input: Input; sink: VideoSampleSink }> {
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
  const track = await input.getPrimaryVideoTrack()
  if (!track) throw new Error(`sem faixa de vídeo: ${url}`)
  await applySourceColorRule(track)
  return { input, sink: new VideoSampleSink(track, { hardwareAcceleration: 'prefer-software' }) }
}

/**
 * Referências da última linha visível de um I420 de CPU (desenho 1:1), a partir dos planos da área codificada INTEIRA
 * (copyTo próprio, independente do copyTo do caminho novo): `visible` = conta da matriz com o croma da última linha de
 * croma visível; `leak` = croma ¾ dela + ¼ da linha de croma codificada abaixo do visibleRect (o que um amostrador que
 * lê além do visível daria). Só onde o croma não muda na horizontal (vizinhos ±1 bloco iguais, nas duas linhas).
 */
async function lastRowRefs(frame: VideoFrame): Promise<{ visible: Ref; leak: Ref; n: number } | undefined> {
  const vr = frame.visibleRect
  const color = resolveYuvColor(frame.colorSpace, frame.codedWidth, frame.codedHeight)
  if (!vr || !color || frame.format !== 'I420' || vr.x !== 0 || vr.y !== 0) return undefined
  // o padrão do copyTo é o visibleRect: pede a área codificada inteira
  const coded = { rect: { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight } }
  const buf = new Uint8Array(frame.allocationSize(coded))
  const [ly, lu, lv] = await frame.copyTo(buf, coded)
  const row = vr.height - 1
  const cr = row >> 1
  const cBelow = Math.min(cr + 1, Math.ceil(frame.codedHeight / 2) - 1)
  const cw = Math.ceil(vr.width / 2)
  const U = (r: number, b: number): number => buf[lu.offset + r * lu.stride + b]
  const V = (r: number, b: number): number => buf[lv.offset + r * lv.stride + b]
  const flat = (b: number): boolean => b >= 1 && b < cw - 1 && [cr, cBelow].every((r) => U(r, b - 1) === U(r, b) && U(r, b + 1) === U(r, b) && V(r, b - 1) === V(r, b) && V(r, b + 1) === V(r, b))
  const yAt = (x: number): number => buf[ly.offset + row * ly.stride + x]
  let n = 0
  for (let x = 0; x < vr.width; x++) if (flat(x >> 1)) n++
  const mk = (wBelow: number): Ref => (x, y) => {
    const b = x >> 1
    if (y !== row || !flat(b)) return null
    const u = (1 - wBelow) * U(cr, b) + wBelow * U(cBelow, b)
    const v = (1 - wBelow) * V(cr, b) + wBelow * V(cBelow, b)
    return yuvToRgb(yAt(x), u, v, color).map((c) => clamp8(c))
  }
  return { visible: mk(0), leak: mk(0.25), n }
}

async function realCase(comp: Compositor, name: string, url: string | undefined, tS: number, opts: { crop?: CropValues; fit?: MediaLayer['fit']; canvas?: { w: number; h: number }; lastRowApart?: boolean } = {}): Promise<YuvCase> {
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
      const lastRowRef = opts.lastRowApart ? await lastRowRefs(frame) : undefined
      const c = await parity(comp, name, frame, meta, mediaLayer(opts.crop ?? NO_CROP, opts.fit ?? 'fill'), canvas, { expect: 'yuv', lastRowApart: opts.lastRowApart, lastRowRef })
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

/**
 * I420 640×482 com visível 640×480 (como o SD do decoder): barras 75 % BT.601 limitadas na altura toda do visível e as
 * 2 linhas codificadas abaixo dele em vermelho puro (o croma da linha 240 também). Nenhuma linha visível pode ter
 * vermelho: o caminho novo bate com a conta no quadro inteiro, inclusive na última linha (o copyTo só do visibleRect).
 * (Medido: neste quadro construído o envio completo do Chromium também não vaza; no SD decodificado, vaza — lá a
 * prova é a referência `leak` de lastRowRefs.)
 */
async function leakCase(comp: Compositor): Promise<YuvCase> {
  const name = 'I420 com linhas codificadas vermelhas abaixo do visível (640×482 → 640×480)'
  const W = 640, VH = 480, CH = 482
  const c: YuvColor = { matrix: 'bt601', fullRange: false }
  const cw = W / 2, chh = CH / 2
  const buf = new Uint8Array(W * CH + 2 * cw * chh)
  const uOff = W * CH, vOff = uOff + cw * chh
  const red = rgbToYuv(255, 0, 0, c).map(clamp8)
  const barCodes = (x: number): number[] => rgbToYuv(...barsRgb(x, 0, W, VH), c).map(clamp8)
  for (let y = 0; y < CH; y++) for (let x = 0; x < W; x++) buf[y * W + x] = y < VH ? barCodes(x)[0] : red[0]
  for (let y = 0; y < chh; y++) {
    for (let x = 0; x < cw; x++) {
      // croma do bloco = o do pixel da esquerda (blocos que atravessam uma borda de barra: a referência os ignora)
      const [, u, v] = y < VH / 2 ? barCodes(2 * x) : red
      buf[uOff + y * cw + x] = u
      buf[vOff + y * cw + x] = v
    }
  }
  // referência onde o croma não muda na horizontal (vizinhos ±1 bloco iguais): a cor da barra pela conta
  const ref: Ref = (x) => {
    const bx = x >> 1
    if (bx < 1 || bx >= cw - 1) return null
    const k = (i: number): string => `${buf[uOff + i]},${buf[vOff + i]}`
    if (k(bx - 1) !== k(bx) || k(bx + 1) !== k(bx)) return null
    return yuvToRgb(barCodes(x)[0], buf[uOff + bx], buf[vOff + bx], c).map((v) => clamp8(v))
  }
  let n = 0
  for (let x = 0; x < W; x++) if (ref(x, VH - 1)) n++
  const frame = new VideoFrame(buf, {
    format: 'I420', codedWidth: W, codedHeight: CH, visibleRect: { x: 0, y: 0, width: W, height: VH }, displayWidth: W, displayHeight: VH,
    timestamp: 0, colorSpace: { matrix: 'smpte170m', primaries: 'bt709', transfer: 'bt709', fullRange: false }
  })
  try {
    const lastOnly: Ref = (x, y) => (y === VH - 1 ? ref(x, y) : null)
    return await parity(comp, name, frame, { w: W, h: VH, rotation: 0 }, mediaLayer(NO_CROP, 'fill'), { w: W, h: VH }, { expect: 'yuv', ref, lastRowApart: true, lastRowRef: { visible: lastOnly, n } })
  } finally {
    frame.close()
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
        if (format === 'NV12' && informative) continue
        const { frame, ref } = barsFrame(format, W, H, c, cs)
        try {
          // R4: NV12 de CPU marcado fica no caminho antigo
          report.cases.push(await parity(comp, `barras ${format} ${name}`, frame, meta, full, canvas, { expect: format === 'I420' ? 'yuv' : 'fallback', informative, ref }))
        } catch (e) {
          report.cases.push({ name: `barras ${format} ${name}`, error: e instanceof Error ? e.message : String(e) })
        } finally {
          frame.close()
        }
      }
    }
    const { frame: alpha, ref: alphaRef } = barsFrame('I420A', W, H, { matrix: 'bt709', fullRange: false }, { matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', fullRange: false })
    try {
      report.cases.push(await parity(comp, 'barras I420A BT.709 limitada (alfa em rampa)', alpha, meta, full, canvas, { expect: 'fallback', ref: alphaRef }))
    } finally {
      alpha.close()
    }
    report.cases.push(await realCase(comp, 'testsrc2 1080p em software', src.hd, 1.0))
    report.cases.push(await realCase(comp, 'testsrc2 SD sem marcação em software', src.sd, 1.0, { lastRowApart: true }))
    report.cases.push(await leakCase(comp))
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
