// Pose de uma região de efeito no espaço do conteúdo de um clipe de mídia (pura). A privacidade (transformedUnderEffect,
// unlinkedOverMoving) e o "Ajustar efeitos ao movimento" (followTransform) usam esta mesma conta: o ajuste leva a
// região de volta ao quadro pela inversa exata, então o aviso some por construção.
import { evalAnim } from './anim'
import { layerBase, type LayerBase } from './layerGeometry'
import type { Anim, EffectItem, MediaItem, Project, Us } from './project'
import { visualStateAt } from './resolve'
import { itemEndUs } from './time'

/** Região no quadro (normalizada, centro) e rotação em graus — os valores de EffectRegion num instante. */
export interface RegionValues { x: number; y: number; w: number; h: number; rotation: number }

/** Geometria do clipe num instante: centro (normalizado), rotação, tamanho da camada (px do quadro), espelho e base. */
export interface ClipFrame { cx: number; cy: number; rotation: number; sx: number; sy: number; mirror: boolean; g: LayerBase }

/**
 * Pose da região no espaço do conteúdo: ponto da fonte exibida (px) sob o centro, tamanho em px da fonte e rotação
 * relativa à do clipe; fx/fy = px do quadro por px da fonte (para medir desvios na tela).
 */
export interface ContentPose { qx: number; qy: number; w: number; h: number; rot: number; fx: number; fy: number }

const animated = (...as: Anim<number>[]): boolean => as.some((a) => (a.keys?.length ?? 0) > 0)

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

/** Valores da região do efeito no instante absoluto `at`. */
export function regionValuesAt(fx: EffectItem, at: Us): RegionValues {
  const r = fx.region, lf = at - fx.startUs
  return { x: evalAnim(r.x, lf), y: evalAnim(r.y, lf), w: evalAnim(r.w, lf), h: evalAnim(r.h, lf), rotation: evalAnim(r.rotation, lf) }
}

/**
 * Geometria do clipe no instante absoluto `at` (geometria do resolve, com animações de entrada/saída, e fit/corte por
 * layerBase — a mesma conta do compositor). null = conteúdo invisível (escala ~0) ou clipe sem propriedades visuais.
 */
export function clipFrameAt(p: Project, m: MediaItem, at: Us): ClipFrame | null {
  const v = m.visual
  if (!v) return null
  const W = p.canvas.width, H = p.canvas.height
  // fonte exibida (sem dados de vídeo: o próprio quadro)
  const info = p.assets.find((x) => x.id === m.assetId)?.video
  const src = info && info.width > 0 && info.height > 0 ? { w: info.width, h: info.height, rotation: info.rotation } : { w: W, h: H, rotation: 0 as const }
  const local = at - m.startUs
  const rect = visualStateAt(v, m.durationUs, local).rect
  const c = v.crop
  const g = layerBase({ l: evalAnim(c.l, local), t: evalAnim(c.t, local), r: evalAnim(c.r, local), b: evalAnim(c.b, local) }, v.fit, src, { w: W, h: H })
  const sx = g.bw * rect.scale, sy = g.bh * rect.scale
  if (sx < 1e-6 || sy < 1e-6) return null
  return { cx: rect.cx, cy: rect.cy, rotation: rect.rotation, sx, sy, mirror: !!v.mirror, g }
}

/** Região do quadro → pose no espaço do conteúdo (como matrix.layerMatrix: R(−θ)·(região − centro) / tamanho). */
export function contentPose(cf: ClipFrame, r: RegionValues, W: number, H: number): ContentPose {
  const dx = (r.x - cf.cx) * W, dy = (r.y - cf.cy) * H
  const th = (cf.rotation * Math.PI) / 180, cos = Math.cos(th), sin = Math.sin(th)
  // quad local da camada (−½..½); espelhar inverte x
  let ax = (cos * dx + sin * dy) / cf.sx
  const ay = (-sin * dx + cos * dy) / cf.sy
  if (cf.mirror) ax = -ax
  const g = cf.g
  const [u0, v0, u1, v1] = g.uv
  const fx = cf.sx / g.cw, fy = cf.sy / g.ch
  return {
    qx: (u0 + (ax + 0.5) * (u1 - u0)) * g.dw, qy: (v0 + (ay + 0.5) * (v1 - v0)) * g.dh,
    w: (Math.abs(r.w) * W) / fx, h: (Math.abs(r.h) * H) / fy,
    rot: r.rotation - cf.rotation, fx, fy
  }
}

/** Inversa de contentPose: a região do quadro que cobre a pose `q` do conteúdo com o clipe na geometria `cf`. */
export function regionFromPose(cf: ClipFrame, q: Pick<ContentPose, 'qx' | 'qy' | 'w' | 'h' | 'rot'>, W: number, H: number): RegionValues {
  const g = cf.g
  const [u0, v0, u1, v1] = g.uv
  let ax = (q.qx / g.dw - u0) / (u1 - u0) - 0.5
  const ay = (q.qy / g.dh - v0) / (v1 - v0) - 0.5
  if (cf.mirror) ax = -ax
  const lx = ax * cf.sx, ly = ay * cf.sy
  const th = (cf.rotation * Math.PI) / 180, cos = Math.cos(th), sin = Math.sin(th)
  const fx = cf.sx / g.cw, fy = cf.sy / g.ch
  return {
    x: cf.cx + (cos * lx - sin * ly) / W, y: cf.cy + (sin * lx + cos * ly) / H,
    w: (q.w * fx) / W, h: (q.h * fy) / H,
    rotation: q.rot + cf.rotation
  }
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
 * A região do efeito (com a borda suave) encosta na camada do clipe neste instante? Pelas caixas alinhadas aos eixos
 * (conservador: girado pode dizer que sim sem tocar). Invertido esconde o quadro todo fora da região: sempre sim.
 */
export function regionTouchesClip(fx: EffectItem, r: RegionValues, cf: ClipFrame, W: number, H: number): boolean {
  if (fx.invert) return true
  const w = Math.abs(r.w) * W, h = Math.abs(r.h) * H
  const a = rotatedBox(r.x * W, r.y * H, w, h, r.rotation, Math.max(0, fx.feather) * Math.min(w, h) / 2)
  const b = rotatedBox(cf.cx * W, cf.cy * H, cf.sx, cf.sy, cf.rotation)
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1 && b.x1 > 0 && b.x0 < W && b.y1 > 0 && b.y0 < H
}
