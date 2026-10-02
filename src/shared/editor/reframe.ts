// Reenquadrar (F4): o projeto passa para outra proporção (vertical 9:16, quadrado 1:1, retrato 4:5) mantendo o que
// importa no quadro. Puro.
// - Clipe principal (cobre o quadro, ou centrado em escala ≥ 1 — a gravação da tela): 'cover' = preenche o quadro novo
//   (fit cover) com keys de x/y que levam o ponto de foco ao centro, presos para não mostrar borda preta; 'contain' =
//   cabe inteiro (fit contain, barras), posição intacta. Pontos de foco marcados pelo usuário por clipe, guardados no
//   espaço do CONTEÚDO do clipe (instante relativo ao início dele, fração da fonte exibida: mover ou transformar o
//   clipe não os desloca); sem pontos, o ponto da fonte que estava no centro do quadro (o centro do clipe parado, o
//   movimento do Ken Burns/zoom).
// - Sobreposições (PiP, logos): mesmo tamanho em px relativo ao lado menor do quadro, posição proporcional, presas
//   dentro do quadro se estavam dentro.
// - Textos/formas: posição proporcional (normalizada), tamanho do texto pelo lado menor.
// - Privacidade: todo efeito continua cobrindo o MESMO conteúdo. "Clipes" sob o efeito, para essa decisão: a mídia de
//   vídeo das faixas que ele esconde — também desativada ou em faixa oculta (pode voltar a aparecer) — e as anotações
//   da gravação (camada parada no quadro inteiro: o conteúdo delas fica no mesmo ponto normalizado). Ancorado ou solto
//   que, em todo o tempo, só encosta num clipe de mídia: ancorado a ele (acompanha o clipe sozinho, inclusive edições
//   futuras). Encostando em vários (atravessa um corte, fica sobre PiP e tela, sobre traços das anotações): assado no
//   quadro novo — em cada amostra (≥ 60/s) a região antiga vai ao conteúdo de cada clipe e volta ao quadro novo pela
//   geometria nova; normal: a caixa que envolve todas (cresce, nunca encolhe); invertido (o buraco nítido): só com um
//   clipe visível no buraco, e nunca deixando aparecer clipe que antes não aparecia nele — com vários, o buraco nulo
//   (esconde tudo). Um ancorado que vira assado perde a âncora (aviso). Região que sai do quadro novo é mantida (cobre o
//   conteúdo onde quer que ele vá) e avisada.
import { easeValue, evalAnim } from './anim'
import { refreshAttachments } from './attachment'
import { contentToScreen, NO_HOLE, regionAabb, regionTouchesClip, screenToContent, type ClipFrame, type RegionValues } from './contentPose'
import { FIT_TOL, simplifyRegionSamples, toContentRegion, type RegionSample } from './followTransform'
import { newId } from './ids'
import { layerBase } from './layerGeometry'
import type { Anim, AnnotationsItem, EffectItem, Item, Keyframe, MediaItem, Project, TextItem, Us, VisualProps } from './project'
import { attachedMedia, clipFrameAt, effectRegionAt, visualStateAt, visualTrackBelow } from './resolve'
import { frameToUs, itemEndUs } from './time'
import { coverRange, coversFrame, sourceOf } from './zoom'

export type ReframeAspect = '9:16' | '1:1' | '4:5'
export const REFRAME_ASPECTS: readonly { id: ReframeAspect; label: string; suffix: string; ratio: [number, number] }[] = [
  { id: '9:16', label: 'Vertical 9:16', suffix: 'Vertical', ratio: [9, 16] },
  { id: '1:1', label: 'Quadrado 1:1', suffix: 'Quadrado', ratio: [1, 1] },
  { id: '4:5', label: 'Retrato 4:5', suffix: '4:5', ratio: [4, 5] }
]

/**
 * Ponto de foco no espaço do conteúdo do clipe: instante relativo ao início do clipe e ponto como fração da fonte
 * exibida (já girada, sem corte) — o mesmo espaço da região ancorada. focusFromScreen/focusToScreen convertem.
 */
export interface FocusPoint { localUs: Us; x: number; y: number }
export interface ReframeOptions {
  mode: 'cover' | 'contain'
  /** Pontos de foco por id do clipe principal (outros ids e pontos fora do clipe são ignorados). */
  focus?: Record<string, FocusPoint[]>
}
export type ReframeWarningKind = 'outsideFrame' | 'holeReduced' | 'unanchored' | 'annotations'
export interface ReframeWarning { itemId: string; kind: ReframeWarningKind; message: string; tUs: Us }
export interface ReframeResult {
  project: Project
  warnings: ReframeWarning[]
  /** Efeitos soltos que o reenquadrar ancorou ao clipe sob eles. */
  anchored: string[]
  /** Efeitos com a região assada (keys) no quadro novo. */
  baked: string[]
}

const MSG: Record<ReframeWarningKind, string> = {
  outsideFrame: 'A região deste efeito fica (em parte) fora do novo quadro: foi mantida sobre o mesmo conteúdo — confira o enquadramento',
  holeReduced: 'Efeito invertido: o buraco foi fechado para não expor conteúdo no novo quadro (o quadro inteiro fica escondido nesses trechos) — confira',
  unanchored: 'O efeito estava ancorado a um clipe, mas também cobria outro: a região foi ajustada ao novo quadro e deixou de seguir o clipe — confira',
  annotations: 'As anotações da gravação ocupam o quadro inteiro e não acompanham o reenquadramento — confira se ainda batem com a tela'
}

/** Curva entre dois pontos de foco (a câmera anda suave). */
const FOCUS_EASE = 'inOut' as const
/** Aproximação mínima (pico ÷ base) para um trecho contar como zoom: acima do Ken Burns (1,15), que segue os pontos. */
const ZOOM_FOCUS_MIN = 1.2
/** Amostragem mínima das partes assadas (como o desancorar): 60 por segundo. */
const MIN_SAMPLE_FPS = 60

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

/** Quadro na proporção pedida mantendo o lado menor (1080 continua 1080), lados pares. */
export function reframeCanvas(c: { width: number; height: number }, aspect: ReframeAspect): { width: number; height: number } {
  const [rw, rh] = REFRAME_ASPECTS.find((a) => a.id === aspect)!.ratio
  const short = Math.min(c.width, c.height)
  return rw >= rh ? { width: even((short * rw) / rh), height: even(short) } : { width: even(short), height: even((short * rh) / rw) }
}

/** Nome da cópia: "Aula (Vertical)", "Aula (Quadrado)", "Aula (4:5)". */
export function reframeName(name: string, aspect: ReframeAspect): string {
  return `${name} (${REFRAME_ASPECTS.find((a) => a.id === aspect)!.suffix})`
}

const animated = (...as: Anim<number>[]): boolean => as.some((a) => (a.keys?.length ?? 0) > 0)
const mapAnim = (a: Anim<number>, fn: (v: number, tUs: Us) => number): Anim<number> =>
  a.keys?.length ? { value: fn(a.value, a.keys[0].tUs), keys: a.keys.map((k) => ({ ...k, value: fn(k.value, k.tUs) })) } : { value: fn(a.value, 0) }
const isRight = (deg: number): boolean => Math.abs(deg - Math.round(deg / 90) * 90) < 1e-6

/** Sem animações de entrada/saída (a geometria "de repouso" que os keys descrevem). */
function restItem(m: MediaItem): MediaItem {
  const { animIn: _i, animOut: _o, ...v } = m.visual!
  return { ...m, visual: v }
}

/** Ponto do quadro (normalizado) → fração da fonte exibida; e o inverso (normalizado ao quadro do `cf`). */
const contentAt = (cf: ClipFrame, x: number, y: number): { x: number; y: number } => screenToContent(cf, { x, y, w: 0, h: 0, rotation: 0 }, 'rect')
const screenAt = (cf: ClipFrame, q: { x: number; y: number }): { x: number; y: number } => contentToScreen(cf, { x: q.x, y: q.y, w: 0, h: 0, rotation: 0 }, 'rect', 0)

/**
 * Clipe principal: cobre o quadro em repouso (local 0), ou está centrado em escala ≥ 1 sem giro fora de 90° (o
 * clipe "de fundo" com barras, ex.: gravação 4:3 num quadro 16:9). O resto é sobreposição.
 */
export function isMainClip(p: Project, m: MediaItem): boolean {
  const v = m.visual
  if (!v) return false
  const t = v.transform
  if (!isRight(evalAnim(t.rotation, 0))) return false
  if (coversFrame(v, sourceOf(p, m), { w: p.canvas.width, h: p.canvas.height }, 0)) return true
  return Math.abs(evalAnim(t.x, 0) - 0.5) < 0.01 && Math.abs(evalAnim(t.y, 0) - 0.5) < 0.01 && evalAnim(t.scale, 0) >= 0.99
}

/** Clique no quadro (ponto normalizado) no instante absoluto → ponto de foco no conteúdo do clipe; null = clipe invisível. */
export function focusFromScreen(p: Project, m: MediaItem, tUs: Us, x: number, y: number): FocusPoint | null {
  const cf = clipFrameAt(p, m, tUs)
  if (!cf) return null
  const q = contentAt(cf, x, y)
  return { localUs: Math.round(tUs) - m.startUs, x: q.x, y: q.y }
}

/** Ponto de foco → instante absoluto e ponto normalizado do quadro de `p` (marcador no visualizador); null = invisível. */
export function focusToScreen(p: Project, m: MediaItem, f: FocusPoint): { tUs: Us; x: number; y: number } | null {
  const tUs = m.startUs + f.localUs
  const cf = clipFrameAt(p, m, tUs)
  return cf ? { tUs, ...screenAt(cf, f) } : null
}

/** O clipe tem zoom (keys de escala com aproximação ≥ ZOOM_FOCUS_MIN): no reenquadrar, o alvo dele manda nesses trechos. */
export function hasZoomKeys(m: MediaItem): boolean {
  const s = m.visual?.transform.scale
  if (!s?.keys?.length) return false
  const vs = s.keys.map((k) => k.value)
  const base = Math.min(...vs)
  return base > 0 && Math.max(...vs) >= base * ZOOM_FOCUS_MIN
}

/** Clipe principal de cima ativo no instante (o que recebe os pontos de foco no visualizador); null = nenhum. */
export function mainClipAt(p: Project, tUs: Us): MediaItem | null {
  for (let i = p.tracks.length - 1; i >= 0; i--) {
    const t = p.tracks[i]
    if (t.kind !== 'video' || t.hidden) continue
    const m = t.items.find((it): it is MediaItem => it.type === 'media' && !!it.visual && it.enabled !== false && tUs >= it.startUs && tUs < itemEndUs(it))
    if (m && isMainClip(p, m)) return m
  }
  return null
}

/** Douglas–Peucker em dois canais com faixa permitida por amostra: nenhuma amostra a mais de `tol` nem fora da faixa. */
function simplifyXY(s: { t: Us; x: number; y: number; r: { x0: number; x1: number; y0: number; y1: number }; must: boolean }[], tolX: number, tolY: number): { x: Anim<number>; y: Anim<number> } {
  const err = (k: number, i: number, j: number): number => {
    const a = s[i], b = s[j], c = s[k]
    const u = (c.t - a.t) / (b.t - a.t)
    const ix = a.x + (b.x - a.x) * u, iy = a.y + (b.y - a.y) * u
    if (ix < c.r.x0 - 1e-9 || ix > c.r.x1 + 1e-9 || iy < c.r.y0 - 1e-9 || iy > c.r.y1 + 1e-9) return Infinity
    return Math.max(Math.abs(ix - c.x) / tolX, Math.abs(iy - c.y) / tolY)
  }
  const keep = s.map((x, i) => x.must || i === 0 || i === s.length - 1)
  const fixed = keep.flatMap((k, i) => (k ? [i] : []))
  const stack: [number, number][] = fixed.slice(1).map((j, n) => [fixed[n], j])
  while (stack.length) {
    const [i, j] = stack.pop()!
    let worst = -1, at = -1
    for (let k = i + 1; k < j; k++) {
      const e = err(k, i, j)
      if (e > worst) { worst = e; at = k }
    }
    if (worst > 1) {
      keep[at] = true
      stack.push([i, at], [at, j])
    }
  }
  const kept = s.filter((_, i) => keep[i])
  const ch = (c: 'x' | 'y'): Anim<number> => {
    const keys: Keyframe<number>[] = kept.map((k) => ({ tUs: k.t, value: k[c], ease: 'linear' }))
    return keys.every((k) => Math.abs(k.value - keys[0].value) < 1e-12) ? { value: keys[0].value } : { value: keys[0].value, keys }
  }
  return { x: ch('x'), y: ch('y') }
}

/**
 * Peso do alvo do zoom em cada amostra (escalas em ordem de tempo): trechos contíguos com a escala acima da base (a
 * menor do clipe) e pico ≥ ZOOM_FOCUS_MIN × base; peso = (s/base − 1)/(pico/base − 1) — 1 na espera do zoom, 0 fora.
 */
function zoomWeights(sc: number[]): number[] {
  const base = Math.min(...sc)
  const w = sc.map(() => 0)
  if (!(base > 0)) return w
  for (let i = 0; i < sc.length; ) {
    if (sc[i] <= base * (1 + 1e-6)) { i++; continue }
    let j = i, peak = sc[i]
    while (j < sc.length && sc[j] > base * (1 + 1e-6)) peak = Math.max(peak, sc[j++])
    if (peak >= base * ZOOM_FOCUS_MIN) for (let k = i; k < j; k++) w[k] = Math.min(1, (sc[k] / base - 1) / (peak / base - 1))
    i = j
  }
  return w
}

/**
 * x/y do clipe principal em 'cover' no quadro novo (`q1`: o projeto só com o quadro novo, para a geometria): o ponto de
 * foco no centro, preso à faixa sem bordas (coverRange) em cada instante. Geometria parada (escala, giro, corte sem
 * keys) e pontos do usuário → um key por ponto com Suavizar ambos (exatos: x/y são afins no ponto e a faixa é fixa,
 * então a curva entre dois pontos válidos fica válida). Senão → amostras em cada quadro (e nos keys) simplificadas com
 * keys lineares, a ≤ FIT_TOL do quadro e sempre dentro da faixa. Com pontos do usuário e zoom já no clipe: nos trechos
 * do zoom o foco vai ao alvo dele (zoomWeights) — o detalhe ampliado continua no quadro novo; fora deles, os pontos.
 */
function focusTransform(p0: Project, q1: Project, m0: MediaItem, points: FocusPoint[]): { x: Anim<number>; y: Anim<number> } {
  const v0 = m0.visual!, t0 = v0.transform, c0 = v0.crop
  const D = m0.durationUs, W1 = q1.canvas.width, H1 = q1.canvas.height
  const rest0 = restItem(m0)
  const m1 = restItem({ ...m0, visual: { ...v0, fit: 'cover', transform: { ...t0, x: { value: 0.5 }, y: { value: 0.5 } } } })
  // pontos do usuário (já no espaço do conteúdo): dentro do clipe, um por instante (o último vale)
  const byT = new Map<Us, { l: Us; q: { x: number; y: number } }>()
  for (const pt of points) {
    const l = Math.round(pt.localUs)
    if (l < 0 || l >= D) continue
    byT.set(l, { l, q: { x: pt.x, y: pt.y } })
  }
  const pts = [...byT.values()].sort((a, b) => a.l - b.l)
  const focusAt = (l: Us): { x: number; y: number } => {
    if (pts.length === 0) return contentAt(clipFrameAt(p0, rest0, m0.startUs + l, true)!, 0.5, 0.5)
    if (l <= pts[0].l) return pts[0].q
    const j = pts.findIndex((p) => p.l > l)
    if (j < 0) return pts[pts.length - 1].q
    const a = pts[j - 1], b = pts[j], u = easeValue(FOCUS_EASE, (l - a.l) / (b.l - a.l))
    return { x: a.q.x + (b.q.x - a.q.x) * u, y: a.q.y + (b.q.y - a.q.y) * u }
  }
  const desired = (l: Us, q: { x: number; y: number }) => {
    const cf = clipFrameAt(q1, m1, m1.startUs + l, true)!
    const s = screenAt(cf, q)
    const r = coverRange(cf.sx, cf.sy, cf.rotation, { w: W1, h: H1 })
    // s(cx) = s(½) + (cx − ½): o ponto vai ao centro com cx = 1 − s(½)
    return { x: Math.min(r.x1, Math.max(r.x0, 1 - s.x)), y: Math.min(r.y1, Math.max(r.y0, 1 - s.y)), r }
  }
  const geomMoves = animated(t0.scale, t0.rotation, c0.l, c0.t, c0.r, c0.b)
  const oldMoves = geomMoves || animated(t0.x, t0.y)
  const constant = (a: Keyframe<number>[]): Anim<number> => (a.every((k) => Math.abs(k.value - a[0].value) < 1e-12) ? { value: a[0].value } : { value: a[0].value, keys: a })
  if (!geomMoves && (pts.length > 0 || !oldMoves)) {
    if (pts.length <= 1) {
      const d = desired(0, pts[0]?.q ?? focusAt(0))
      return { x: { value: d.x }, y: { value: d.y } }
    }
    const ds = pts.map((p) => desired(p.l, p.q))
    const keys = (c: 'x' | 'y'): Keyframe<number>[] => pts.map((p, i) => ({ tUs: p.l, value: ds[i][c], ease: i === pts.length - 1 ? 'linear' : FOCUS_EASE }))
    return { x: constant(keys('x')), y: constant(keys('y')) }
  }
  const fps = p0.canvas.fps > 0 ? p0.canvas.fps : 30
  const must = new Set<Us>([0, D - 1, ...pts.map((p) => p.l)])
  for (const a of [t0.x, t0.y, t0.scale, t0.rotation, c0.l, c0.t, c0.r, c0.b]) for (const k of a.keys ?? []) must.add(k.tUs).add(k.tUs - 1)
  const times = new Set<Us>([...must].filter((l) => l >= 0 && l < D))
  for (let k = 0; ; k++) {
    const l = frameToUs(k, fps)
    if (l >= D) break
    times.add(l)
  }
  const ts = [...times].sort((a, b) => a - b)
  const zw = pts.length ? zoomWeights(ts.map((l) => evalAnim(t0.scale, l))) : null
  const samples = ts.map((l, i) => {
    let f = focusAt(l)
    // trecho de zoom: o alvo dele (o conteúdo no centro do quadro antigo) é o foco; entra e sai junto com a escala
    if (zw && zw[i] > 0) {
      const z = contentAt(clipFrameAt(p0, rest0, m0.startUs + l, true)!, 0.5, 0.5)
      f = { x: f.x + (z.x - f.x) * zw[i], y: f.y + (z.y - f.y) * zw[i] }
    }
    return { t: l, ...desired(l, f), must: must.has(l) }
  })
  const tol = FIT_TOL * Math.max(W1, H1)
  return simplifyXY(samples, tol / W1, tol / H1)
}

/** Caixa (px) que envolve a camada w×h girada θ graus. */
const halfBox = (w: number, h: number, deg: number): [number, number] => {
  const th = (deg * Math.PI) / 180, c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th))
  return [(c * w + s * h) / 2, (s * w + c * h) / 2]
}

/**
 * Sobreposição: escala × f (o mesmo tamanho em px relativo ao lado menor), posição normalizada mantida e, se a camada
 * estava inteira dentro do quadro, presa dentro do quadro novo (em cada key, com a escala daquele instante).
 */
function overlayVisual(p0: Project, q1: Project, m: MediaItem): VisualProps {
  const v = m.visual!, t = v.transform, c = v.crop
  const src = sourceOf(p0, m)
  const crop0 = { l: evalAnim(c.l, 0), t: evalAnim(c.t, 0), r: evalAnim(c.r, 0), b: evalAnim(c.b, 0) }
  const W0 = p0.canvas.width, H0 = p0.canvas.height, W1 = q1.canvas.width, H1 = q1.canvas.height
  const g0 = layerBase(crop0, v.fit, src, { w: W0, h: H0 }), g1 = layerBase(crop0, v.fit, src, { w: W1, h: H1 })
  const f = (Math.min(W1, H1) / Math.min(W0, H0)) * (g0.bw / g1.bw)
  const scale = mapAnim(t.scale, (s) => s * f)
  const [ex0, ey0] = halfBox(g0.bw * evalAnim(t.scale, 0), g0.bh * evalAnim(t.scale, 0), evalAnim(t.rotation, 0))
  const cx0 = evalAnim(t.x, 0) * W0, cy0 = evalAnim(t.y, 0) * H0
  const inside = cx0 - ex0 >= -0.5 && cx0 + ex0 <= W0 + 0.5 && cy0 - ey0 >= -0.5 && cy0 + ey0 <= H0 + 0.5
  if (!inside) return { ...v, transform: { ...t, scale } }
  const half = (l: Us): [number, number] => halfBox(g1.bw * evalAnim(scale, l), g1.bh * evalAnim(scale, l), evalAnim(t.rotation, l))
  const keep = (c: number, h: number, full: number): number => (h * 2 >= full ? 0.5 : Math.min(1 - h / full, Math.max(h / full, c)))
  return { ...v, transform: { ...t, scale, x: mapAnim(t.x, (x, l) => keep(x, half(l)[0], W1)), y: mapAnim(t.y, (y, l) => keep(y, half(l)[1], H1)) } }
}

// ---------------------------------------------------------------- efeitos

/**
 * Item sob o efeito: mídia de vídeo (também desativada ou em faixa oculta: pode voltar a aparecer) ou anotações.
 * `drawn` = desenhado hoje (ativo, faixa visível) — só esse esconde o que está embaixo.
 */
type Under = MediaItem | AnnotationsItem
type Placed = { it: Under; ti: number; drawn: boolean }

/** Itens sobre os quais o efeito age (faixas abaixo; escopo `track`: a faixa-alvo) no tempo dele, do topo para o fundo. */
function actedClips(p: Project, fx: EffectItem): Placed[] {
  const fti = p.tracks.findIndex((t) => t.items.some((i) => i.id === fx.id))
  const target = fx.scope === 'track' ? (fx.targetTrackId ?? visualTrackBelow(p, p.tracks[fti].id)) : null
  const out: Placed[] = []
  p.tracks.forEach((t, ti) => {
    if (t.kind !== 'video') return
    if (target ? t.id !== target : ti >= fti) return
    for (const it of t.items) {
      const ok = it.type === 'annotations' || (it.type === 'media' && !!it.visual && p.assets.some((a) => a.id === it.assetId))
      if (!ok || it.startUs >= itemEndUs(fx) || itemEndUs(it) <= fx.startUs) continue
      out.push({ it: it as Under, ti, drawn: !t.hidden && it.enabled !== false })
    }
  })
  return out.sort((a, b) => b.ti - a.ti)
}

/**
 * Geometria do item no instante. Anotações: a camada do quadro inteiro, parada ('fill' com a fonte do tamanho do
 * quadro) — fração do "conteúdo" = ponto normalizado do quadro, o mesmo nos dois quadros.
 */
function frameOf(p: Project, it: Under, at: Us): ClipFrame | null {
  if (it.type === 'media') return clipFrameAt(p, it, at)
  const W = p.canvas.width, H = p.canvas.height
  const g = layerBase({ l: 0, t: 0, r: 0, b: 0 }, 'fill', { w: W, h: H, rotation: 0 }, { w: W, h: H })
  return { cx: 0.5, cy: 0.5, rotation: 0, sx: g.bw, sy: g.bh, mirror: false, g, W, H }
}

/** A camada (desenhada, opaca, retangular, sem desfoque) esconde tudo o que está embaixo dentro da caixa `b` (px)? */
function occludes(pl: Placed, cf: ClipFrame, at: Us, b: { x0: number; y0: number; x1: number; y1: number }): boolean {
  const m = pl.it
  if (!pl.drawn || m.type !== 'media') return false
  const v = m.visual!
  const s = visualStateAt(v, m.durationUs, at - m.startUs)
  if (s.opacity < 0.999 || s.blur > 0 || (v.shape && v.shape !== 'rect')) return false
  const th = (-cf.rotation * Math.PI) / 180
  return [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]].every(([X, Y]) => {
    const dx = X - cf.cx * cf.W, dy = Y - cf.cy * cf.H
    const u = dx * Math.cos(th) - dy * Math.sin(th), w = dx * Math.sin(th) + dy * Math.cos(th)
    return Math.abs(u) <= cf.sx / 2 && Math.abs(w) <= cf.sy / 2
  })
}

/**
 * Itens cujo conteúdo a região (do quadro, normalizada) toca no instante, do topo para o fundo. `visible`: para no
 * primeiro desenhado que cobre a região inteira e é opaco (os de baixo não aparecem nela) — o que um buraco mostra.
 */
function clipsAt(p: Project, fx: EffectItem, acted: Placed[], r: RegionValues, at: Us, visible: boolean): { it: Under; cf: ClipFrame }[] {
  const loose = { ...fx, invert: false }
  const out: { it: Under; cf: ClipFrame }[] = []
  const W = p.canvas.width, H = p.canvas.height
  for (const pl of acted) {
    const it = pl.it
    if (at < it.startUs || at >= itemEndUs(it)) continue
    const cf = frameOf(p, it, at)
    if (!cf || !regionTouchesClip(loose, r, cf)) continue
    out.push({ it, cf })
    if (visible) {
      const a = regionAabb(r, W, H), pad = Math.max(0, fx.feather) * Math.min(Math.abs(r.w) * W, Math.abs(r.h) * H) / 2
      if (occludes(pl, cf, at, { x0: a.x0 * W - pad, y0: a.y0 * H - pad, x1: a.x1 * W + pad, y1: a.y1 * H + pad })) break
    }
  }
  return out
}

/** O clipe leva a fonte ao quadro com a mesma escala nos dois eixos (sem distorção)? */
const conformal = (cf: ClipFrame): boolean => Math.abs(cf.sx / cf.g.cw - cf.sy / cf.g.ch) <= 1e-9 * Math.max(cf.sx / cf.g.cw, cf.sy / cf.g.ch)

/** Instantes (absolutos) para amostrar o efeito: grade ≥ 60/s com os quadros do projeto, keys e bordas dos itens. */
function effectTimes(p0: Project, p1: Project, fx: EffectItem, acted: Placed[]): { times: Us[]; must: Set<Us> } {
  const a = fx.startUs, b = itemEndUs(fx)
  const fps = p0.canvas.fps > 0 ? p0.canvas.fps : 30
  const grid = fps * Math.max(1, Math.ceil(MIN_SAMPLE_FPS / fps))
  const must = new Set<Us>([a, b - 1])
  const addKeys = (offset: Us, as: Anim<number>[]): void => {
    for (const an of as) for (const k of an.keys ?? []) must.add(offset + k.tUs).add(offset + k.tUs - 1)
  }
  const r = fx.region
  addKeys(fx.startUs, [r.x, r.y, r.w, r.h, r.rotation])
  // ancorado: a região segue o clipe dele (keys e animações dele contam)
  const anchor = fx.attach ? p0.tracks.flatMap((t) => t.items).find((i) => i.id === fx.attach!.mediaItemId) : undefined
  const items: Under[] = [...acted.map((x) => x.it), ...(anchor?.type === 'media' ? [anchor] : [])]
  for (const it of items) {
    if (it.type === 'media') {
      for (const q of [p0, p1]) {
        const v = (q.tracks.flatMap((t) => t.items).find((i) => i.id === it.id) as MediaItem | undefined)?.visual
        if (!v) continue
        addKeys(it.startUs, [v.transform.x, v.transform.y, v.transform.scale, v.transform.rotation, v.crop.l, v.crop.t, v.crop.r, v.crop.b])
        if (v.animIn) must.add(it.startUs + v.animIn.durationUs)
        if (v.animOut) must.add(itemEndUs(it) - v.animOut.durationUs)
      }
    }
    for (const x of [it.startUs - 1, it.startUs, itemEndUs(it) - 1, itemEndUs(it)]) must.add(x)
  }
  const kept = new Set([...must].filter((x) => x >= a && x < b))
  const set = new Set<Us>(kept)
  for (let k = Math.ceil((a * grid) / 1e6); ; k++) {
    const at = frameToUs(k, grid)
    if (at >= b) break
    if (at >= a) set.add(at)
  }
  return { times: [...set].sort((x, y) => x - y), must: kept }
}

const fxIn = (p: Project, id: string): EffectItem => p.tracks.flatMap((t) => t.items).find((i) => i.id === id) as EffectItem
const sameIds = (a: { it: Under }[], b: { it: Under }[]): boolean => a.every((x) => b.some((y) => y.it.id === x.it.id))

/** Ids dos itens que a região do efeito (como o resolve a desenha em `p`) toca — buraco: os visíveis nele — ao longo dele. */
function touchedIds(p: Project, fx: EffectItem, acted: Placed[]): { ids: Set<string>; times: Us[] } {
  const { times } = effectTimes(p, p, fx, acted)
  const ids = new Set<string>()
  for (const t of times) for (const { it } of clipsAt(p, fx, acted, effectRegionAt(p, fx, t, 0), t, fx.invert)) ids.add(it.id)
  return { ids, times }
}

/**
 * Região do efeito no quadro novo, em cada amostra, levando o conteúdo que a região antiga cobria (ver o topo do
 * arquivo). `reduced`: algum instante do invertido virou o buraco nulo. `checkOnly` (invertidos que não foram
 * assados: soltos mantidos, ancorados): a região é a que o efeito já tem no projeto novo (como o resolve a desenha) e só
 * é conferida — `unsafe` = algum instante mostra no buraco item que não aparecia nele antes (inclusive buraco que antes
 * não mostrava item nenhum), e esse instante vira o buraco nulo.
 */
function mappedSamples(p0: Project, p1: Project, id: string, checkOnly: boolean): { samples: RegionSample[]; reduced: boolean; unsafe: boolean } {
  const fx0 = fxIn(p0, id), fx1 = fxIn(p1, id)
  const acted0 = actedClips(p0, fx0), acted1 = actedClips(p1, fx1)
  const { times, must } = effectTimes(p0, p1, fx0, acted0)
  const W1 = p1.canvas.width, H1 = p1.canvas.height
  const shape = fx0.region.shape
  let reduced = false, unsafe = false
  const samples = times.map((t): RegionSample => {
    const r0 = effectRegionAt(p0, fx0, t, 0)
    let r1: RegionValues
    if (checkOnly) r1 = effectRegionAt(p1, fx1, t, 0)
    else {
      const under = clipsAt(p0, fx0, acted0, r0, t, fx0.invert)
      const maps = under.flatMap(({ it, cf }) => {
        const it1 = acted1.find((x) => x.it.id === it.id)?.it
        const cf1 = it1 ? frameOf(p1, it1, t) : null
        return cf1 ? [{ cf0: cf, cf1 }] : []
      })
      if (fx0.invert && under.length > 1) {
        // buraco sobre vários itens: nenhum mapeamento único mantém o que cada um mostrava (o PiP deixa de esconder a
        // tela, a tela se move por baixo dele…) — fecha o buraco
        r1 = NO_HOLE
        reduced = true
      } else if (maps.length === 0) r1 = r0
      else if (!fx0.invert) {
        const rs = maps.map(({ cf0, cf1 }) => contentToScreen(cf1, screenToContent(cf0, r0, shape), shape, 0, 'cover'))
        if (rs.length === 1) r1 = rs[0]
        else {
          // a caixa que envolve todas (elipse: a que contém a caixa, ×√2)
          const bs = rs.map((r) => regionAabb(r, W1, H1))
          const x0 = Math.min(...bs.map((b) => b.x0)), y0 = Math.min(...bs.map((b) => b.y0)), x1 = Math.max(...bs.map((b) => b.x1)), y1 = Math.max(...bs.map((b) => b.y1))
          const k = shape === 'ellipse' ? Math.SQRT2 : 1
          r1 = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: (x1 - x0) * k, h: (y1 - y0) * k, rotation: 0 }
        }
      } else if (conformal(maps[0].cf0)) {
        r1 = contentToScreen(maps[0].cf1, screenToContent(maps[0].cf0, r0, shape), shape, 0, 'hole')
      } else {
        r1 = NO_HOLE
        reduced = true
      }
    }
    // buraco: o que aparece nele no quadro novo tem de ser o que já aparecia nele (senão, buraco nulo)
    if (fx0.invert && r1.w > 0 && r1.h > 0) {
      const before = clipsAt(p0, fx0, acted0, r0, t, true)
      const now = clipsAt(p1, fx1, acted1, r1, t, true)
      if (!sameIds(now, before)) {
        r1 = NO_HOLE
        reduced = unsafe = true
      }
    }
    // buraco nulo vira key sempre: a simplificação não pode abrir um buraco onde ele precisa ser nulo
    return { t, r: r1, must: must.has(t) || (fx0.invert && !(r1.w > 0 && r1.h > 0)) }
  })
  return { samples, reduced, unsafe }
}

/** Desvio tolerado entre a região ancorada e a solta (px do quadro, graus): só arredondamento. */
const SAME_PX = 0.5, SAME_DEG = 0.05

/**
 * Clipe ao qual o efeito solto pode ser ancorado: o único item que ele toca (buraco: o único visível nele) no tempo
 * todo, mídia desenhada, com o efeito dentro do tempo dele, no grupo dele ou solto — e a região ancorada
 * (toContentRegion) desenha EXATAMENTE a região solta em todas as amostras. Região parada sobre um clipe que se move
 * (deslizar, zoom, keys) cobre conteúdos diferentes ao longo do tempo: ancorada ela cobriria só um → assar.
 * null = assar.
 */
function anchorPlan(p0: Project, fx: EffectItem, acted: Placed[]): MediaItem | null {
  const { ids, times } = touchedIds(p0, fx, acted)
  if (ids.size !== 1) return null
  const pl = acted.find((x) => ids.has(x.it.id))
  const m = pl?.it
  if (!pl || !pl.drawn || m?.type !== 'media') return null
  if (fx.startUs < m.startUs || itemEndUs(fx) > itemEndUs(m)) return null
  // grupo: do clipe, ou solto (o grupo dele não tem mídia)
  const groupHasMedia = !!fx.linkId && p0.tracks.some((t) => t.items.some((i) => i.type !== 'effect' && i.linkId === fx.linkId))
  if (groupHasMedia && fx.linkId !== m.linkId) return null
  const W = p0.canvas.width, H = p0.canvas.height
  let anchored: EffectItem
  try {
    anchored = { ...fx, region: toContentRegion(p0, fx, m), attach: { mediaItemId: m.id } }
  } catch {
    return null // clipe invisível no tempo do efeito
  }
  for (const t of times) {
    const cf = clipFrameAt(p0, m, t)
    if (!cf) continue // conteúdo invisível: a região não cobre nada dele
    if (fx.invert && !conformal(cf)) return null
    const a = effectRegionAt(p0, fx, t, 0), b = effectRegionAt(p0, anchored, t, 0)
    const deg = Math.abs(((((a.rotation - b.rotation) % 360) + 540) % 360) - 180)
    if (Math.abs(a.x - b.x) * W > SAME_PX || Math.abs(a.y - b.y) * H > SAME_PX || Math.abs(Math.abs(a.w) - Math.abs(b.w)) * W > SAME_PX || Math.abs(Math.abs(a.h) - Math.abs(b.h)) * H > SAME_PX || deg > SAME_DEG) return null
  }
  return m
}

/** Reenquadra o projeto (ver o topo do arquivo). Não muda `p`; faixas bloqueadas também são reenquadradas. */
export function reframeProject(p: Project, aspect: ReframeAspect, opts: ReframeOptions): ReframeResult {
  const canvas = { ...p.canvas, ...reframeCanvas(p.canvas, aspect) }
  const q1: Project = { ...p, canvas }
  const warnings: ReframeWarning[] = []
  // 1. soltos: ancorar (um clipe só) ou assar depois (vários). Ancorados que tocam outro item além do clipe deles:
  //    assar (a âncora só leva a região pelo clipe dela; o conteúdo do outro iria para outro lugar)
  const anchors = new Map<string, MediaItem>()
  const toBake: string[] = []
  const unanchor: string[] = []
  for (const t of p.tracks) for (const fx of t.items) {
    if (fx.type !== 'effect') continue
    const acted = actedClips(p, fx)
    if (fx.attach) {
      const own = attachedMedia(p, fx)
      if (!own) continue // âncora perdida: a caixa de reserva fica (aviso attachLost da privacidade)
      const { ids } = touchedIds(p, fx, acted)
      if ([...ids].some((id) => id !== own.id)) unanchor.push(fx.id)
      continue
    }
    if (acted.length === 0) continue
    const m = anchorPlan(p, fx, acted)
    if (m) anchors.set(fx.id, m)
    else if (touchedIds(p, fx, acted).ids.size > 0) toBake.push(fx.id)
  }
  // vínculos dos ancorados: o do clipe ou um grupo novo com ele
  const links = new Map<string, string>()
  for (const m of anchors.values()) if (!links.has(m.id)) links.set(m.id, m.linkId ?? newId('l_'))
  const p0: Project = {
    ...p,
    tracks: p.tracks.map((t) => ({
      ...t,
      items: t.items.map((it): Item => {
        if (it.type === 'media' && links.has(it.id) && !it.linkId) return { ...it, linkId: links.get(it.id)! }
        if (it.type !== 'effect' || !anchors.has(it.id)) return it
        const m = anchors.get(it.id)!
        return { ...it, linkId: links.get(m.id)!, region: toContentRegion(p, it, m), attach: { mediaItemId: m.id } }
      })
    }))
  }
  // 2. mídia, textos
  const short = Math.min(canvas.width, canvas.height) / Math.min(p.canvas.width, p.canvas.height)
  let p1: Project = {
    ...p0,
    canvas,
    tracks: p0.tracks.map((t) => ({
      ...t,
      items: t.items.map((it): Item => {
        if (it.type === 'media' && t.kind === 'video' && it.visual) {
          if (!isMainClip(p0, it)) return { ...it, visual: overlayVisual(p0, q1, it) }
          if (opts.mode === 'contain') return { ...it, visual: { ...it.visual, fit: 'contain' } }
          const xy = focusTransform(p0, q1, it, opts.focus?.[it.id] ?? [])
          return { ...it, visual: { ...it.visual, fit: 'cover', transform: { ...it.visual.transform, ...xy } } }
        }
        if (it.type === 'text') return { ...it, style: { ...it.style, size: mapAnim(it.style.size, (s) => s * short) } } satisfies TextItem
        if (it.type === 'annotations') warnings.push({ itemId: it.id, kind: 'annotations', message: MSG.annotations, tUs: it.startUs })
        return it
      })
    }))
  }
  // 3. caixas de reserva das âncoras no quadro novo
  p1 = refreshAttachments(p1, p0)
  // 4. assar os de vários itens; depois TODO invertido que não foi assado (solto mantido — inclusive o buraco que não
  //    mostrava item nenhum —, ancorado pelo reenquadrar, já ancorado, âncora perdida): conferir que nenhum item novo
  //    aparece no buraco (um clipe que cresce ou se move para baixo dele no quadro novo)
  const baked: string[] = []
  const replace = (id: string, fn: (fx: EffectItem) => EffectItem): void => {
    p1 = { ...p1, tracks: p1.tracks.map((t) => (t.items.some((i) => i.id === id) ? { ...t, items: t.items.map((i) => (i.id === id ? fn(i as EffectItem) : i)) } : t)) }
  }
  const bake = (id: string, checkOnly: boolean): void => {
    const fx0 = fxIn(p0, id)
    const { samples, reduced, unsafe } = mappedSamples(p0, p1, id, checkOnly)
    if (checkOnly && !unsafe) return
    if (reduced) warnings.push({ itemId: id, kind: 'holeReduced', message: MSG.holeReduced, tUs: samples.find((s) => !(s.r.w > 0 && s.r.h > 0))?.t ?? fx0.startUs })
    if (fx0.attach) warnings.push({ itemId: id, kind: 'unanchored', message: MSG.unanchored, tUs: fx0.startUs })
    const region = simplifyRegionSamples(samples, fx0.region.shape, fx0.startUs, canvas.width, canvas.height, fx0.invert ? 'shrink' : 'grow')
    replace(id, (fx) => {
      const { attach: _, ...rest } = fx
      return { ...rest, region }
    })
    baked.push(id)
  }
  for (const id of [...toBake, ...unanchor]) bake(id, false)
  for (const t of p1.tracks) for (const fx of t.items) if (fx.type === 'effect' && fx.invert && !baked.includes(fx.id)) bake(fx.id, true)
  // 5. regiões que saem do quadro novo (estando dentro do antigo no mesmo instante)
  for (const t of p1.tracks) for (const fx1 of t.items) {
    if (fx1.type !== 'effect') continue
    const fx0 = fxIn(p, fx1.id)
    const D = fx1.durationUs, n = Math.max(10, Math.ceil(D / 100_000))
    for (let i = 0; i <= n; i++) {
      const at = fx1.startUs + Math.min(D - 1, Math.round((D * i) / n))
      const inside = (q: Project, f: EffectItem): boolean => {
        const r = effectRegionAt(q, f, at, 0)
        if (f.invert && !(r.w > 0 && r.h > 0)) return true
        const b = regionAabb(r, q.canvas.width, q.canvas.height), e = 0.5 / Math.max(q.canvas.width, q.canvas.height)
        return b.x0 >= -e && b.y0 >= -e && b.x1 <= 1 + e && b.y1 <= 1 + e
      }
      if (inside(p, fx0) && !inside(p1, fx1)) {
        warnings.push({ itemId: fx1.id, kind: 'outsideFrame', message: MSG.outsideFrame, tUs: at })
        break
      }
    }
  }
  return { project: p1, warnings, anchored: [...anchors.keys()], baked }
}

/**
 * Prévia: os 4 cantos do quadro novo levados ao quadro atual pelo clipe `itemId` no instante (o conteúdo que o quadro
 * novo mostra), normalizados ao quadro atual. null = clipe ausente/invisível.
 */
export function reframeWindow(before: Project, after: Project, itemId: string, tUs: Us): { x: number; y: number }[] | null {
  const find = (q: Project): MediaItem | undefined => q.tracks.flatMap((t) => t.items).find((i) => i.id === itemId && i.type === 'media') as MediaItem | undefined
  const m0 = find(before), m1 = find(after)
  if (!m0 || !m1) return null
  const cf0 = clipFrameAt(before, m0, tUs), cf1 = clipFrameAt(after, m1, tUs)
  if (!cf0 || !cf1) return null
  return [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => screenAt(cf0, contentAt(cf1, x, y)))
}
