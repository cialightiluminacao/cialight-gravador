// Geometria do visualizador (pura): caixas das camadas de mídia em pixels do canvas do projeto,
// teste de clique e a matemática da manipulação direta (snap ao centro, escala por canto, rotação);
// regiões dos efeitos de privacidade (desenhar, mover, redimensionar, guias do quadro).
import { evalAnim } from '@shared/editor/anim'
import { screenToContent } from '@shared/editor/contentPose'
import { EditError, findItem, setAnimValue } from '@shared/editor/ops'
import { attachedMedia, clipFrameAt, effectRegionAt, resolveFrame, type Layer, type TextLayer } from '@shared/editor/resolve'
import type { EffectItem, Project, Us } from '@shared/editor/project'
import { layerMatrix, type Rotation } from '../engine/compositor/matrix'
import { shapeBoxPx } from '../engine/text/shapeRaster'
import { measureTextBox, type FrameSize } from '../engine/text/textRaster'

export interface ItemBox {
  itemId: string
  /** Centro e tamanho em pixels do canvas do projeto; rotação em graus (horária). */
  cx: number
  cy: number
  w: number
  h: number
  rotation: number
}

export type Corner = 'tl' | 'tr' | 'bl' | 'br'
export interface Pt { x: number; y: number }

/** Mede a caixa de um texto (a do compositor; nos testes, um medidor sem Canvas). */
export type TextMeasure = (layer: TextLayer, frame: FrameSize) => { cx: number; cy: number; w: number; h: number; rotation: number }

/** Caixas das camadas de `layers` (fundo → topo); transição: A e B entram (o da frente na ordem de desenho é o último). */
function collectBoxes(p: Project, layers: Layer[], W: number, H: number, measure: TextMeasure, out: ItemBox[]): void {
  for (const l of layers) {
    if (l.kind === 'media') {
      const a = p.assets.find((x) => x.id === l.assetId)
      const src = { w: a?.video?.width || W, h: a?.video?.height || H, rotation: (a?.video?.rotation ?? 0) as Rotation }
      const g = layerMatrix({ rect: l.rect, fit: l.fit, crop: l.crop }, src, { w: W, h: H })
      out.push({ itemId: l.itemId, cx: l.rect.cx * W, cy: l.rect.cy * H, w: g.size[0], h: g.size[1], rotation: l.rect.rotation })
    } else if (l.kind === 'text') {
      if (!l.text) continue // o compositor não desenha texto vazio
      const b = measure(l, { W, H })
      out.push({ itemId: l.itemId, cx: b.cx, cy: b.cy, w: b.w, h: b.h, rotation: b.rotation })
    } else if (l.kind === 'shape') {
      const b = shapeBoxPx(l.item, { W, H })
      out.push({ itemId: l.itemId, cx: l.rect.cx * W, cy: l.rect.cy * H, w: b.w * l.rect.scale, h: b.h * l.rect.scale, rotation: l.rect.rotation })
    } else if (l.kind === 'transition') {
      // na 1ª metade A fica na frente; na 2ª, B (como o compositor desenha a janela): o hit-test pega o último
      if (l.linear < 0.5) {
        collectBoxes(p, l.to, W, H, measure, out)
        collectBoxes(p, l.from, W, H, measure, out)
      } else {
        collectBoxes(p, l.from, W, H, measure, out)
        collectBoxes(p, l.to, W, H, measure, out)
      }
    }
  }
}

/**
 * Caixas das camadas visíveis em tUs — mídia, texto e forma (fundo → topo), com o mesmo tamanho que o compositor
 * desenha. Dentro da janela de uma transição, os clipes A e B continuam selecionáveis (cada um com a pose da camada).
 */
export function itemBoxes(p: Project, tUs: Us, measure: TextMeasure = measureTextBox): ItemBox[] {
  const out: ItemBox[] = []
  collectBoxes(p, resolveFrame(p, tUs), p.canvas.width, p.canvas.height, measure, out)
  return out
}

/** Ponto no referencial da caixa (sem rotação, origem no centro). */
function toLocal(b: ItemBox, x: number, y: number): Pt {
  const th = (-b.rotation * Math.PI) / 180
  const dx = x - b.cx
  const dy = y - b.cy
  return { x: dx * Math.cos(th) - dy * Math.sin(th), y: dx * Math.sin(th) + dy * Math.cos(th) }
}

/** Item mais ao topo sob (x, y) em pixels do canvas; null se nenhum. */
export function hitTest(boxes: ItemBox[], x: number, y: number): string | null {
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i]
    const l = toLocal(b, x, y)
    if (Math.abs(l.x) <= b.w / 2 && Math.abs(l.y) <= b.h / 2) return b.itemId
  }
  return null
}

const SNAP = 0.01

/** Guia de centro: valor normalizado a ±1 % de 0,5 gruda em 0,5. */
export function snapCenter(v: number): { value: number; snapped: boolean } {
  return Math.abs(v - 0.5) <= SNAP ? { value: 0.5, snapped: true } : { value: v, snapped: false }
}

/** Canto da caixa (pixels do canvas), já rotacionado. */
export function cornerPoint(b: ItemBox, c: Corner): Pt {
  const sx = c === 'tl' || c === 'bl' ? -0.5 : 0.5
  const sy = c === 'tl' || c === 'tr' ? -0.5 : 0.5
  const th = (b.rotation * Math.PI) / 180
  const lx = sx * b.w
  const ly = sy * b.h
  return { x: b.cx + lx * Math.cos(th) - ly * Math.sin(th), y: b.cy + lx * Math.sin(th) + ly * Math.cos(th) }
}

const OPPOSITE: Record<Corner, Corner> = { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' }

/**
 * Escala arrastando um canto até `pointer`: fator sobre o tamanho inicial (projeção na diagonal) e o
 * novo centro. keepCenter (Shift): escala em torno do centro; senão o canto oposto fica parado.
 */
export function cornerScale(b: ItemBox, corner: Corner, pointer: Pt, keepCenter: boolean): { factor: number; cx: number; cy: number } {
  const h0 = cornerPoint(b, corner)
  const anchor = keepCenter ? { x: b.cx, y: b.cy } : cornerPoint(b, OPPOSITE[corner])
  const dx = h0.x - anchor.x
  const dy = h0.y - anchor.y
  const len2 = dx * dx + dy * dy || 1
  const factor = Math.max(0.01, ((pointer.x - anchor.x) * dx + (pointer.y - anchor.y) * dy) / len2)
  if (keepCenter) return { factor, cx: b.cx, cy: b.cy }
  return { factor, cx: anchor.x + (dx * factor) / 2, cy: anchor.y + (dy * factor) / 2 }
}

/** Rotação (graus) após girar de `from` até `to` em torno de `center`, partindo de `start`; Shift: passos de 15°. */
export function rotateAngle(center: Pt, from: Pt, to: Pt, start: number, step15: boolean): number {
  const a0 = Math.atan2(from.y - center.y, from.x - center.x)
  const a1 = Math.atan2(to.y - center.y, to.x - center.x)
  let deg = start + ((a1 - a0) * 180) / Math.PI
  deg = ((((deg + 180) % 360) + 360) % 360) - 180 // −180…180
  return step15 ? Math.round(deg / 15) * 15 : deg
}

// ---------------------------------------------------------------- regiões de efeito

/** Região de efeito em pixels do canvas do projeto (centro, tamanho, rotação horária em graus). */
export interface RegionBox extends ItemBox {
  shape: 'rect' | 'ellipse'
  /** Faixa bloqueada: aparece, mas não é selecionável pelo visualizador. */
  locked?: boolean
}

/** Menor lado da região: 1 % do quadro. */
export const MIN_REGION = 0.01

/** Efeitos ativos (e ativados) em tUs nas faixas de vídeo visíveis, de baixo para cima, com a região avaliada em tUs. */
export function effectBoxes(p: Project, tUs: Us): RegionBox[] {
  const out: RegionBox[] = []
  for (const t of p.tracks) {
    if (t.kind !== 'video' || t.hidden) continue
    const it = t.items.find((i) => tUs >= i.startUs && tUs < i.startUs + i.durationUs)
    if (!it || it.type !== 'effect' || it.enabled === false) continue
    out.push({ ...regionBoxOf(p, it, tUs), ...(t.locked ? { locked: true } : {}) })
  }
  return out
}

/** Região do efeito NO QUADRO no instante tUs (absoluto), em pixels — ancorada: como o resolve a desenha. */
export function regionBoxOf(p: Project, it: EffectItem, tUs: Us): RegionBox {
  const W = p.canvas.width
  const H = p.canvas.height
  const r = effectRegionAt(p, it, tUs)
  return { itemId: it.id, shape: it.region.shape, cx: r.x * W, cy: r.y * H, w: r.w * W, h: r.h * H, rotation: r.rotation }
}

/** (x, y) dentro da região (retângulo ou elipse, rotacionada), com folga em px para fora. */
export function regionHit(b: RegionBox, x: number, y: number, slackPx = 0): boolean {
  const l = toLocal(b, x, y)
  const hw = b.w / 2 + slackPx
  const hh = b.h / 2 + slackPx
  if (b.shape === 'ellipse') return (l.x * l.x) / (hw * hw) + (l.y * l.y) / (hh * hh) <= 1
  return Math.abs(l.x) <= hw && Math.abs(l.y) <= hh
}

/** Região mais ao topo sob (x, y), ignorando as de faixas bloqueadas; null se nenhuma. */
export function hitTestRegions(boxes: RegionBox[], x: number, y: number, slackPx = 0): string | null {
  for (let i = boxes.length - 1; i >= 0; i--) if (!boxes[i].locked && regionHit(boxes[i], x, y, slackPx)) return boxes[i].itemId
  return null
}

/**
 * Arraste da ferramenta "Desenhar região" (pixels do canvas) → região normalizada. Alt: `from` é o centro;
 * Shift: elipse (senão a forma escolhida na ferramenta). Lados de no mínimo 1 % do quadro.
 */
export function dragToRegion(from: Pt, to: Pt, W: number, H: number, mods: { alt: boolean; shift: boolean; shape: 'rect' | 'ellipse' }): { x: number; y: number; w: number; h: number; shape: 'rect' | 'ellipse' } {
  const k = mods.alt ? 2 : 1
  const cx = mods.alt ? from.x : (from.x + to.x) / 2
  const cy = mods.alt ? from.y : (from.y + to.y) / 2
  return {
    x: cx / W,
    y: cy / H,
    w: Math.max(MIN_REGION, (Math.abs(to.x - from.x) * k) / W),
    h: Math.max(MIN_REGION, (Math.abs(to.y - from.y) * k) / H),
    shape: mods.shift ? 'ellipse' : mods.shape
  }
}

/** Alças de redimensionar: cantos e meios das bordas (no referencial da região, antes da rotação). */
export type RegionHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export const HANDLE_SIGN: Record<RegionHandle, [number, number]> = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] }

/**
 * Redimensiona arrastando a alça até `pointer` (pixels do canvas). Sem Alt o lado/canto oposto fica
 * parado; fromCenter (Alt): os dois lados andam. keepAspect (Shift): mantém a proporção (canto: projeção
 * na diagonal; borda: o outro lado acompanha, centrado). Lados ≥ minW/minH.
 */
export function resizeRegion<B extends ItemBox>(b: B, handle: RegionHandle, pointer: Pt, o: { keepAspect: boolean; fromCenter: boolean; minW: number; minH: number }): B {
  const [sx, sy] = HANDLE_SIGN[handle]
  const l = toLocal(b, pointer.x, pointer.y)
  const k = o.fromCenter ? 2 : 1
  const ax = o.fromCenter ? 0 : (-sx * b.w) / 2
  const ay = o.fromCenter ? 0 : (-sy * b.h) / 2
  let w = sx ? Math.max(o.minW, sx * (l.x - ax) * k) : b.w
  let h = sy ? Math.max(o.minH, sy * (l.y - ay) * k) : b.h
  if (o.keepAspect) {
    let f: number
    if (sx && sy) f = ((sx * (l.x - ax) * b.w + sy * (l.y - ay) * b.h) * k) / (b.w * b.w + b.h * b.h || 1)
    else f = sx ? w / b.w : h / b.h
    f = Math.max(f, o.minW / b.w, o.minH / b.h)
    w = b.w * f
    h = b.h * f
  }
  const lx = sx && !o.fromCenter ? ax + (sx * w) / 2 : 0
  const ly = sy && !o.fromCenter ? ay + (sy * h) / 2 : 0
  const th = (b.rotation * Math.PI) / 180
  return { ...b, cx: b.cx + lx * Math.cos(th) - ly * Math.sin(th), cy: b.cy + lx * Math.sin(th) + ly * Math.cos(th), w, h }
}

export interface Guides {
  /** Linhas verticais (x normalizado) e horizontais (y normalizado) a mostrar. */
  v: number[]
  h: number[]
}

const GUIDE_LINES = [0, 0.5, 1]
const upright = (deg: number): boolean => Math.abs(deg % 180) < 1e-6

/** Melhor encaixe (a ±1 %) entre os pontos da região e as guias; null se nenhum. */
function bestSnap(points: { v: number; lines: number[] }[]): { delta: number; line: number } | null {
  let best: { delta: number; line: number } | null = null
  for (const pt of points) {
    for (const line of pt.lines) {
      const d = line - pt.v
      if (Math.abs(d) <= SNAP + 1e-9 && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, line }
    }
  }
  return best
}

/**
 * Mover a região (valores normalizados): o centro gruda no centro do quadro e, sem rotação, as bordas
 * grudam nas bordas e no centro do quadro (±1 %).
 */
export function snapRegion(r: { x: number; y: number; w: number; h: number; rotation: number }): { x: number; y: number; guides: Guides } {
  const edges = upright(r.rotation)
  const axis = (c: number, size: number): { value: number; guide: number[] } => {
    const pts = [{ v: c, lines: [0.5] }]
    if (edges) pts.push({ v: c - size / 2, lines: GUIDE_LINES }, { v: c + size / 2, lines: GUIDE_LINES })
    const s = bestSnap(pts)
    return s ? { value: c + s.delta, guide: [s.line] } : { value: c, guide: [] }
  }
  const x = axis(r.x, r.w)
  const y = axis(r.y, r.h)
  return { x: x.value, y: y.value, guides: { v: x.guide, h: y.guide } }
}

/**
 * Depois de redimensionar (pixels; sem Shift): sem rotação, a(s) borda(s) arrastada(s) grudam nas
 * bordas/centro do quadro (±1 %). Sem Alt o lado oposto continua parado; com Alt a outra borda espelha.
 * Lados continuam ≥ MIN_REGION do quadro (o mesmo mínimo de resizeRegion).
 */
export function snapResize<B extends ItemBox>(b: B, handle: RegionHandle, fromCenter: boolean, W: number, H: number): { box: B; guides: Guides } {
  const guides: Guides = { v: [], h: [] }
  if (!upright(b.rotation)) return { box: b, guides }
  // girada 180°: as bordas trocam de lado
  const flip = Math.abs(b.rotation % 360) > 90 ? -1 : 1
  const [hx, hy] = HANDLE_SIGN[handle]
  const axis = (s: number, c: number, size: number, full: number): { c: number; size: number; guide: number | null } => {
    if (!s) return { c, size, guide: null }
    const hit = bestSnap([{ v: (c + (s * size) / 2) / full, lines: GUIDE_LINES }])
    if (!hit) return { c, size, guide: null }
    const e = hit.line * full
    const min = MIN_REGION * full
    if (fromCenter) return { c, size: Math.max(min, 2 * Math.abs(e - c)), guide: hit.line }
    const anchor = c - (s * size) / 2
    const n = Math.max(min, s * (e - anchor))
    return { c: anchor + (s * n) / 2, size: n, guide: hit.line }
  }
  const x = axis(hx * flip, b.cx, b.w, W)
  const y = axis(hy * flip, b.cy, b.h, H)
  if (x.guide !== null) guides.v.push(x.guide)
  if (y.guide !== null) guides.h.push(y.guide)
  return { box: { ...b, cx: x.c, w: x.size, cy: y.c, h: y.size }, guides }
}

const REGION_KEYS = ['x', 'y', 'w', 'h', 'rotation'] as const
export type RegionValues = Record<(typeof REGION_KEYS)[number], number>

/**
 * Grava em tUs (absoluto) as propriedades da região que diferem de `base` (valores GUARDADOS — do conteúdo, no
 * ancorado): propriedade animada ganha/atualiza o key no playhead; sem keys muda o valor fixo (setAnimValue).
 */
function writeStored(p: Project, itemId: string, tUs: Us, base: RegionValues, target: Partial<RegionValues>): Project {
  let q = p
  for (const k of REGION_KEYS) {
    const v = target[k]
    if (v === undefined || Math.abs(v - base[k]) < 1e-9) continue
    q = setAnimValue(q, itemId, `region.${k}`, tUs, v)
  }
  return q
}

/** Valores guardados da região (o que está nas anims; no ancorado, espaço do conteúdo) no instante tUs (absoluto). */
function storedAt(fx: EffectItem, tUs: Us): RegionValues {
  const local = tUs - fx.startUs
  return Object.fromEntries(REGION_KEYS.map((k) => [k, evalAnim(fx.region[k], local)])) as RegionValues
}

/** Âncora sem clipe (apagado/desativado): a região não se edita — o erro vira toast no editor (apply). */
function assertAnchorAvailable(p: Project, fx: EffectItem): void {
  if (fx.attach && !attachedMedia(p, fx)) throw new EditError('invalid', 'Clipe da âncora indisponível: desligue a âncora no inspetor para editar a região')
}

/**
 * Grava os valores GUARDADOS da região (no ancorado: espaço do conteúdo — p.ex. a imagem inteira da fonte é
 * { x: ½, y: ½, w: 1, h: 1, rotação 0 }) que mudaram em relação ao instante tUs. Âncora perdida → EditError.
 */
export function writeRegionValues(p: Project, itemId: string, tUs: Us, next: Partial<RegionValues>): Project {
  const fx = findItem(p, itemId)?.item
  if (fx?.type !== 'effect') return p
  assertAnchorAvailable(p, fx)
  return writeStored(p, itemId, tUs, storedAt(fx, tUs), next)
}

/**
 * Grava em tUs (absoluto) só as propriedades da região que mudaram em relação a `from` (valores do QUADRO): propriedade
 * animada ganha/atualiza o key no playhead; sem keys muda o valor fixo (setAnimValue). Efeito ancorado: a mudança é
 * levada ao espaço do conteúdo do clipe nesse instante (screenToContent de `from` e do novo, somando a diferença ao
 * valor guardado — a folga de 1 px da tela não se acumula). Âncora perdida, ou instante fora do clipe (onde a região é
 * a caixa parada) → EditError (toast).
 */
export function writeRegion(p: Project, itemId: string, tUs: Us, from: RegionValues, next: Partial<RegionValues>): Project {
  const fx = findItem(p, itemId)?.item
  if (fx?.type !== 'effect') return p
  if (!fx.attach) return writeStored(p, itemId, tUs, from, next)
  assertAnchorAvailable(p, fx)
  const m = attachedMedia(p, fx)!
  const cf = tUs >= m.startUs && tUs < m.startUs + m.durationUs ? clipFrameAt(p, m, tUs) : null
  if (!cf) throw new EditError('invalid', 'Neste instante o clipe da âncora não aparece: mova o playhead para dentro dele para editar a região')
  const shape = fx.region.shape
  const c0 = screenToContent(cf, from, shape)
  const c1 = screenToContent(cf, { ...from, ...next }, shape)
  const base = storedAt(fx, tUs)
  return writeStored(p, itemId, tUs, base, Object.fromEntries(REGION_KEYS.map((k) => [k, base[k] + c1[k] - c0[k]])))
}

/** Há key de região (x, y, w, h ou rotação) a ±tolUs do instante local. */
export function keyframeAt(it: EffectItem, localUs: Us, tolUs: Us): boolean {
  return REGION_KEYS.some((k) => (it.region[k].keys ?? []).some((key) => Math.abs(key.tUs - localUs) <= tolUs))
}
