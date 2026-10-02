import { createEffectItem, createMediaItem, type EffectPresetId, type EffectRegionInit } from '@shared/editor/factory'
import type { EffectItem, MediaItem, Project, Track } from '@shared/editor/project'
import { RenderClient } from '../engine/RenderClient'
import { mediaUrlsFor } from '../engine/mediaUrls'
import { effectPixelBlockPx, featherPx, pixelCellQ, regionDistPx, regionScissor } from '../engine/compositor/effectsMath'

// Cenários de pixel do passe de efeitos (F2) para o teste de render (CIALIGHT_TEST=editor-render).
// Projeto base p-editor-effects-test (testsrc2 1080p + ruído + PNG vermelho, criado pelo main); as variantes
// com efeitos são montadas aqui em memória (mesmos assets, mesmas URLs) e comparadas com o quadro sem efeito.

export const EFFECTS_PROJECT_ID = 'p-editor-effects-test'
const W = 1920
const H = 1080
const DUR = 3_000_000

type Region = { x: number; y: number; w: number; h: number; rotation: number }
type Img = Uint8Array

function fxTrack(id: string, item: EffectItem | MediaItem): Track {
  return { id, kind: 'video', name: id, muted: false, hidden: false, locked: false, volume: 1, items: [item] }
}

function effect(preset: EffectPresetId, region: EffectRegionInit, over: Partial<EffectItem> = {}, durationUs = DUR): EffectItem {
  return { ...createEffectItem(preset, 0, durationUs, region), ...over }
}

const regionOf = (e: EffectItem): Region => ({ x: e.region.x.value, y: e.region.y.value, w: e.region.w.value, h: e.region.h.value, rotation: e.region.rotation.value })

const luma = (d: Img, i: number): number => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]

/** Caixa (px, origem em cima à esquerda) da região + feather + `pad`, como o compositor a recorta. */
function boxTopDown(r: Region & { shape?: 'rect' | 'ellipse' }, feather: number, pad: number): { x0: number; y0: number; x1: number; y1: number } {
  const s = regionScissor(r, feather, W, H)
  return { x0: Math.max(0, s.x - pad), x1: Math.min(W, s.x + s.w + pad), y0: Math.max(0, H - (s.y + s.h) - pad), y1: Math.min(H, H - s.y + pad) }
}

/**
 * Energia de detalhe: média de ΔL² entre vizinhos (horizontal + vertical) em [x0,x1)×[y0,y1). Mede o que o
 * blur remove mesmo no testsrc2 (barras chapadas com bordas duras): a borda espalhada pelo blur tem ΔL² ~1/raio
 * do original, enquanto a variância de luma da região quase não muda.
 */
export function detailEnergy(d: Img, x0: number, y0: number, x1: number, y1: number, width = W): number {
  let s = 0
  let n = 0
  for (let y = y0; y < y1 - 1; y++) {
    for (let x = x0; x < x1 - 1; x++) {
      const i = (y * width + x) * 4
      const l = luma(d, i)
      s += (l - luma(d, i + 4)) ** 2 + (l - luma(d, i + width * 4)) ** 2
      n++
    }
  }
  return n ? s / n : 0
}

/** Maior diferença por canal entre a e b em [x0,x1)×[y0,y1), pulando pixels para os quais `skip` é verdadeiro. */
function maxDiff(a: Img, b: Img, x0: number, y0: number, x1: number, y1: number, skip?: (x: number, y: number) => boolean): number {
  let m = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (skip?.(x, y)) continue
      const i = (y * W + x) * 4
      for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(a[i + c] - b[i + c]))
    }
  }
  return m
}

function meanLuma(d: Img, x0: number, y0: number, x1: number, y1: number): number {
  let s = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += luma(d, (y * W + x) * 4)
  return s / Math.max(1, (x1 - x0) * (y1 - y0))
}

/** Centro de massa (x normalizado) dos pixels cuja luma difere mais que `thr` entre a e b. */
function diffCentroidX(a: Img, b: Img, thr: number): { cx: number; n: number } {
  let sx = 0
  let n = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      if (Math.abs(luma(a, i) - luma(b, i)) > thr) {
        sx += x + 0.5
        n++
      }
    }
  }
  return { cx: n ? sx / n / W : NaN, n }
}

/**
 * Blocos da pixelização inteiramente dentro da região (grade presa ao quadro, célula pelo centro do pixel): lista
 * de pixels [x, y] (y para baixo) de cada bloco.
 */
function fullBlocks(r: Region, cell: number): [number, number][][] {
  const px0 = (r.x - r.w / 2) * W
  const px1 = (r.x + r.w / 2) * W
  const py0 = (r.y - r.h / 2) * H
  const py1 = (r.y + r.h / 2) * H
  const out: [number, number][][] = []
  for (let j = Math.ceil(py0 / cell); (j + 1) * cell <= py1; j++) {
    for (let i = Math.ceil(px0 / cell); (i + 1) * cell <= px1; i++) {
      const b: [number, number][] = []
      for (let y = Math.ceil(j * cell - 0.5); y + 0.5 < (j + 1) * cell; y++) for (let x = Math.ceil(i * cell - 0.5); x + 0.5 < (i + 1) * cell; x++) b.push([x, y])
      out.push(b)
    }
  }
  return out
}

interface Box { x0: number; y0: number; x1: number; y1: number }

/** Caixa dos pixels claros (texto branco, luma > 128) entre as linhas y0 e y1. */
function brightBox(d: Img, y0: number, y1: number): Box | null {
  let b: Box | null = null
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < W; x++) {
      if (luma(d, (y * W + x) * 4) <= 128) continue
      b = b ? { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) } : { x0: x, y0: y, x1: x, y1: y }
    }
  }
  return b
}

/** Contraste local da linha de texto (como o E2E F2): caixa 3×3 na luma e p99 − p1 dentro da caixa + 4 px. */
function localContrast(d: Img, b: Box, pad = 4): number {
  const vals: number[] = []
  for (let y = Math.max(1, b.y0 - pad); y <= Math.min(H - 2, b.y1 + pad); y++) {
    for (let x = Math.max(1, b.x0 - pad); x <= Math.min(W - 2, b.x1 + pad); x++) {
      let s = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += luma(d, ((y + dy) * W + x + dx) * 4)
      vals.push(s / 9)
    }
  }
  vals.sort((p, q) => p - q)
  const at = (q: number): number => vals[Math.min(vals.length - 1, Math.floor(q * (vals.length - 1)))]
  return at(0.99) - at(0.01)
}

/** Variância do laplaciano (4 vizinhos) da luma na caixa + 4 px (como o E2E F2). */
function lapVar(d: Img, b: Box, pad = 4): number {
  let n = 0
  let s = 0
  let s2 = 0
  const L = (x: number, y: number): number => luma(d, (y * W + x) * 4)
  for (let y = Math.max(1, b.y0 - pad); y <= Math.min(H - 2, b.y1 + pad); y++) {
    for (let x = Math.max(1, b.x0 - pad); x <= Math.min(W - 2, b.x1 + pad); x++) {
      const l = 4 * L(x, y) - L(x - 1, y) - L(x + 1, y) - L(x, y - 1) - L(x, y + 1)
      n++
      s += l
      s2 += l * l
    }
  }
  return s2 / n - (s / n) ** 2
}

/** Nome da GPU (WebGL2 desta página: o worker usa o mesmo adaptador). */
function rendererName(): string {
  const gl = document.createElement('canvas').getContext('webgl2')
  if (!gl) return '?'
  const ext = gl.getExtension('WEBGL_debug_renderer_info')
  return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
}

function stats(xs: number[]): { n: number; median: number; p95: number; max: number } {
  const s = [...xs].sort((a, b) => a - b)
  const r = (v: number): number => Math.round(v * 100) / 100
  return { n: s.length, median: r(s[Math.floor(s.length / 2)] ?? 0), p95: r(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0), max: r(s[s.length - 1] ?? 0) }
}

export async function effectsCheck(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  canvas.style.width = '480px'
  document.body.appendChild(canvas)
  const client = new RenderClient(canvas, { width: W, height: H, dpr: 1 })
  try {
    await client.ready
    const base = await window.api.project.load(EFFECTS_PROJECT_ID)
    const withTracks = (...tracks: Track[]): Project => ({ ...base, tracks: [...base.tracks, ...tracks] })
    const frame = async (p: Project, tUs: number): Promise<Img> => {
      client.setProject(p, mediaUrlsFor(p, 'preview'), true)
      const r = await client.requestFrame(tUs, false)
      if (r.t !== 'rendered') throw new Error(`quadro ${tUs}: ${JSON.stringify(r)}`)
      return client.readPixels(0, 0, W, H)
    }

    // ---- 4 efeitos em quadrantes (t = 1 s) ----
    const blur = effect('blur', { x: 0.25, y: 0.25, w: 0.3, h: 0.3 })
    const pix = effect('pixelate', { x: 0.75, y: 0.25, w: 0.3, h: 0.3 })
    const solid = effect('solid', { x: 0.25, y: 0.75, w: 0.3, h: 0.3 }, { color: '#123456', feather: 0 })
    const ell = effect('blur', { x: 0.75, y: 0.75, w: 0.3, h: 0.3, rotation: 30, shape: 'ellipse' }, { feather: 0 })
    const ref = await frame(base, 1_000_000)
    const quad = await frame(withTracks(fxTrack('t_blur', blur), fxTrack('t_pix', pix), fxTrack('t_solid', solid), fxTrack('t_ell', ell)), 1_000_000)

    const rb = regionOf(blur)
    const bx = boxTopDown(rb, 0, 0)
    out.blurDetail = { ref: detailEnergy(ref, bx.x0, bx.y0, bx.x1, bx.y1), fx: detailEnergy(quad, bx.x0, bx.y0, bx.x1, bx.y1) }
    const boxes = [blur, pix, solid, ell].map((e) => boxTopDown(regionOf(e), e.feather, 2))
    out.outsideMaxDiff = maxDiff(ref, quad, 0, 0, W, H, (x, y) => boxes.some((b) => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1))

    // pixelização: grade presa ao quadro (célula pelo centro do pixel), só blocos inteiros dentro da região
    const rp = regionOf(pix)
    // bloco quantizado como no compositor (1/256 px): q/256 é exato em double, as contas abaixo também
    const cell = pixelCellQ(effectPixelBlockPx(pix.strength.value, rp, W, H, pix.invert)) / 256
    const px0 = (rp.x - rp.w / 2) * W
    const px1 = (rp.x + rp.w / 2) * W
    const py0 = (rp.y - rp.h / 2) * H
    const py1 = (rp.y + rp.h / 2) * H
    let blocks = 0
    let maxDev = 0
    for (let j = Math.ceil(py0 / cell); (j + 1) * cell <= py1; j++) {
      for (let i = Math.ceil(px0 / cell); (i + 1) * cell <= px1; i++) {
        blocks++
        const lo = [255, 255, 255]
        const hi = [0, 0, 0]
        for (let y = Math.ceil(j * cell - 0.5); y + 0.5 < (j + 1) * cell; y++) {
          for (let x = Math.ceil(i * cell - 0.5); x + 0.5 < (i + 1) * cell; x++) {
            const k = (y * W + x) * 4
            for (let c = 0; c < 3; c++) {
              lo[c] = Math.min(lo[c], quad[k + c])
              hi[c] = Math.max(hi[c], quad[k + c])
            }
          }
        }
        maxDev = Math.max(maxDev, ...hi.map((h, c) => h - lo[c]))
      }
    }
    out.pixelate = { blocks, maxDev, changedMaxDiff: maxDiff(ref, quad, Math.ceil(px0), Math.ceil(py0), Math.floor(px1), Math.floor(py1)), cell }

    // tarja: todo pixel com centro dentro da região tem a cor exata
    const rs = regionOf(solid)
    let pixels = 0
    let wrong = 0
    for (let y = 0; y < H; y++) {
      if (y + 0.5 <= (rs.y - rs.h / 2) * H || y + 0.5 >= (rs.y + rs.h / 2) * H) continue
      for (let x = 0; x < W; x++) {
        if (x + 0.5 <= (rs.x - rs.w / 2) * W || x + 0.5 >= (rs.x + rs.w / 2) * W) continue
        const k = (y * W + x) * 4
        pixels++
        if (quad[k] !== 0x12 || quad[k + 1] !== 0x34 || quad[k + 2] !== 0x56) wrong++
      }
    }
    const sk = (Math.round(rs.y * H) * W + Math.round(rs.x * W)) * 4
    out.solid = { pixels, wrong, sample: [quad[sk], quad[sk + 1], quad[sk + 2]] }

    // elipse rotacionada: o canto da caixa fica fora da elipse; o centro é borrado
    const re = regionOf(ell)
    const eb = boxTopDown(re, 0, 0)
    const cx = Math.round(re.x * W)
    const cy = Math.round(re.y * H)
    out.ellipse = {
      cornerDiff: maxDiff(ref, quad, eb.x0, eb.y0, eb.x0 + 4, eb.y0 + 4),
      centerDetail: { ref: detailEnergy(ref, cx - 80, cy - 80, cx + 80, cy + 80), fx: detailEnergy(quad, cx - 80, cy - 80, cx + 80, cy + 80) }
    }

    // ---- invertido: borra tudo menos a região ----
    const inv = effect('blur', { x: 0.5, y: 0.5, w: 0.3, h: 0.3 }, { invert: true, feather: 0 })
    const invImg = await frame(withTracks(fxTrack('t_inv', inv)), 1_000_000)
    out.invert = {
      centerMaxDiff: maxDiff(ref, invImg, W / 2 - 100, H / 2 - 60, W / 2 + 100, H / 2 + 60),
      cornerDetail: { ref: detailEnergy(ref, 0, 0, 320, 240), fx: detailEnergy(invImg, 0, 0, 320, 240) }
    }

    // ---- região meio fora do quadro (x + w/2 > 1): clamp de amostragem, sem borda preta ----
    const half = effect('blur', { x: 0.95, y: 0.5, w: 0.3, h: 0.4 }, { feather: 0 })
    const halfImg = await frame(withTracks(fxTrack('t_half', half)), 1_000_000)
    const hx0 = Math.ceil(0.8 * W)
    const hy0 = Math.ceil(0.3 * H)
    const hy1 = Math.floor(0.7 * H)
    const hb = boxTopDown(regionOf(half), 0, 2)
    out.halfOutside = {
      detail: { ref: detailEnergy(ref, hx0, hy0, W, hy1), fx: detailEnergy(halfImg, hx0, hy0, W, hy1) },
      edgeMean: meanLuma(halfImg, W - 4, hy0, W, hy1),
      refBandMean: meanLuma(ref, W - 52, hy0, W, hy1),
      outsideMaxDiff: maxDiff(ref, halfImg, 0, 0, W, H, (x, y) => x >= hb.x0 && y >= hb.y0 && y < hb.y1)
    }

    // ---- keyframe region.x 0,2 → 0,8 entre 1 s e 3 s, sobre ruído (detalhe em todo pixel) ----
    const noiseAsset = base.assets.find((a) => a.id === 'a_noise')!
    const noiseItem = { ...createMediaItem(noiseAsset, 0, 'video'), durationUs: 4_000_000 }
    const moving = effect('blur', { x: 0.2, y: 0.5, w: 0.2, h: 0.3 }, {}, 4_000_000)
    moving.region = { ...moving.region, x: { value: 0.2, keys: [{ tUs: 1_000_000, value: 0.2, ease: 'linear' }, { tUs: 3_000_000, value: 0.8, ease: 'linear' }] } }
    const noiseOnly: Project = { ...base, tracks: [fxTrack('t_noise', noiseItem)] }
    const noiseRef = await frame(noiseOnly, 2_000_000)
    const withMoving: Project = { ...noiseOnly, tracks: [...noiseOnly.tracks, fxTrack('t_move', moving)] }
    const at2 = diffCentroidX(noiseRef, await frame(withMoving, 2_000_000), 24)
    const at1 = diffCentroidX(noiseRef, await frame(withMoving, 1_000_000), 24)
    out.keyframe = { centroidX: at2.cx, centroidX1s: at1.cx, maskPixels: at2.n }

    // ---- escopo track: tarja só na camada logo abaixo (imagem vermelha), não no vídeo do fundo ----
    const redAsset = base.assets.find((a) => a.id === 'a_red')!
    const red = { ...createMediaItem(redAsset, 0, 'video'), durationUs: DUR }
    const redItem: MediaItem = { ...red, visual: { ...red.visual!, transform: { ...red.visual!.transform, scale: { value: 0.25 } } } }
    const scoped = effect('solid', { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, { color: '#123456', feather: 0, scope: 'track' })
    const trackImg = await frame(withTracks(fxTrack('t_red', redItem), fxTrack('t_scoped', scoped)), 1_000_000)
    const ck = ((H / 2) * W + W / 2) * 4
    // vídeo entre a borda da camada (270 px de lado) e a borda da região
    out.track = { insideLayer: [trackImg[ck], trackImg[ck + 1], trackImg[ck + 2]], outsideLayerDiff: maxDiff(ref, trackImg, Math.round(0.3 * W), Math.round(0.3 * H), Math.round(0.4 * W), Math.round(0.7 * H)) }
    // faixa logo abaixo sem item (lacuna): o efeito não pega a camada de uma faixa mais baixa → nada muda
    const gapImg = await frame(withTracks({ ...fxTrack('t_gap', redItem), items: [] }, fxTrack('t_scoped', scoped)), 1_000_000)
    // faixa oculta no meio é pulada: a camada da faixa visível logo abaixo recebe a tarja
    const hiddenImg = await frame(withTracks(fxTrack('t_red', redItem), { ...fxTrack('t_oculta', { ...redItem, id: 'i_oculta' }), hidden: true }, fxTrack('t_scoped', scoped)), 1_000_000)
    out.trackGap = { maxDiff: maxDiff(ref, gapImg, 0, 0, W, H), hiddenSkipped: [hiddenImg[ck], hiddenImg[ck + 1], hiddenImg[ck + 2]] }

    // ---- invertido com feather: a borda suave fica DENTRO da região; logo fora já é 100 % blur ----
    const invF = effect('blur', { x: 0.5, y: 0.5, w: 0.3, h: 0.3 }, { invert: true, feather: 0.3 })
    const invFImg = await frame(withTracks(fxTrack('t_invf', invF)), 1_000_000)
    const fpx = featherPx(regionOf(invF), invF.feather, W, H)
    const rx1 = Math.ceil(0.65 * W)
    const ry0 = Math.ceil(0.35 * H)
    const ry1 = Math.floor(0.65 * H)
    out.invertFeather = {
      featherPx: fpx,
      // faixa de 1–6 px fora da borda direita: igual ao invertido sem feather (onde fora é efeito inteiro)
      justOutsideDiff: maxDiff(invImg, invFImg, rx1 + 1, ry0, rx1 + 6, ry1),
      justOutsideVsRef: maxDiff(ref, invFImg, rx1 + 1, ry0, rx1 + 6, ry1),
      // miolo (região menos o feather): intocado
      centerMaxDiff: maxDiff(ref, invFImg, Math.ceil(0.35 * W + fpx) + 1, Math.ceil(ry0 + fpx) + 1, Math.floor(0.65 * W - fpx) - 1, Math.floor(ry1 - fpx) - 1)
    }

    // ---- retângulo rotacionado e elipse excêntrica com feather: a cauda do feather termina dentro do scissor ----
    const rotRect = effect('blur', { x: 0.3, y: 0.35, w: 0.25, h: 0.12, rotation: 30 }, { feather: 0.4, strength: { value: 100 } })
    const ellF = effect('blur', { x: 0.7, y: 0.65, w: 0.35, h: 0.06, rotation: 25, shape: 'ellipse' }, { feather: 0.8, strength: { value: 100 } })
    const tailImg = await frame(withTracks(fxTrack('t_rot', rotRect), fxTrack('t_ellf', ellF)), 1_000_000)
    const ring = (e: EffectItem, other: EffectItem): number => {
      const sc = regionScissor({ ...regionOf(e), shape: e.region.shape }, e.feather, W, H)
      const x0 = sc.x
      const x1 = sc.x + sc.w
      const y0 = H - (sc.y + sc.h)
      const y1 = H - sc.y
      // as caixas das duas regiões se cruzam: pixels dentro da outra região + feather são efeito legítimo dela
      // (com o raio pela região, o blur forte do retângulo muda a cor ali), não corte da cauda
      const ro = { ...regionOf(other), shape: other.region.shape }
      const fo = featherPx(ro, other.feather, W, H)
      const skip = (x: number, y: number): boolean => regionDistPx(ro, x + 0.5, y + 0.5, W, H) < fo + 1
      // 1ª e última linha/coluna dentro da caixa (onde um corte da cauda apareceria como degrau)
      return Math.max(maxDiff(ref, tailImg, x0, y0, x1, y0 + 1, skip), maxDiff(ref, tailImg, x0, y1 - 1, x1, y1, skip), maxDiff(ref, tailImg, x0, y0, x0 + 1, y1, skip), maxDiff(ref, tailImg, x1 - 1, y0, x1, y1, skip))
    }
    const tailBoxes = [rotRect, ellF].map((e) => boxTopDown({ ...regionOf(e), shape: e.region.shape }, e.feather, 0))
    out.featherTail = {
      rectRing: ring(rotRect, ellF),
      ellipseRing: ring(ellF, rotRect),
      outsideMaxDiff: maxDiff(ref, tailImg, 0, 0, W, H, (x, y) => tailBoxes.some((b) => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1)),
      // o efeito agiu dentro de cada caixa (bordas das barras do testsrc2 borradas)
      changed: tailBoxes.map((b) => maxDiff(ref, tailImg, b.x0, b.y0, b.x1, b.y1))
    }

    // ---- pixelização = média do bloco: ruído andando sob a grade fixa (quadro a quadro, pontos diferentes) ----
    const nv = noiseItem.visual!
    const noiseMoving: MediaItem = { ...noiseItem, visual: { ...nv, transform: { ...nv.transform, x: { value: 0.5, keys: [{ tUs: 0, value: 0.45, ease: 'linear' }, { tUs: 4_000_000, value: 0.55, ease: 'linear' }] } } } }
    const movingOnly: Project = { ...base, tracks: [fxTrack('t_noise', noiseMoving)] }
    const pixN = effect('pixelate', { x: 0.5, y: 0.5, w: 0.3, h: 0.3 }, {}, 4_000_000)
    const rn = regionOf(pixN)
    const ncell = pixelCellQ(effectPixelBlockPx(pixN.strength.value, rn, W, H, false)) / 256
    const pm = { blocks: 0, maxErr: 0, maxDev: 0, cell: ncell }
    for (const t of [1_000_000, 1_033_333]) {
      const src = await frame(movingOnly, t)
      const img = await frame({ ...movingOnly, tracks: [...movingOnly.tracks, fxTrack('t_pixn', pixN)] }, t)
      for (const b of fullBlocks(rn, ncell)) {
        const sum = [0, 0, 0]
        let n = 0
        const lo = [255, 255, 255]
        const hi = [0, 0, 0]
        for (const [x, y] of b) {
          const k = (y * W + x) * 4
          for (let c = 0; c < 3; c++) {
            sum[c] += src[k + c]
            lo[c] = Math.min(lo[c], img[k + c])
            hi[c] = Math.max(hi[c], img[k + c])
          }
          n++
        }
        const [cx0, cy0] = b[Math.floor(b.length / 2)]
        const kc = (cy0 * W + cx0) * 4
        pm.blocks++
        pm.maxErr = Math.max(pm.maxErr, ...sum.map((s, c) => Math.abs(s / n - img[kc + c])))
        pm.maxDev = Math.max(pm.maxDev, ...hi.map((h, c) => h - lo[c]))
      }
    }
    pm.maxErr = Math.round(pm.maxErr * 100) / 100
    out.pixelateMean = pm

    // ---- "Borrar tudo menos…" sobre texto de 47 px fora da região (mesma métrica de legibilidade do E2E) ----
    const textAsset = base.assets.find((a) => a.id === 'a_text')!
    const textOnly: Project = { ...base, tracks: [fxTrack('t_text', { ...createMediaItem(textAsset, 0, 'video'), durationUs: DUR })] }
    const tRef = await frame(textOnly, 1_000_000)
    const lines = [brightBox(tRef, 150, 320), brightBox(tRef, 760, 960)].filter((b): b is Box => !!b)
    const byStrength: { strength: number; lines: { c: number; lap: number }[] }[] = []
    let centerMaxDiff = 0
    for (const s of [80, 50, 35, 20]) {
      const inv2 = effect('blurAllExcept', { x: 0.5, y: 0.5, w: 0.3, h: 0.1 }, s === 80 ? {} : { strength: { value: s } })
      const img = await frame({ ...textOnly, tracks: [...textOnly.tracks, fxTrack('t_inv2', inv2)] }, 1_000_000)
      const r3 = (v: number): number => Math.round(v * 1e4) / 1e4
      byStrength.push({ strength: inv2.strength.value, lines: lines.map((b) => ({ c: r3(localContrast(img, b) / localContrast(tRef, b)), lap: r3(lapVar(img, b) / lapVar(tRef, b)) })) })
      // miolo (região menos a borda suave para dentro): idêntico
      if (s === 80) centerMaxDiff = maxDiff(tRef, img, Math.ceil(0.35 * W) + 40, Math.ceil(0.45 * H) + 40, Math.floor(0.65 * W) - 40, Math.floor(0.55 * H) - 40)
    }
    out.invertText = { boxes: lines.length, byStrength, centerMaxDiff }

    // ---- desempenho: 1080p, reprodução sequencial, sem efeito × 3 blurs fortes (intensidade 100) ----
    client.setProject(base, mediaUrlsFor(base, 'preview'), true)
    const b0 = await client.testBench(0, 60, 30)
    const strong = (x: number, y: number): EffectItem => effect('blur', { x, y, w: 0.3, h: 0.3 }, { strength: { value: 100 } })
    const p3 = withTracks(fxTrack('t_b1', strong(0.25, 0.3)), fxTrack('t_b2', strong(0.6, 0.5)), fxTrack('t_b3', strong(0.8, 0.75)))
    client.setProject(p3, mediaUrlsFor(p3, 'preview'), true)
    const b3 = await client.testBench(0, 60, 30)
    // FBOs de efeito liberados após 120 quadros sem efeito: o próximo quadro com efeito realoca e sai igual
    client.setProject(base, mediaUrlsFor(base, 'preview'), true)
    await client.testBench(0, 125, 60)
    const again = await frame(withTracks(fxTrack('t_blur', blur), fxTrack('t_pix', pix), fxTrack('t_solid', solid), fxTrack('t_ell', ell)), 1_000_000)
    out.realloc = { maxDiff: maxDiff(quad, again, 0, 0, W, H) }
    out.bench = { renderer: rendererName(), noFx: stats(b0.drawMs.slice(5)), fx3: stats(b3.drawMs.slice(5)), fx3Frame: stats(b3.frameMs.slice(5)), ...(b0.error || b3.error ? { error: b0.error ?? b3.error } : {}) }
  } catch (e) {
    out.error = e instanceof Error ? (e.stack ?? e.message) : String(e)
  } finally {
    client.dispose()
    canvas.remove()
  }
  return out
}
