// Zoom automático nos cliques (F6, estilo "Screen Studio"): os cliques da trilha do cursor viram keyframes de
// x/y/escala do clipe de tela pela mesma maquinaria do zoom do F4 (zoomPose com clamp, layerBase, spliceKeys). Puro.
//
// Planejamento (planAutoZoom, só tempo): cliques a menos de "duração + transição" um do outro formam um grupo; cada
// grupo é um trecho — ida (transição, curva inOut) que chega à escala cheia NO 1º clique (ou o mais cedo possível,
// se o clique estiver no começo do item), espera seguindo o cursor enquanto houver cliques, volta "duração" depois do
// último. Trechos que se sobreporiam se fundem. Durante a espera o centro do zoom segue o cursor por um filtro
// criticamente amortecido (constante de tempo pela "suavidade").
//
// Aplicação (applyAutoZoom): cada ponto vira uma pose pelo zoomPose com clamp (nunca bordas pretas); o caminho é
// simplificado (≤ AUTO_ZOOM_TOL_PX px do quadro, medido no mesmo instante). x, y e escala ganham keys nos MESMOS
// instantes e com a MESMA curva, então entre dois keys a pose é combinação convexa das duas pontas — e o conjunto de
// poses que cobrem o quadro é convexo em (x, y, escala) para uma geometria base fixa (coverRange é linear na escala):
// se as pontas cobrem, todo instante entre elas cobre. As pontas do trecho são a curva original (continuidade com o
// que vem antes e depois). Geometria base animada (corte/rotação com keys) quebra a premissa: um passe confere cada
// intervalo e insere keys presos onde a interpolação descobriria o quadro.
import { easeValue, evalAnim, insertKeyExact } from './anim'
import { clicksBetween, cursorAt, type CursorTrackV1 } from '../cursor'
import { toScreen, type ClipFrame } from './contentPose'
import { cursorTimeMap, type CursorTimeMap } from './cursorTime'
import { defaultVisual } from './factory'
import { layerBase, type LayerBase } from './layerGeometry'
import { EditError, findItem, updateItem } from './ops'
import { effectsOverClip } from './followTransform'
import { MOVING_EFFECT_MESSAGES, privacyWarnings, type PrivacyWarning } from './privacy'
import type { Anim, Ease, Keyframe, MediaItem, Project, Us } from './project'
import { itemEndUs } from './time'
import { coverBox, keysIn, sourceOf, zoomPose, type ZoomCanvas, type ZoomClampBase, type ZoomEdit, type ZoomPose } from './zoom'

export interface AutoZoomOpts {
  /** "Intensidade": escala do zoom em relação à pose do clipe (1,25–3). */
  scale: number
  /** "Duração": quanto o zoom fica depois do último clique do grupo (ms, 500–6000). */
  holdMs: number
  /** Duração da ida e da volta (ms, 300–1500). */
  transitionMs: number
  /** "Suavidade" do pan que segue o cursor durante o zoom (0–1). */
  smoothing: number
}

export const AUTO_ZOOM_LIMITS: Record<keyof AutoZoomOpts, { min: number; max: number }> = {
  scale: { min: 1.25, max: 3 },
  holdMs: { min: 500, max: 6000 },
  transitionMs: { min: 300, max: 1500 },
  smoothing: { min: 0, max: 1 }
}
export const DEFAULT_AUTO_ZOOM: AutoZoomOpts = { scale: 1.8, holdMs: 1800, transitionMs: 700, smoothing: 0.6 }

/** Constante de tempo do pan (ms): suavidade 0 → 100 ms, 1 → 1000 ms. */
export const AUTO_ZOOM_TAU_MS = { min: 100, max: 1000 } as const
/** Passo da amostragem do caminho durante o zoom (1/60 s). */
export const AUTO_ZOOM_STEP_US = 16_667
/** Tolerância da simplificação do caminho (px do quadro, no mesmo instante). */
export const AUTO_ZOOM_TOL_PX = 1.5

/** Ponto do caminho: centro do zoom no quadro GRAVADO (0–1 da trilha do cursor), instante local do item. */
export interface AutoZoomPathPoint { tUs: Us; x: number; y: number }
/**
 * Trecho de zoom (tempos locais do item, µs): ida em [inUs, fullUs], espera seguindo `path` em [fullUs, outStartUs],
 * volta em [outStartUs, outUs]. Sem tempo para a volta antes do fim do item: outStartUs = outUs = duração (fica no zoom).
 */
export interface AutoZoomSegment {
  inUs: Us; fullUs: Us; outStartUs: Us; outUs: Us
  /** Cliques do grupo. */
  clicks: number
  /** Centro do zoom (pré-simplificação), de fullUs a outStartUs, a cada AUTO_ZOOM_STEP_US. */
  path: AutoZoomPathPoint[]
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const clamp01 = (v: number): number => clamp(v, 0, 1)

/** Opções presas às faixas (valor não finito → padrão). */
export function normalizeAutoZoomOpts(o: Partial<AutoZoomOpts>): AutoZoomOpts {
  const f = (k: keyof AutoZoomOpts): number => {
    const v = o[k]
    return typeof v === 'number' && Number.isFinite(v) ? clamp(v, AUTO_ZOOM_LIMITS[k].min, AUTO_ZOOM_LIMITS[k].max) : DEFAULT_AUTO_ZOOM[k]
  }
  return { scale: f('scale'), holdMs: f('holdMs'), transitionMs: f('transitionMs'), smoothing: f('smoothing') }
}

const tauMs = (smoothing: number): number => AUTO_ZOOM_TAU_MS.min + smoothing * (AUTO_ZOOM_TAU_MS.max - AUTO_ZOOM_TAU_MS.min)

/**
 * Limite de continuidade (declarado e testado): velocidade máxima da pose entre dois instantes quaisquer.
 * - escala: |ds/dt| ≤ 3·(Z − 1)·s0 / T (só nas transições; a curva inOut tem inclinação máxima 3);
 * - centro (px do quadro por s, em x e em y): ≤ max(1,5·(Z·L + max(L, W, H)) / T, Z·L·ω/e), L = s0·max(bw, bh) — o
 *   tamanho da camada na pose base; ω = 1/τ. Transição: o centro anda no máximo a soma das distâncias das duas pontas
 *   ao centro do quadro (cada uma presa pelo coverRange), com inclinação 3/T. Espera: o filtro criticamente amortecido
 *   com alvo constante por passo e alvos em [0, 1] tem |v| ≤ ω/e (variação total da resposta ao impulso 2ω/e × meia
 *   faixa), × Z pela semelhança do zoom; clamp e simplificação (cordas = médias) não aumentam a velocidade.
 * Vale com x/y/escala originais constantes no trecho e rotação múltipla de 90° (outra: × √2).
 */
export function autoZoomSpeedBound(opts: Partial<AutoZoomOpts>, base: { s0: number; bw: number; bh: number; rotation: number }, canvas: ZoomCanvas): { scalePerS: number; pxPerS: number } {
  const o = normalizeAutoZoomOpts(opts)
  const Z = o.scale, T = o.transitionMs / 1000, w = 1000 / tauMs(o.smoothing)
  const L = base.s0 * Math.max(base.bw, base.bh)
  const q = ((base.rotation % 90) + 90) % 90
  const rot = q < 1e-9 || 90 - q < 1e-9 ? 1 : Math.SQRT2
  return { scalePerS: (3 * (Z - 1) * base.s0) / T, pxPerS: rot * Math.max((1.5 * (Z * L + Math.max(L, canvas.w, canvas.h))) / T, (Z * L * w) / Math.E) }
}

/**
 * Cliques que aparecem no trecho usado do clipe, em tempo local (µs, em ordem), com a posição presa ao quadro gravado.
 * A interface usa para habilitar o zoom automático e contar os cliques.
 */
export function itemClicks(track: CursorTrackV1, map: CursorTimeMap): { tUs: Us; x: number; y: number }[] {
  const D = map.durationUs
  const a = D > 0 ? map.toCursorMs(0) : null, b = D > 0 ? map.toCursorMs(D - 1) : null
  if (a === null || b === null) return []
  const out: { tUs: Us; x: number; y: number }[] = []
  for (const c of clicksBetween(track, Math.min(a, b), Math.max(a, b) + 1e-3)) {
    const t = map.toLocalUs(c.tMs)
    if (t !== null) out.push({ tUs: t, x: clamp01(c.x), y: clamp01(c.y) })
  }
  return out.sort((p, q) => p.tUs - q.tUs)
}

interface Group { first: { tUs: Us; x: number; y: number }; last: Us; n: number }
type Timing = Pick<AutoZoomSegment, 'inUs' | 'fullUs' | 'outStartUs' | 'outUs'>

/**
 * Trechos de zoom a partir dos cliques (tempo local pelo `map`, que inclui corte, velocidade e o atraso R11).
 * Puro e O(cliques + amostras do caminho). Mapa decrescente (reverso) é aceito aqui; applyAutoZoom o recusa.
 */
export function planAutoZoom(track: CursorTrackV1, map: CursorTimeMap, opts: Partial<AutoZoomOpts>): AutoZoomSegment[] {
  const o = normalizeAutoZoomOpts(opts)
  const D = map.durationUs
  const T = Math.round(o.transitionMs * 1000), hold = Math.round(o.holdMs * 1000)
  if (!(D > T)) return []
  const clicks = itemClicks(track, map)
  const groups: Group[] = []
  for (const c of clicks) {
    const g = groups[groups.length - 1]
    if (g && c.tUs - g.last < hold + T) {
      g.last = c.tUs
      g.n++
    } else groups.push({ first: c, last: c.tUs, n: 1 })
  }
  const timing = (g: Group): Timing | null => {
    const full = Math.max(g.first.tUs, T)
    if (full >= D) return null
    const outStart = Math.max(full, Math.min(g.last + hold, D - T))
    return outStart + T <= D ? { inUs: full - T, fullUs: full, outStartUs: outStart, outUs: outStart + T } : { inUs: full - T, fullUs: full, outStartUs: D, outUs: D }
  }
  const merged: { g: Group; s: Timing }[] = []
  for (const g of groups) {
    const s = timing(g)
    if (!s) continue
    const prev = merged[merged.length - 1]
    if (prev && s.inUs <= prev.s.outUs) {
      prev.g = { first: prev.g.first, last: g.last, n: prev.g.n + g.n }
      prev.s = timing(prev.g)!
    } else merged.push({ g, s })
  }
  const w = 1000 / tauMs(o.smoothing)
  return merged.map(({ g, s }) => ({ ...s, clicks: g.n, path: followPath(track, map, g.first, s.fullUs, s.outStartUs, w) }))
}

/**
 * Centro do zoom seguindo o cursor de `from` a `to`: filtro criticamente amortecido (x'' = ω²(alvo − x) − 2ωx'),
 * resolvido exatamente com o alvo (posição bruta do cursor, presa ao quadro gravado) constante em cada passo. Parte
 * do clique, parado.
 */
function followPath(track: CursorTrackV1, map: CursorTimeMap, start: Group['first'], from: Us, to: Us, w: number): AutoZoomPathPoint[] {
  const D = map.durationUs
  let x = start.x, y = start.y, vx = 0, vy = 0
  let rx = x, ry = y
  const path: AutoZoomPathPoint[] = [{ tUs: from, x, y }]
  const step = (p: number, v: number, r: number, dt: number): [number, number] => {
    const e = p - r, B = v + w * e, E = Math.exp(-w * dt)
    return [r + (e + B * dt) * E, (B - w * (e + B * dt)) * E]
  }
  for (let t = from; t < to; ) {
    const next = Math.min(t + AUTO_ZOOM_STEP_US, to)
    const ms = map.toCursorMs(Math.min(t, D - 1))
    const c = ms === null ? null : cursorAt(track, ms)
    if (c) {
      rx = clamp01(c.x)
      ry = clamp01(c.y)
    }
    const dt = (next - t) / 1e6
    ;[x, vx] = step(x, vx, rx, dt)
    ;[y, vy] = step(y, vy, ry, dt)
    t = next
    path.push({ tUs: t, x: clamp01(x), y: clamp01(y) })
  }
  return path
}

interface PoseKey { tUs: Us; pose: ZoomPose; ease: Ease }

/**
 * Simplificação Ramer–Douglas–Peucker com distância no MESMO instante (px do quadro): o erro de cada ponto é a
 * distância até a interpolação linear no tempo entre os dois keys mantidos. Pontas sempre ficam.
 */
function simplify(pts: { tUs: Us; pose: ZoomPose }[], canvas: ZoomCanvas, tol: number): { tUs: Us; pose: ZoomPose }[] {
  const n = pts.length
  if (n <= 2) return pts
  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length) {
    const [i, j] = stack.pop()!
    const a = pts[i], b = pts[j]
    const span = b.tUs - a.tUs
    let worst = -1, at = -1
    for (let k = i + 1; k < j; k++) {
      const f = (pts[k].tUs - a.tUs) / span
      const p = pts[k].pose
      const dx = (p.x - (a.pose.x + (b.pose.x - a.pose.x) * f)) * canvas.w
      const dy = (p.y - (a.pose.y + (b.pose.y - a.pose.y) * f)) * canvas.h
      const ds = Math.abs(p.scale - (a.pose.scale + (b.pose.scale - a.pose.scale) * f)) * Math.max(canvas.w, canvas.h)
      const d = Math.max(Math.hypot(dx, dy), ds)
      if (d > worst) {
        worst = d
        at = k
      }
    }
    if (worst > tol) {
      keep[at] = 1
      stack.push([i, at], [at, j])
    }
  }
  return pts.filter((_, k) => keep[k])
}

const FULL = { x: 0.5, y: 0.5, w: 1, h: 1 }
/**
 * Refino: amostras por intervalo entre keys (geometria base fixa: 16 frações bastam — nunca falham; animada: também a
 * cada 1/240 s, porque a faixa permitida anda entre os keys) e quantas vezes um intervalo pode ser dividido.
 */
const REFINE_SAMPLES = 16
const REFINE_DENSE_US = Math.round(1e6 / 240)
const REFINE_DEPTH = 8

/** Erro "não dá" do zoom automático (mensagem para o usuário). */
const refuse = (msg: string): never => {
  throw new EditError('invalid', msg)
}

/**
 * Zoom automático no clipe de tela: grava os keys de x/y/escala dos trechos do planAutoZoom (um passo de desfazer).
 * Só dentro dos trechos os keys existentes de x/y/escala são trocados (`replaced`); fora deles a curva não muda.
 * Efeitos ancorados acompanham (maintainAttachments no edit); efeitos sem âncora sobre o clipe → `privacyWarnings`
 * (as mesmas regras do zoom manual do F4: transformedUnderEffect / unlinkedOverMoving deste clipe).
 * Recusa (EditError 'invalid'): não é clipe de vídeo, sem trilha do cursor, invertido ou congelado (ruling R8), sem
 * clique no trecho usado do clipe.
 */
export function applyAutoZoom(p: Project, itemId: string, track: CursorTrackV1, opts: Partial<AutoZoomOpts>): ZoomEdit & { segments: number; privacyWarnings: PrivacyWarning[] } {
  const f = findItem(p, itemId)
  if (!f || f.item.type !== 'media' || f.track.kind !== 'video') return refuse('O zoom automático só vale para clipes de vídeo')
  const item: MediaItem = f.item
  const asset = p.assets.find((a) => a.id === item.assetId)
  if (!asset || asset.kind !== 'video') return refuse('O zoom automático só vale para clipes de vídeo')
  if (!asset.cursor) return refuse('Este clipe não tem a trilha do cursor gravada')
  if (item.reverse || item.freeze) return refuse('O zoom automático não funciona em clipes invertidos ou congelados')
  const map = cursorTimeMap(p, item)
  if (!map) return refuse('O zoom automático só vale para clipes de vídeo')
  const T = Math.round(normalizeAutoZoomOpts(opts).transitionMs * 1000)
  if (item.durationUs <= T) return refuse(`O clipe é mais curto que a transição (${(T / 1e6).toLocaleString('pt-BR')} s): diminua a Transição ou use um trecho maior`)
  const segs = planAutoZoom(track, map, opts)
  if (segs.length === 0) return refuse('Nenhum clique neste clipe para o zoom automático')
  const Z = normalizeAutoZoomOpts(opts).scale
  const v = item.visual ?? defaultVisual()
  const tr = v.transform
  const canvas: ZoomCanvas = { w: p.canvas.width, h: p.canvas.height }
  const src = sourceOf(p, item)
  const geoAt = (u: Us): { g: LayerBase; clamp: ZoomClampBase } => {
    const c = v.crop
    const g = layerBase({ l: evalAnim(c.l, u), t: evalAnim(c.t, u), r: evalAnim(c.r, u), b: evalAnim(c.b, u) }, v.fit, src, canvas)
    return { g, clamp: { bw: g.bw, bh: g.bh, rotation: evalAnim(tr.rotation, u) } }
  }
  const baseAnimated = [v.crop.l, v.crop.t, v.crop.r, v.crop.b, tr.rotation].some((a) => (a.keys?.length ?? 0) > 0)
  const origAt = (u: Us): ZoomPose => ({ x: evalAnim(tr.x, u), y: evalAnim(tr.y, u), scale: evalAnim(tr.scale, u) })

  const own: Record<keyof ZoomPose, Keyframe<number>[][]> = { x: [], y: [], scale: [] }
  let replaced = 0
  for (const s of segs) {
    replaced += keysIn(tr.x, s.inUs, s.outUs) + keysIn(tr.y, s.inUs, s.outUs) + keysIn(tr.scale, s.inUs, s.outUs)
    // pose base: a do clipe no começo do trecho (os keys de dentro são trocados)
    const B = origAt(s.inUs)
    const zoomAt = (u: Us, P: { x: number; y: number }): ZoomPose => {
      const { g, clamp: cl } = geoAt(u)
      const cf: ClipFrame = { cx: B.x, cy: B.y, rotation: cl.rotation, sx: g.bw * B.scale, sy: g.bh * B.scale, mirror: !!v.mirror, g, W: canvas.w, H: canvas.h }
      // ponto do conteúdo sob o cursor (fonte exibida) → quadro, na pose base; o zoom o leva ao centro (preso às bordas)
      const q = toScreen(cf, P.x * g.dw, P.y * g.dh)
      return zoomPose(B, { x: q.x / canvas.w, y: q.y / canvas.h, w: 1 / Z, h: 1 / Z }, canvas, cl)
    }
    const held = simplify(s.path.map((pt) => ({ tUs: pt.tUs, pose: zoomAt(pt.tUs, pt) })), canvas, AUTO_ZOOM_TOL_PX)
    const hasOut = s.outUs > s.outStartUs
    // pontas = a curva original (continuidade com o que vem antes/depois; se ela já descobre o quadro ali, o refino
    // prende os instantes de dentro do trecho)
    const keys: PoseKey[] = [{ tUs: s.inUs, pose: B, ease: 'inOut' }]
    held.forEach((k, i) => keys.push({ tUs: k.tUs, pose: k.pose, ease: hasOut && i === held.length - 1 ? 'inOut' : 'linear' }))
    if (hasOut) keys.push({ tUs: s.outUs, pose: origAt(s.outUs), ease: 'linear' })
    const clampAt = (u: Us): ZoomClampBase => geoAt(u).clamp
    const refined = refine(keys, clampAt, canvas, baseAnimated)
    // garantia final ("nunca bordas pretas"): com a geometria base animada ou o refino no limite, conferência densa
    const safe = baseAnimated || refined.exhausted ? denseFix(refined.keys, clampAt, canvas) : refined.keys
    for (const k of ['x', 'y', 'scale'] as const) own[k].push(safe.map((q) => ({ tUs: q.tUs, value: q.pose[k], ease: q.ease })))
  }
  const project = updateItem<MediaItem>(p, itemId, (d) => {
    const vis = (d.visual ??= defaultVisual())
    vis.transform.x = spliceMany(tr.x, own.x)
    vis.transform.y = spliceMany(tr.y, own.y)
    vis.transform.scale = spliceMany(tr.scale, own.scale)
  })
  // regra do F4 (efeitos sem âncora cujo tempo e região encostam no clipe: effectsOverClip); o detalhe (instante,
  // texto) vem do privacyWarnings quando ele atribui o aviso a este clipe — ele aponta só o 1º clipe que se move
  const found = privacyWarnings(project, item.startUs, itemEndUs(item))
  const over = effectsOverClip(project, itemId)
  const warnings: PrivacyWarning[] = [
    ...over.linked.map((id) => [id, 'transformedUnderEffect'] as const),
    ...over.unlinked.map((id) => [id, 'unlinkedOverMoving'] as const)
  ].map(([id, kind]) => {
    const w = found.find((x) => x.itemId === id && x.kind === kind && x.mediaItemId === itemId)
    if (w) return w
    const fx = findItem(project, id)!.item
    return { itemId: id, kind, message: MOVING_EFFECT_MESSAGES[kind], tUs: Math.max(fx.startUs, item.startUs + segs[0].inUs), mediaItemId: itemId }
  })
  return { project, replaced, segments: segs.length, privacyWarnings: warnings }
}

/**
 * spliceKeys (zoom.ts) de vários trechos disjuntos e em ordem de uma vez — o mesmo resultado de aplicá-lo trecho a
 * trecho, sem refazer a lista inteira a cada trecho (1 h de gravação = centenas de trechos): a curva original é cortada
 * exatamente (insertKeyExact) nas pontas de todos os trechos, os keys dela dentro de algum trecho saem e o último key de
 * cada trecho herda o ease do pedaço que segue. Fora dos trechos a curva não muda.
 */
function spliceMany(a: Anim<number>, segs: Keyframe<number>[][]): Anim<number> {
  if (!a.keys || a.keys.length === 0) return { value: a.value, keys: segs.flat() }
  let cut = a
  for (const ks of segs) cut = insertKeyExact(insertKeyExact(cut, ks[0].tUs), ks[ks.length - 1].tUs)
  const ck = cut.keys!
  const out: Keyframe<number>[] = []
  let i = 0
  for (const ks of segs) {
    const from = ks[0].tUs, to = ks[ks.length - 1].tUs
    while (i < ck.length && ck[i].tUs < from) out.push(ck[i++])
    while (i < ck.length && ck[i].tUs < to) i++
    const after = i < ck.length && ck[i].tUs === to ? ck[i].ease : 'linear'
    ks.forEach((k, j) => out.push(j === ks.length - 1 ? { ...k, ease: after } : k))
    while (i < ck.length && ck[i].tUs <= to) i++
  }
  while (i < ck.length) out.push(ck[i++])
  return { ...a, keys: out }
}

/**
 * A pose cobre o quadro (quando a camada, pelo tamanho, cobre)? Mesma tolerância de ½ px do coversFrame. Camada menor
 * que o quadro num eixo: nada a conferir (já havia borda nesse eixo).
 */
function poseCovers(pose: ZoomPose, cl: ZoomClampBase, canvas: ZoomCanvas): boolean {
  const [ew, eh] = coverBox(cl.bw * pose.scale, cl.bh * pose.scale, cl.rotation, canvas)
  if (ew < canvas.w || eh < canvas.h) return true
  return Math.abs(pose.x * canvas.w - canvas.w / 2) <= (ew - canvas.w) / 2 + 0.5 && Math.abs(pose.y * canvas.h - canvas.h / 2) <= (eh - canvas.h) / 2 + 0.5
}

/**
 * Confere cada intervalo entre keys (a pose interpolada como evalAnim a calcula: mesma curva nos três) e, onde a
 * interpolação descobriria o quadro, insere um key preso ali e continua dele (o pedaço de antes é conferido de novo,
 * até REFINE_DEPTH divisões). Com a geometria base fixa nunca insere nada (convexidade, ver o topo do arquivo).
 */
function refine(keys: PoseKey[], clampAt: (u: Us) => ZoomClampBase, canvas: ZoomCanvas, dense: boolean): { keys: PoseKey[]; exhausted: boolean } {
  const out: PoseKey[] = [keys[0]]
  let exhausted = false
  const walk = (a: PoseKey, b: PoseKey, depth: number): void => {
    if (depth >= REFINE_DEPTH) exhausted = true
    else if (b.tUs - a.tUs > 2) {
      const n = dense ? Math.max(REFINE_SAMPLES, Math.ceil((b.tUs - a.tUs) / REFINE_DENSE_US)) : REFINE_SAMPLES
      for (let i = 1; i < n; i++) {
        const u = Math.round(a.tUs + ((b.tUs - a.tUs) * i) / n)
        if (u <= a.tUs || u >= b.tUs) continue
        const pose = poseBetween(a, b, u)
        const cl = clampAt(u)
        if (poseCovers(pose, cl, canvas)) continue
        const mid: PoseKey = { tUs: u, pose: zoomPose(pose, FULL, canvas, cl), ease: a.ease }
        // à esquerda o intervalo encurta (profundidade); à direita o avanço é no tempo (sempre termina)
        walk(a, mid, depth + 1)
        walk(mid, b, depth)
        return
      }
    }
    out.push(b)
  }
  for (let i = 1; i < keys.length; i++) walk(keys[i - 1], keys[i], 0)
  return { keys: out, exhausted }
}

/** Pose que a animação dos keys dá em u (a mesma conta do evalAnim, igual nos três). */
function poseBetween(a: PoseKey, b: PoseKey, u: Us): ZoomPose {
  const e = easeValue(a.ease, (u - a.tUs) / (b.tUs - a.tUs))
  return { x: a.pose.x + (b.pose.x - a.pose.x) * e, y: a.pose.y + (b.pose.y - a.pose.y) * e, scale: a.pose.scale + (b.pose.scale - a.pose.scale) * e }
}

/**
 * Conferência densa final: cada instante local múltiplo de 1/240 s (REFINE_DENSE_US) dentro do trecho em que a pose
 * interpolada descobre o quadro ganha um key preso ali (o key fica coberto para sempre); repete até não sobrar falha
 * — termina, porque cada passada transforma ao menos uma amostra em key.
 */
function denseFix(keys: PoseKey[], clampAt: (u: Us) => ZoomClampBase, canvas: ZoomCanvas): PoseKey[] {
  let cur = keys
  for (;;) {
    const add: PoseKey[] = []
    let j = 0
    const last = cur[cur.length - 1].tUs
    for (let u = Math.ceil(cur[0].tUs / REFINE_DENSE_US) * REFINE_DENSE_US; u < last; u += REFINE_DENSE_US) {
      while (cur[j + 1].tUs <= u) j++
      if (u === cur[j].tUs) continue
      const pose = poseBetween(cur[j], cur[j + 1], u)
      const cl = clampAt(u)
      if (!poseCovers(pose, cl, canvas)) add.push({ tUs: u, pose: zoomPose(pose, FULL, canvas, cl), ease: cur[j].ease })
    }
    if (add.length === 0) return cur
    cur = [...cur, ...add].sort((p, q) => p.tUs - q.tUs)
  }
}
