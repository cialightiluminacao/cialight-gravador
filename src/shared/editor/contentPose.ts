// Geometria entre o quadro e o espaço do conteúdo de um clipe de mídia (pura, sem depender do resolve). Usada pelo
// resolve (efeito ancorado: região guardada no espaço do conteúdo, levada à tela em cada instante), pela privacidade
// (transformedUnderEffect, unlinkedOverMoving) e pelas operações de ancorar/desancorar (followTransform).
import type { LayerBase } from './layerGeometry'
import type { Anim, EffectItem, MediaItem, Us } from './project'
import { itemEndUs } from './time'

/**
 * Região: centro, tamanho e rotação (graus). No quadro: normalizada ao quadro. Ancorada (espaço do conteúdo): centro
 * e tamanho em fração da fonte exibida (já girada, sem corte) e rotação no espaço da fonte.
 */
export interface RegionValues { x: number; y: number; w: number; h: number; rotation: number }

/**
 * Geometria do clipe num instante: centro (normalizado), rotação, tamanho da camada (px do quadro), espelho, base
 * (fit/corte) e o tamanho do quadro W×H (px).
 */
export interface ClipFrame { cx: number; cy: number; rotation: number; sx: number; sy: number; mirror: boolean; g: LayerBase; W: number; H: number }

/**
 * Buraco nulo: região de tamanho 0 no canto (0, 0) do quadro. O canto cai sempre entre pixels (em qualquer resolução
 * de saída), então nenhum centro de pixel fica dentro dela — invertido, o efeito cobre o quadro inteiro.
 */
export const NO_HOLE: RegionValues = { x: 0, y: 0, w: 0, h: 0, rotation: 0 }

/**
 * Região estática do quadro, conservadora, para um efeito ancorado cuja região exata não dá para desenhar (âncora
 * perdida, instante fora do clipe, disco lido pela v1.3, efeito colado sem o clipe). `box`: a caixa que envolve a
 * região ao longo do clipe (anchoredUnion; null = desconhecida).
 * - Normal (esconde a região): esconder MAIS é o seguro → a caixa (elipse: a que a contém, ×√2); sem caixa, o quadro
 *   inteiro (elipse ×√2).
 * - Invertido (`invert`: a região é o buraco que fica nítido, todo o resto é escondido): uma região maior seria um
 *   buraco maior, vazando o que está em volta. O seguro é o buraco nulo (NO_HOLE): esconde o quadro inteiro. A
 *   interseção das poses também seria segura, mas some com qualquer movimento e exige geometria a mais — o buraco
 *   nulo é simples, exato e vale em todos os caminhos.
 */
export function conservativeRegion(fx: Pick<EffectItem, 'invert' | 'region'>, box: { x: number; y: number; w: number; h: number } | null): RegionValues {
  if (fx.invert) return NO_HOLE
  const f = box ?? { x: 0.5, y: 0.5, w: 1, h: 1 }
  const k = fx.region.shape === 'ellipse' ? Math.SQRT2 : 1
  return { x: f.x, y: f.y, w: f.w * k, h: f.h * k, rotation: 0 }
}

/**
 * Pose da região no espaço do conteúdo: ponto da fonte exibida (px) sob o centro, tamanho em px da fonte e rotação
 * relativa à do clipe; fx/fy = px do quadro por px da fonte (para medir desvios na tela).
 */
export interface ContentPose { qx: number; qy: number; w: number; h: number; rot: number; fx: number; fy: number }

const animated = (...as: Anim<number>[]): boolean => as.some((a) => (a.keys?.length ?? 0) > 0)

/** A região do efeito tem keys (x, y, w, h ou rotação)? */
export const regionAnimated = (fx: EffectItem): boolean => animated(fx.region.x, fx.region.y, fx.region.w, fx.region.h, fx.region.rotation)

/**
 * O clipe move o conteúdo no quadro: x/y/escala/rotação ou corte com keys, ou animação de entrada/saída que não é só
 * fade. zoom/pop ainda não têm geometria no resolve (F4 Task 5 a põe em visualStateAt) e por ora não movem nada.
 */
export function clipMoves(m: MediaItem): boolean {
  const v = m.visual
  if (!v) return false
  const t = v.transform
  return animated(t.x, t.y, t.scale, t.rotation, v.crop.l, v.crop.t, v.crop.r, v.crop.b) || (!!v.animIn && v.animIn.preset !== 'fade') || (!!v.animOut && v.animOut.preset !== 'fade')
}

/** Região do quadro → pose no espaço do conteúdo (como matrix.layerMatrix: R(−θ)·(região − centro) / tamanho). */
export function contentPose(cf: ClipFrame, r: RegionValues): ContentPose {
  const { W, H } = cf
  const q = toSource(cf, r.x * W, r.y * H)
  const g = cf.g
  const fx = cf.sx / g.cw, fy = cf.sy / g.ch
  return { qx: q.x, qy: q.y, w: (Math.abs(r.w) * W) / fx, h: (Math.abs(r.h) * H) / fy, rot: r.rotation - cf.rotation, fx, fy }
}

/**
 * Desvio de `cur` em relação a `ref`, medido na tela com a escala de `cur`: px = o maior entre o deslocamento do centro
 * e a diferença de largura e de altura (px do quadro); deg = diferença de rotação (graus, 0–180).
 */
export function poseError(ref: ContentPose, cur: ContentPose): { px: number; deg: number } {
  const deg = Math.abs(((((cur.rot - ref.rot) % 360) + 540) % 360) - 180)
  const px = Math.max(Math.hypot((cur.qx - ref.qx) * cur.fx, (cur.qy - ref.qy) * cur.fy), Math.abs(cur.w - ref.w) * cur.fx, Math.abs(cur.h - ref.h) * cur.fy)
  return { px, deg }
}

/** Ponto da fonte exibida (px) → ponto do quadro (px). */
export function toScreen(cf: ClipFrame, qx: number, qy: number): { x: number; y: number } {
  const g = cf.g
  const [u0, v0, u1, v1] = g.uv
  let ax = (qx / g.dw - u0) / (u1 - u0) - 0.5
  const ay = (qy / g.dh - v0) / (v1 - v0) - 0.5
  if (cf.mirror) ax = -ax
  const lx = ax * cf.sx, ly = ay * cf.sy
  const th = (cf.rotation * Math.PI) / 180, cos = Math.cos(th), sin = Math.sin(th)
  return { x: cf.cx * cf.W + cos * lx - sin * ly, y: cf.cy * cf.H + sin * lx + cos * ly }
}

/** Ponto do quadro (px) → ponto da fonte exibida (px). */
function toSource(cf: ClipFrame, X: number, Y: number): { x: number; y: number } {
  const dx = X - cf.cx * cf.W, dy = Y - cf.cy * cf.H
  const th = (cf.rotation * Math.PI) / 180, cos = Math.cos(th), sin = Math.sin(th)
  let ax = (cos * dx + sin * dy) / cf.sx
  const ay = (-sin * dx + cos * dy) / cf.sy
  if (cf.mirror) ax = -ax
  const g = cf.g
  const [u0, v0, u1, v1] = g.uv
  return { x: (u0 + (ax + 0.5) * (u1 - u0)) * g.dw, y: (v0 + (ay + 0.5) * (v1 - v0)) * g.dh }
}

/** Fonte → quadro preserva ângulos (escala igual nos dois eixos, com ou sem espelho)? */
const conformal = (cf: ClipFrame): boolean => {
  const fx = cf.sx / cf.g.cw, fy = cf.sy / cf.g.ch
  return Math.abs(fx - fy) <= 1e-9 * Math.max(fx, fy)
}

/**
 * Retângulo (centro c, meia-largura hw, meia-altura hh, ângulo a em graus) → seus 4 cantos.
 */
function corners(cx: number, cy: number, hw: number, hh: number, deg: number): { x: number; y: number }[] {
  const t = (deg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t)
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => ({ x: cx + cos * i * hw - sin * j * hh, y: cy + sin * i * hw + cos * j * hh }))
}

/** Meias-extensões dos pontos em torno de c ao longo dos eixos girados `deg`. */
function extents(pts: { x: number; y: number }[], c: { x: number; y: number }, deg: number): [number, number] {
  const t = (deg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t)
  let ex = 0, ey = 0
  for (const p of pts) {
    const dx = p.x - c.x, dy = p.y - c.y
    ex = Math.max(ex, Math.abs(cos * dx + sin * dy))
    ey = Math.max(ey, Math.abs(-sin * dx + cos * dy))
  }
  return [ex, ey]
}

/** Folga da região ancorada na tela (px de cada lado): conservadora contra arredondamentos. */
export const ATTACH_PAD_PX = 1

/**
 * Como a região ancorada vai à tela. 'cover' (efeito normal: a região é o que se esconde) — maior é o seguro: a região
 * que CONTÉM a imagem exata. 'hole' (efeito invertido: a região é o buraco nítido) — menor é o seguro: a região
 * CONTIDA na imagem exata.
 */
export type RegionFit = 'cover' | 'hole'

/** Norma espectral (maior valor singular) da matriz 2×2 [a b; c d]. */
function spectralNorm(a: number, b: number, c: number, d: number): number {
  const t = a * a + b * b + c * c + d * d, det = a * d - b * c
  return Math.sqrt((t + Math.sqrt(Math.max(0, t * t - 4 * det * det))) / 2)
}

/**
 * Região ancorada (espaço do conteúdo) → região do quadro com o clipe na geometria `cf`, no ângulo da região na tela
 * (rotação do clipe ± a da região; espelho inverte). A imagem exata da região é a região do conteúdo pelo afim do
 * clipe: igual a ela (girada, escalada) quando o clipe tem a mesma escala nos dois eixos; um paralelogramo / elipse
 * torta quando não (fit esticar com corte desproporcional).
 * - 'cover': o retângulo que envolve os 4 cantos levados à tela; elipse num mapeamento não conforme cresce √2 (a que
 *   contém o retângulo); + `pad` px de cada lado.
 * - 'hole': a maior região da mesma proporção da exata (λ·|M₁₁|·hw, λ·|M₂₂|·hh no sistema da região na tela) contida
 *   nela — M = afim no sistema da região (conteúdo) → sistema da região (tela), N = M⁻¹. Retângulo: os 4 cantos de
 *   N·retângulo dentro de [−hw, hw]×[−hh, hh] (convexo ⇒ tudo dentro). Elipse: N·elipse dentro da elipse do conteúdo
 *   ⇔ ‖diag(1/hw, 1/hh)·N·diag(ex, ey)‖₂ ≤ 1. No caso conforme λ = 1 (exata). − `pad` px de cada lado.
 */
export function contentToScreen(cf: ClipFrame, c: RegionValues, shape: 'rect' | 'ellipse', pad = ATTACH_PAD_PX, fit: RegionFit = 'cover'): RegionValues {
  const { g, W, H } = cf
  const qx = c.x * g.dw, qy = c.y * g.dh
  const center = toScreen(cf, qx, qy)
  const a = cf.rotation + (cf.mirror ? -c.rotation : c.rotation)
  const hw = (Math.abs(c.w) * g.dw) / 2, hh = (Math.abs(c.h) * g.dh) / 2
  if (fit === 'hole') {
    const ra = (a * Math.PI) / 180, ca = Math.cos(ra), sa = Math.sin(ra)
    const rp = (c.rotation * Math.PI) / 180, cp = Math.cos(rp), sp = Math.sin(rp)
    // coluna de M: o vetor unitário do sistema da região no conteúdo, na tela, no sistema da região na tela
    const col = (ux: number, uy: number): [number, number] => {
      const s = toScreen(cf, qx + cp * ux - sp * uy, qy + sp * ux + cp * uy)
      const dx = s.x - center.x, dy = s.y - center.y
      return [ca * dx + sa * dy, -sa * dx + ca * dy]
    }
    const [m11, m21] = col(1, 0), [m12, m22] = col(0, 1)
    const det = m11 * m22 - m12 * m21
    const none = { x: center.x / W, y: center.y / H, w: 0, h: 0, rotation: a }
    if (!(hw > 0 && hh > 0) || !(Math.abs(det) > 1e-12)) return none
    const n11 = m22 / det, n12 = -m12 / det, n21 = -m21 / det, n22 = m11 / det
    const ex0 = Math.abs(m11) * hw, ey0 = Math.abs(m22) * hh
    const lambda = shape === 'rect'
      ? Math.min(1, hw / (Math.abs(n11) * ex0 + Math.abs(n12) * ey0), hh / (Math.abs(n21) * ex0 + Math.abs(n22) * ey0))
      : Math.min(1, 1 / spectralNorm((n11 * ex0) / hw, (n12 * ey0) / hw, (n21 * ex0) / hh, (n22 * ey0) / hh))
    if (!(lambda > 0)) return none
    const ex = Math.max(0, lambda * ex0 - pad), ey = Math.max(0, lambda * ey0 - pad)
    return { x: center.x / W, y: center.y / H, w: (2 * ex) / W, h: (2 * ey) / H, rotation: a }
  }
  const pts = corners(qx, qy, hw, hh, c.rotation).map((p) => toScreen(cf, p.x, p.y))
  let [ex, ey] = extents(pts, center, a)
  if (shape === 'ellipse' && !conformal(cf)) { ex *= Math.SQRT2; ey *= Math.SQRT2 }
  return { x: center.x / W, y: center.y / H, w: (2 * ex + 2 * pad) / W, h: (2 * ey + 2 * pad) / H, rotation: a }
}

/**
 * Região do quadro → região ancorada (espaço do conteúdo) com o clipe na geometria `cf`: inversa de contentToScreen
 * (sem a folga; exata no mapeamento conforme, envolvente no outro).
 */
export function screenToContent(cf: ClipFrame, r: RegionValues, shape: 'rect' | 'ellipse'): RegionValues {
  const { g, W, H } = cf
  const pts = corners(r.x * W, r.y * H, (Math.abs(r.w) * W) / 2, (Math.abs(r.h) * H) / 2, r.rotation).map((p) => toSource(cf, p.x, p.y))
  const center = toSource(cf, r.x * W, r.y * H)
  const phi = cf.mirror ? -(r.rotation - cf.rotation) : r.rotation - cf.rotation
  let [ex, ey] = extents(pts, center, phi)
  if (shape === 'ellipse' && !conformal(cf)) { ex *= Math.SQRT2; ey *= Math.SQRT2 }
  return { x: center.x / g.dw, y: center.y / g.dh, w: (2 * ex) / g.dw, h: (2 * ey) / g.dh, rotation: phi }
}

/**
 * Instantes (absolutos) de [a, b) que a privacidade amostra para ver se a região acompanha o clipe: pontas, keys do
 * clipe (inclusive corte) e da região, janelas das animações de entrada/saída e 3 pontos entre cada par (curvas não
 * lineares).
 */
export function followCheckTimes(fx: EffectItem, m: MediaItem, a: Us, b: Us): Us[] {
  const v = m.visual!
  const t = v.transform, r = fx.region, c = v.crop
  const base = [a, b - 1]
  const add = (offset: Us, ...as: Anim<number>[]): void => { for (const x of as) for (const k of x.keys ?? []) base.push(offset + k.tUs) }
  add(m.startUs, t.x, t.y, t.scale, t.rotation, c.l, c.t, c.r, c.b)
  add(fx.startUs, r.x, r.y, r.w, r.h, r.rotation)
  if (v.animIn) base.push(m.startUs + v.animIn.durationUs)
  if (v.animOut) base.push(itemEndUs(m) - v.animOut.durationUs)
  const pts = [...new Set(base.filter((x) => x >= a && x < b))].sort((x, y) => x - y)
  const times: Us[] = []
  pts.forEach((x, i) => {
    times.push(x)
    const n = pts[i + 1]
    if (n !== undefined) for (let j = 1; j < 4; j++) times.push(x + Math.round(((n - x) * j) / 4))
  })
  return times
}

/** Caixa (px do quadro) de um retângulo w×h girado θ graus em torno de (cx, cy), com folga `pad`. */
function rotatedBox(cx: number, cy: number, w: number, h: number, deg: number, pad = 0): { x0: number; y0: number; x1: number; y1: number } {
  const th = (deg * Math.PI) / 180
  const ex = (Math.abs(Math.cos(th)) * w + Math.abs(Math.sin(th)) * h) / 2 + pad
  const ey = (Math.abs(Math.sin(th)) * w + Math.abs(Math.cos(th)) * h) / 2 + pad
  return { x0: cx - ex, y0: cy - ey, x1: cx + ex, y1: cy + ey }
}

/**
 * A região (do quadro) do efeito, com a borda suave, encosta na camada do clipe neste instante? Pelas caixas alinhadas
 * aos eixos (conservador: girado pode dizer que sim sem tocar). Invertido esconde o quadro todo fora da região: sim.
 */
export function regionTouchesClip(fx: EffectItem, r: RegionValues, cf: ClipFrame): boolean {
  const { W, H } = cf
  if (fx.invert) return true
  const w = Math.abs(r.w) * W, h = Math.abs(r.h) * H
  const a = rotatedBox(r.x * W, r.y * H, w, h, r.rotation, Math.max(0, fx.feather) * Math.min(w, h) / 2)
  const b = rotatedBox(cf.cx * W, cf.cy * H, cf.sx, cf.sy, cf.rotation)
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1 && b.x1 > 0 && b.x0 < W && b.y1 > 0 && b.y0 < H
}

/** Caixa alinhada aos eixos (normalizada ao quadro) que envolve a região do quadro `r`. */
export function regionAabb(r: RegionValues, W: number, H: number): { x0: number; y0: number; x1: number; y1: number } {
  const b = rotatedBox(r.x * W, r.y * H, Math.abs(r.w) * W, Math.abs(r.h) * H, r.rotation)
  return { x0: b.x0 / W, y0: b.y0 / H, x1: b.x1 / W, y1: b.y1 / H }
}
