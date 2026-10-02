// "Seguir conteúdo" (F6): rastreamento do conteúdo sob um efeito de privacidade por correlação cruzada normalizada (NCC)
// e conversão do resultado em keys editáveis da região. Puro (sem DOM/Electron/Node).
//
// Quadros de análise (ruling R10): o render worker compõe o projeto com o mesmo resolveFrame + Compositor numa
// resolução reduzida (lado maior ≤ 480 px; até 960 se o molde ficaria pequeno demais) desenhando só as camadas ABAIXO
// do efeito (layersBelowEffect: ele e tudo acima ficam de fora) — o resultado já está nas coordenadas do quadro do
// efeito. Efeito ancorado (`attach`) é recusado (TRACK_ATTACHED_MESSAGE).
//
// Rastreador: molde = caixa da região no quadro inicial (cinza). Busca exaustiva numa janela de ±searchPx em volta da
// última posição, de grosso a fino (pirâmide 2×2 só da região da busca: os 3 melhores máximos locais do nível grosso
// refinados por subida 3×3 em cada nível; no nível 0 só posições dentro da janela) e subpixel por parábola. Escalas opcionais (`scales`, relativas ao
// molde original: 0,9/1/1,1) só no nível 0. Confiança = NCC do melhor ponto.
// - ≥ recoverAbove: 'ok'; entre lostBelow e recoverAbove: 'weak' (aceita, janela 1,5×, folga extra na região);
//   abaixo de lostBelow: perda. Perdido, a posição NUNCA é inventada: fica a última confiante e a janela cresce
//   `growth`× por quadro (até o quadro inteiro); só volta com confiança ≥ recoverAbove (histerese).
// - Molde: o ORIGINAL sempre (sem deriva). Atualização lenta opcional (updateRate > 0, padrão desligado): só com
//   confiança ≥ updateAbove e escala 1 o molde corrente vira (1 − α)·corrente + α·trecho achado; na perda volta ao
//   original (a recuperação procura o conteúdo como o usuário o marcou).
//
// trackToKeys (rulings R4/R4b): um key por quadro analisado em x/y/w/h (rotação: constante do início, se tinha keys
// depois dele). Região de cada quadro = a região do usuário no início transportada pelo deslocamento (e escala) do
// conteúdo, com FOLGA D (px do quadro):
// - confiante: 1 px da análise (erro do subpixel) + o maior deslocamento até os vizinhos confiantes (a interpolação
//   linear entre keys nunca fica atrás do conteúdo, R4b) + meia variação de escala (scaleTol) + 25 % do meio-tamanho
//   em 'weak';
// - perdido: a janela alcançada (reach·√2: o centro pode estar em qualquer ponto do quadrado ±reach) + 1 px.
// Normal: a região CRESCE pela folga (retângulo: meias-larguras + D; elipse: × (1 + D/menor semieixo), que contém a
// elipse somada a um disco de raio D). Invertido (a região é o buraco nítido): ENCOLHE pela folga e, perdido ou sem
// tamanho, vira o buraco nulo (NO_HOLE, a convenção de conservativeRegion) — nunca maior.
// Transições em degrau (keys a 1 µs; nenhum instante inteiro entre eles): normal, ao perder a região ampliada vale logo
// depois do último quadro confiante; ao recuperar, a ampliada (alargada até conter a caixa nova) vale até 1 µs antes do
// key da caixa nova — só encolhe num key em que a caixa nova ⊆ ampliada. Invertido: o buraco fecha/abre em degrau
// (interpolar até NO_HOLE moveria o buraco para o canto, fora do conteúdo).
// Mescla: keys antigos ANTES do início ficam (com um key exato 1 µs antes do início: a curva anterior não muda); do
// início ao fim do efeito, só os novos (o rastreamento vai sempre até o fim; cancelar não aplica nada).
import { evalAnim, insertKeyExact } from './anim'
import { NO_HOLE, type RegionValues } from './contentPose'
import { EditError, findItem, TRACK_ATTACHED_MESSAGE } from './ops'
import type { Anim, EffectItem, EffectRegion, Keyframe, Project, Us } from './project'
import type { Layer } from './resolve'
import { frameToUs, usToFrame } from './time'

export { TRACK_ATTACHED_MESSAGE }

/** Imagem em tons de cinza (0–255), linhas de cima para baixo. */
export interface GrayImage { width: number; height: number; data: Float32Array }
/** Caixa (centro e tamanho) em px da análise. */
export interface TrackBox { x: number; y: number; w: number; h: number }

export interface TrackOpts {
  /** Raio da janela de busca (px da análise) com o rastreamento confiante. */
  searchPx: number
  /** Raio máximo da janela; ausente = o lado maior do quadro (o quadro inteiro). */
  maxSearchPx?: number
  /** Crescimento da janela por quadro perdido. */
  growth: number
  /** Escalas testadas (relativas ao molde original); [1] = só translação. */
  scales: number[]
  /** Abaixo disso o conteúdo foi perdido. */
  lostBelow: number
  /** Confiança alta: 'ok' e mínimo para recuperar uma perda. */
  recoverAbove: number
  /** Atualização lenta do molde: só com confiança ≥ updateAbove; α = updateRate (0 = desligada). */
  updateAbove: number
  updateRate: number
  /** Desvio-padrão mínimo do molde (níveis de cinza): abaixo disso a região é lisa demais para seguir. */
  minStd: number
}

export const DEFAULT_TRACK_OPTS: TrackOpts = { searchPx: 40, growth: 2, scales: [1], lostBelow: 0.6, recoverAbove: 0.85, updateAbove: 0.95, updateRate: 0, minStd: 3 }

export type TrackState = 'ok' | 'weak' | 'lost'

/**
 * Resultado de um quadro analisado: centro (px da análise; perdido = a última posição confiante, segurada), escala
 * relativa ao molde, confiança (NCC, 0–1), estado e, perdido, o raio da janela de busca alcançada.
 */
export interface TrackResult { tUs: Us; x: number; y: number; w: number; h: number; scale: number; confidence: number; state: TrackState; reach: number }

// ---------------------------------------------------------------- imagem

/** Luma BT.601 de um RGBA (linhas de cima para baixo). */
export function grayFromRgba(rgba: Uint8Array, width: number, height: number): GrayImage {
  const n = width * height
  const data = new Float32Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) data[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]
  return { width, height, data }
}

interface Plane { w: number; h: number; d: Float32Array }
/**
 * Nível da pirâmide com as imagens integrais da soma e da soma dos quadrados ((w+1)×(h+1)). (ox, oy): posição do
 * recorte no nível inteiro — a pirâmide é montada só na região da busca; as coordenadas passadas a ncc são do nível
 * inteiro.
 */
interface Level extends Plane { s: Float64Array; s2: Float64Array; ox: number; oy: number }

function withIntegrals(p: Plane, ox: number, oy: number): Level {
  const W1 = p.w + 1
  const s = new Float64Array(W1 * (p.h + 1))
  const s2 = new Float64Array(W1 * (p.h + 1))
  for (let y = 0; y < p.h; y++) {
    let row = 0, row2 = 0
    const o = y * p.w, a = y * W1, b = (y + 1) * W1
    for (let x = 0; x < p.w; x++) {
      const v = p.d[o + x]
      row += v
      row2 += v * v
      s[b + x + 1] = s[a + x + 1] + row
      s2[b + x + 1] = s2[a + x + 1] + row2
    }
  }
  return { ...p, s, s2, ox, oy }
}

/** Metade da resolução (média 2×2). */
function half(p: Plane): Plane {
  const w = Math.floor(p.w / 2), h = Math.floor(p.h / 2)
  const d = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const r0 = 2 * y * p.w, r1 = r0 + p.w
    for (let x = 0; x < w; x++) d[y * w + x] = (p.d[r0 + 2 * x] + p.d[r0 + 2 * x + 1] + p.d[r1 + 2 * x] + p.d[r1 + 2 * x + 1]) / 4
  }
  return { w, h, d }
}

/** Pirâmide do recorte `p` que começa em (ox, oy) do nível 0 (múltiplos de 2^levels: os níveis ficam alinhados). */
function pyramid(p0: Plane, levels: number, ox: number, oy: number): Level[] {
  const out: Level[] = []
  let p = p0
  for (let l = 0; l <= levels; l++) {
    out.push(withIntegrals(p, ox / 2 ** l, oy / 2 ** l))
    if (l < levels) p = half(p)
  }
  return out
}

function crop(p: Plane, x0: number, y0: number, w: number, h: number): Plane {
  const d = new Float32Array(w * h)
  for (let y = 0; y < h; y++) d.set(p.d.subarray((y0 + y) * p.w + x0, (y0 + y) * p.w + x0 + w), y * w)
  return { w, h, d }
}

/** Reamostragem bilinear para w×h (molde em outra escala). */
function resize(p: Plane, w: number, h: number): Plane {
  const d = new Float32Array(w * h)
  const sx = p.w / w, sy = p.h / h
  for (let y = 0; y < h; y++) {
    const fy = Math.min(p.h - 1, Math.max(0, (y + 0.5) * sy - 0.5))
    const y0 = Math.floor(fy), y1 = Math.min(p.h - 1, y0 + 1), ty = fy - y0
    for (let x = 0; x < w; x++) {
      const fx = Math.min(p.w - 1, Math.max(0, (x + 0.5) * sx - 0.5))
      const x0 = Math.floor(fx), x1 = Math.min(p.w - 1, x0 + 1), tx = fx - x0
      const a = p.d[y0 * p.w + x0] * (1 - tx) + p.d[y0 * p.w + x1] * tx
      const b = p.d[y1 * p.w + x0] * (1 - tx) + p.d[y1 * p.w + x1] * tx
      d[y * w + x] = a * (1 - ty) + b * ty
    }
  }
  return { w, h, d }
}

// ---------------------------------------------------------------- molde e NCC

/** Molde normalizado: média zero e norma 1 (NCC = Σ z·I / desvio da janela). */
interface Tpl { w: number; h: number; z: Float32Array }

function normalized(p: Plane): Tpl {
  const n = p.w * p.h
  let m = 0
  for (let i = 0; i < n; i++) m += p.d[i]
  m /= n
  const z = new Float32Array(n)
  let ss = 0
  for (let i = 0; i < n; i++) {
    const v = p.d[i] - m
    z[i] = v
    ss += v * v
  }
  const k = ss > 0 ? 1 / Math.sqrt(ss) : 0
  for (let i = 0; i < n; i++) z[i] *= k
  return { w: p.w, h: p.h, z }
}

const std = (p: Plane): number => {
  const n = p.w * p.h
  let s = 0, s2 = 0
  for (let i = 0; i < n; i++) {
    s += p.d[i]
    s2 += p.d[i] * p.d[i]
  }
  return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2))
}

/** NCC do molde com o canto superior esquerdo em (u, v) do nível (coordenadas do nível inteiro, dentro do recorte). */
function ncc(L: Level, t: Tpl, gu: number, gv: number): number {
  const u = gu - L.ox, v = gv - L.oy
  const w = L.w, d = L.d, z = t.z, tw = t.w, th = t.h
  let dot = 0
  for (let j = 0; j < th; j++) {
    const r = (v + j) * w + u, q = j * tw
    for (let i = 0; i < tw; i++) dot += z[q + i] * d[r + i]
  }
  const W1 = w + 1, n = tw * th
  const a = v * W1 + u, b = a + tw, c = (v + th) * W1 + u, e = c + tw
  const sum = L.s[e] - L.s[b] - L.s[c] + L.s[a]
  const sq = L.s2[e] - L.s2[b] - L.s2[c] + L.s2[a]
  const varI = sq - (sum * sum) / n
  if (!(varI > 1e-6 * n)) return 0
  return dot / Math.sqrt(varI)
}

/** Molde por nível da pirâmide (até o lado menor ficar < MIN_LEVEL_PX) e nas escalas extras (nível 0). */
interface TplSet { patch: Plane; levels: Tpl[]; scaled: { s: number; t: Tpl }[] }
const MIN_LEVEL_PX = 6
/** Lado mínimo do molde (px da análise). */
const MIN_TPL_PX = 8

function tplSet(patch: Plane, scales: number[]): TplSet {
  const levels: Tpl[] = [normalized(patch)]
  let p = patch
  while (Math.min(Math.floor(p.w / 2), Math.floor(p.h / 2)) >= MIN_LEVEL_PX && levels.length < 4) {
    p = half(p)
    levels.push(normalized(p))
  }
  const scaled = scales.filter((s) => s !== 1).map((s) => ({ s, t: normalized(resize(patch, Math.max(MIN_LEVEL_PX, Math.round(patch.w * s)), Math.max(MIN_LEVEL_PX, Math.round(patch.h * s)))) }))
  return { patch, levels, scaled }
}

// ---------------------------------------------------------------- rastreador

/** Estado do rastreador (imutável entre quadros: cada passo devolve um novo). */
export interface Tracker {
  readonly opts: TrackOpts
  readonly box: TrackBox
  /** Canto superior esquerdo inteiro do molde no quadro inicial (px da análise). */
  readonly tx0: number
  readonly ty0: number
  readonly orig: TplSet
  readonly cur: TplSet
  /** Centro atual (perdido: o último confiante). */
  readonly pos: { x: number; y: number }
  readonly scale: number
  readonly radius: number
  readonly lost: boolean
  readonly reach: number
}

interface Found { x: number; y: number; scale: number; score: number; u: number; v: number }

const TOP_K = 3
/** Passos da subida 3×3 em cada nível do refinamento. */
const HILL_STEPS = 4

/** Melhor posição do molde na janela de raio r (Chebyshev, em px da análise) em volta de tr.pos. */
function locate(tr: Tracker, img: GrayImage, r: number): Found | null {
  const set = tr.cur
  const t0 = set.levels[0]
  // nível grosso: a janela cabe em ~12 px nele (e o molde ainda tem ≥ MIN_LEVEL_PX)
  let top = 0
  while (top < set.levels.length - 1 && r / 2 ** top > 12) top++
  const k = 2 ** top
  // canto previsto (nível 0): centro − meio molde, com o deslocamento desde o quadro inicial
  const cu0 = tr.tx0 + (tr.pos.x - tr.box.x), cv0 = tr.ty0 + (tr.pos.y - tr.box.y)
  const uMin = Math.max(0, Math.ceil(cu0 - r)), uMax = Math.min(img.width - t0.w, Math.floor(cu0 + r))
  const vMin = Math.max(0, Math.ceil(cv0 - r)), vMax = Math.min(img.height - t0.h, Math.floor(cv0 + r))
  if (uMin > uMax || vMin > vMax) return null
  // pirâmide só da região da busca (custo por quadro proporcional à janela, não ao quadro): janela + molde (o maior das
  // escalas) + margem para o refinamento e o subpixel; o canto alinhado a 2^top. Fora do recorte, score = −∞ (a busca
  // do nível 0 fica sempre dentro da janela, que o recorte contém)
  const m = 3 * k + 2
  const big = Math.max(t0.w, ...set.scaled.map((x) => x.t.w)), bigH = Math.max(t0.h, ...set.scaled.map((x) => x.t.h))
  const rx0 = Math.max(0, Math.floor((uMin - m) / k) * k), ry0 = Math.max(0, Math.floor((vMin - m) / k) * k)
  const rx1 = Math.min(img.width, uMax + big + m + k), ry1 = Math.min(img.height, vMax + bigH + m + k)
  const pyr = pyramid(crop({ w: img.width, h: img.height, d: img.data }, rx0, ry0, rx1 - rx0, ry1 - ry0), top, rx0, ry0)
  const L0 = pyr[0]
  // busca exaustiva no nível grosso: os TOP_K melhores máximos locais
  const T = set.levels[top], L = pyr[top]
  const gu0 = Math.max(L.ox, Math.floor(uMin / k)), gu1 = Math.min(L.ox + L.w - T.w, Math.ceil(uMax / k))
  const gv0 = Math.max(L.oy, Math.floor(vMin / k)), gv1 = Math.min(L.oy + L.h - T.h, Math.ceil(vMax / k))
  const gw = gu1 - gu0 + 1, gh = gv1 - gv0 + 1
  let cands: { u: number; v: number; s: number }[] = []
  if (gw > 0 && gh > 0) {
    const grid = new Float32Array(gw * gh)
    for (let v = gv0; v <= gv1; v++) for (let u = gu0; u <= gu1; u++) grid[(v - gv0) * gw + (u - gu0)] = ncc(L, T, u, v)
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const s = grid[j * gw + i]
        let peak = true
        for (let dj = -1; dj <= 1 && peak; dj++) for (let di = -1; di <= 1; di++) {
          if ((di || dj) && i + di >= 0 && i + di < gw && j + dj >= 0 && j + dj < gh && grid[(j + dj) * gw + i + di] > s) { peak = false; break }
        }
        if (!peak) continue
        cands.push({ u: i + gu0, v: j + gv0, s })
        if (cands.length > TOP_K) {
          cands.sort((a, b) => b.s - a.s)
          cands = cands.slice(0, TOP_K)
        }
      }
    }
  }
  // refinamento por nível (subida 3×3 a partir do ponto dobrado, até ±HILL_STEPS); no nível 0, só dentro da janela.
  // Candidatos bem piores que o melhor do nível grosso não são refinados.
  const coarseBest = cands.reduce((a, c) => Math.max(a, c.s), -Infinity)
  let best: { u: number; v: number; s: number } | null = null
  for (const c of cands) {
    if (c.s < coarseBest - 0.25) continue
    let u = c.u, v = c.v, s = c.s
    for (let l = top - 1; l >= 0; l--) {
      const Tl = set.levels[l], Ll = pyr[l]
      const lo = l === 0 ? { u: uMin, v: vMin } : { u: Ll.ox, v: Ll.oy }
      const hi = l === 0 ? { u: uMax, v: vMax } : { u: Ll.ox + Ll.w - Tl.w, v: Ll.oy + Ll.h - Tl.h }
      const seen = new Map<number, number>()
      const score = (uu: number, vv: number): number => {
        if (uu < lo.u || uu > hi.u || vv < lo.v || vv > hi.v) return -Infinity
        const key = vv * 65536 + uu
        let sc = seen.get(key)
        if (sc === undefined) seen.set(key, (sc = ncc(Ll, Tl, uu, vv)))
        return sc
      }
      // ponto de partida dentro dos limites
      let cu = Math.min(hi.u, Math.max(lo.u, 2 * u)), cv = Math.min(hi.v, Math.max(lo.v, 2 * v))
      if (lo.u > hi.u || lo.v > hi.v) { s = -Infinity; break }
      let cs = score(cu, cv)
      for (let step = 0; step < HILL_STEPS; step++) {
        let nu = cu, nv = cv, ns = cs
        for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) {
          const sc = score(cu + du, cv + dv)
          if (sc > ns) { ns = sc; nu = cu + du; nv = cv + dv }
        }
        if (nu === cu && nv === cv) break
        cu = nu; cv = nv; cs = ns
      }
      u = cu; v = cv; s = cs
    }
    if (top === 0 && (u < uMin || u > uMax || v < vMin || v > vMax)) continue
    if (s > -Infinity && (!best || s > best.s)) best = { u, v, s }
  }
  if (!best) return null
  // subpixel (parábola em x e em y) com o molde de escala 1
  const sub = (l: number, c: number, rr: number): number => {
    const den = l - 2 * c + rr
    return den < 0 ? Math.max(-0.5, Math.min(0.5, (l - rr) / (2 * den))) : 0
  }
  const at = (u: number, v: number, t: Tpl): number | null => (u >= L0.ox && v >= L0.oy && u <= L0.ox + L0.w - t.w && v <= L0.oy + L0.h - t.h ? ncc(L0, t, u, v) : null)
  const refine = (u: number, v: number, s: number, t: Tpl): { ox: number; oy: number } => {
    const l = at(u - 1, v, t), rr = at(u + 1, v, t), up = at(u, v - 1, t), dn = at(u, v + 1, t)
    return { ox: l !== null && rr !== null ? sub(l, s, rr) : 0, oy: up !== null && dn !== null ? sub(up, s, dn) : 0 }
  }
  // centro do molde de escala 1 no quadro inicial: tx0 + w/2 (≈ box.x); deslocamento = canto − canto inicial
  let out: Found
  {
    const o = refine(best.u, best.v, best.s, t0)
    out = { x: tr.box.x + (best.u + o.ox - tr.tx0), y: tr.box.y + (best.v + o.oy - tr.ty0), scale: 1, score: best.s, u: best.u, v: best.v }
  }
  // escalas extras: em volta do centro achado (±2 px), molde reamostrado
  for (const { s: sc, t } of set.scaled) {
    const cx = best.u + t0.w / 2, cy = best.v + t0.h / 2
    const u0 = Math.round(cx - t.w / 2), v0 = Math.round(cy - t.h / 2)
    let bs = -Infinity, bu = u0, bv = v0
    for (let dv = -2; dv <= 2; dv++) for (let du = -2; du <= 2; du++) {
      const sc2 = at(u0 + du, v0 + dv, t)
      if (sc2 !== null && sc2 > bs) { bs = sc2; bu = u0 + du; bv = v0 + dv }
    }
    if (!(bs > out.score)) continue
    const o = refine(bu, bv, bs, t)
    // centro deste molde = canto + meio molde dele; o do molde de escala 1 no início = tx0 + w/2
    out = { x: tr.box.x + (bu + o.ox + t.w / 2 - (tr.tx0 + t0.w / 2)), y: tr.box.y + (bv + o.oy + t.h / 2 - (tr.ty0 + t0.h / 2)), scale: sc, score: bs, u: bu, v: bv }
  }
  return out
}

/** Começa o rastreamento no 1º quadro com o molde na caixa `box` (px da análise). EditError: região inválida. */
export function startTracker(first: GrayImage, box: TrackBox, tUs: Us, opts: Partial<TrackOpts> = {}): { tracker: Tracker; result: TrackResult } {
  const o: TrackOpts = { ...DEFAULT_TRACK_OPTS, ...opts }
  const x0 = Math.max(0, Math.round(box.x - box.w / 2)), y0 = Math.max(0, Math.round(box.y - box.h / 2))
  const x1 = Math.min(first.width, Math.round(box.x + box.w / 2)), y1 = Math.min(first.height, Math.round(box.y + box.h / 2))
  if (x1 - x0 < MIN_TPL_PX || y1 - y0 < MIN_TPL_PX) throw new EditError('invalid', 'A região é pequena demais (ou está fora do quadro) para seguir o conteúdo: aumente-a sobre o que deve ser escondido.')
  const patch = crop({ w: first.width, h: first.height, d: first.data }, x0, y0, x1 - x0, y1 - y0)
  if (std(patch) < o.minStd) throw new EditError('invalid', 'A região está sobre uma área lisa, sem detalhe para seguir: posicione-a sobre o conteúdo a esconder.')
  const set = tplSet(patch, o.scales)
  const tracker: Tracker = { opts: o, box, tx0: x0, ty0: y0, orig: set, cur: set, pos: { x: box.x, y: box.y }, scale: 1, radius: o.searchPx, lost: false, reach: 0 }
  return { tracker, result: { tUs, x: box.x, y: box.y, w: box.w, h: box.h, scale: 1, confidence: 1, state: 'ok', reach: 0 } }
}

/** Um quadro: procura o conteúdo, decide confiança/perda/recuperação e devolve o novo estado. */
export function trackNext(tr: Tracker, img: GrayImage, tUs: Us): { tracker: Tracker; result: TrackResult } {
  const o = tr.opts
  const r = tr.radius
  const maxR = o.maxSearchPx ?? Math.max(img.width, img.height)
  const f = locate(tr, img, r)
  const conf = Math.max(0, Math.min(1, f?.score ?? 0))
  const res = (x: number, y: number, scale: number, state: TrackState, reach: number): TrackResult => ({ tUs, x, y, w: tr.box.w * scale, h: tr.box.h * scale, scale, confidence: conf, state, reach })
  const accept = f && (tr.lost ? conf >= o.recoverAbove : conf >= o.lostBelow)
  if (f && accept) {
    const ok = conf >= o.recoverAbove
    let cur = tr.lost ? tr.orig : tr.cur
    if (o.updateRate > 0 && ok && conf >= o.updateAbove && f.scale === 1) {
      const fresh = crop({ w: img.width, h: img.height, d: img.data }, f.u, f.v, cur.patch.w, cur.patch.h)
      const d = new Float32Array(fresh.d.length)
      for (let i = 0; i < d.length; i++) d[i] = (1 - o.updateRate) * cur.patch.d[i] + o.updateRate * fresh.d[i]
      cur = tplSet({ w: fresh.w, h: fresh.h, d }, o.scales)
    }
    const next: Tracker = { ...tr, cur, pos: { x: f.x, y: f.y }, scale: f.scale, radius: ok ? o.searchPx : Math.min(maxR, r * 1.5), lost: false, reach: 0 }
    return { tracker: next, result: res(f.x, f.y, f.scale, ok ? 'ok' : 'weak', 0) }
  }
  // perda: segura a última posição confiante; a janela desta busca entra no alcance e cresce para o próximo quadro
  const reach = Math.max(tr.lost ? tr.reach : 0, r)
  const next: Tracker = { ...tr, cur: tr.orig, radius: Math.min(maxR, r * o.growth), lost: true, reach }
  return { tracker: next, result: res(tr.pos.x, tr.pos.y, tr.scale, 'lost', reach) }
}

/** Rastreia uma sequência de quadros (o 1º define o molde). */
export function trackFrames(frames: readonly { tUs: Us; img: GrayImage }[], box: TrackBox, opts: Partial<TrackOpts> = {}): TrackResult[] {
  if (frames.length === 0) return []
  const s = startTracker(frames[0].img, box, frames[0].tUs, opts)
  let tr = s.tracker
  const out = [s.result]
  for (let i = 1; i < frames.length; i++) {
    const n = trackNext(tr, frames[i].img, frames[i].tUs)
    tr = n.tracker
    out.push(n.result)
  }
  return out
}

// ---------------------------------------------------------------- geometria da análise

/** Lado maior da análise e o máximo quando o molde ficaria pequeno. */
export const ANALYSIS_LONG_PX = 480
export const ANALYSIS_LONG_MAX_PX = 960
const GOOD_TPL_PX = 16

/** Tamanho dos quadros de análise para um quadro W×H e a caixa da região (px do quadro). */
export function analysisSize(W: number, H: number, regionPx: { w: number; h: number }): { width: number; height: number } {
  const longest = Math.max(W, H)
  let s = Math.min(1, ANALYSIS_LONG_PX / longest)
  if (Math.min(regionPx.w, regionPx.h) * s < GOOD_TPL_PX) s = Math.min(1, ANALYSIS_LONG_MAX_PX / longest)
  return { width: Math.max(1, Math.round(W * s)), height: Math.max(1, Math.round(H * s)) }
}

const valuesAt = (r: EffectRegion, local: Us): RegionValues => ({ x: evalAnim(r.x, local), y: evalAnim(r.y, local), w: evalAnim(r.w, local), h: evalAnim(r.h, local), rotation: evalAnim(r.rotation, local) })

/** Meias-extensões (px do quadro) da caixa alinhada aos eixos que contém a região (retângulo/elipse girados). */
function aabbHalf(v: RegionValues, shape: EffectRegion['shape'], W: number, H: number): { ex: number; ey: number } {
  const hw = (Math.abs(v.w) * W) / 2, hh = (Math.abs(v.h) * H) / 2
  const th = (v.rotation * Math.PI) / 180, c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th))
  if (shape === 'rect') return { ex: c * hw + s * hh, ey: s * hw + c * hh }
  return { ex: Math.sqrt((hw * c) ** 2 + (hh * s) ** 2), ey: Math.sqrt((hw * s) ** 2 + (hh * c) ** 2) }
}

/** Tamanho (px do quadro) da caixa da região do efeito no instante local. */
export function regionExtentPx(fx: EffectItem, local: Us, W: number, H: number): { w: number; h: number } {
  const e = aabbHalf(valuesAt(fx.region, local), fx.region.shape, W, H)
  return { w: 2 * e.ex, h: 2 * e.ey }
}

export interface TrackGeometry { analysisW: number; analysisH: number; canvasW: number; canvasH: number }

/** Caixa do molde (px da análise): a caixa alinhada que contém a região no instante local. */
export function templateBox(fx: EffectItem, local: Us, g: TrackGeometry): TrackBox {
  const v = valuesAt(fx.region, local)
  const e = aabbHalf(v, fx.region.shape, g.canvasW, g.canvasH)
  return { x: v.x * g.analysisW, y: v.y * g.analysisH, w: (2 * e.ex * g.analysisW) / g.canvasW, h: (2 * e.ey * g.analysisH) / g.canvasH }
}

/** Instantes analisados: o de partida (playhead) e depois os da grade de quadros do projeto, até `toUs` (exclusivo). */
export function trackFrameTimes(fromUs: Us, toUs: Us, fps: number): Us[] {
  if (fromUs >= toUs) return []
  const out = [fromUs]
  for (let n = usToFrame(fromUs, fps) + 1; ; n++) {
    const t = frameToUs(n, fps)
    if (t >= toUs) break
    if (t > fromUs) out.push(t)
  }
  return out
}

/**
 * Camadas abaixo do efeito (quadros de análise, R10): o efeito e tudo o que vem depois dele na ordem de desenho
 * ficam de fora (escopo `track`: o resolve já o pôs logo depois da camada da faixa-alvo). Efeito ausente → todas.
 */
export function layersBelowEffect(layers: Layer[], fxId: string): Layer[] {
  const i = layers.findIndex((l) => l.kind === 'effect' && l.itemId === fxId)
  return i < 0 ? layers : layers.slice(0, i)
}

/** Projeto dos quadros de análise: o efeito (mesmo desativado, ou numa faixa oculta) entra no resolve para o corte. */
export function trackingProject(p: Project, fxId: string): Project {
  const f = findItem(p, fxId)
  if (!f || (f.item.enabled !== false && !f.track.hidden)) return p
  return {
    ...p,
    tracks: p.tracks.map((t, i) => {
      if (i !== f.trackIndex) return t
      return { ...t, hidden: false, items: t.items.map((it) => (it.id === fxId ? (({ enabled: _e, ...rest }) => rest)(it) : it)) }
    })
  }
}

/** Motivo (pt-BR) pelo qual o efeito não pode seguir o conteúdo; null = pode. */
export function trackingBlocker(p: Project, fxId: string): string | null {
  const f = findItem(p, fxId)
  if (!f || f.item.type !== 'effect') return 'Efeito não encontrado.'
  if (f.item.attach) return TRACK_ATTACHED_MESSAGE
  if (f.track.locked) return 'A faixa deste efeito está bloqueada.'
  return null
}

// ---------------------------------------------------------------- resultado → keys

export interface TrackKeysOpts {
  /** Incerteza relativa da escala (multiescala: meio passo, ex. 0,05); 0 sem multiescala. */
  scaleTol?: number
  /** Folga extra dos quadros 'weak' (fração do meio-tamanho da região). */
  weakPadFrac?: number
}

/** Confiança por quadro (tempo LOCAL ao efeito) para a faixa da timeline. */
export interface TrackSample { tUs: Us; confidence: number; state: TrackState }

export interface TrackKeysResult {
  region: EffectRegion
  /** Primeiro instante (absoluto) de cada perda. */
  lost: { tUs: Us }[]
  samples: TrackSample[]
}

/** Região alargada (D > 0) ou encolhida (D < 0) pela folga D (px do quadro); null = sumiu. */
function inflate(v: RegionValues, shape: EffectRegion['shape'], D: number, W: number, H: number): RegionValues | null {
  const hx = (Math.abs(v.w) * W) / 2, hy = (Math.abs(v.h) * H) / 2
  let ex: number, ey: number
  if (shape === 'rect') {
    ex = hx + D
    ey = hy + D
  } else {
    const k = 1 + D / Math.max(1e-9, Math.min(hx, hy))
    ex = hx * k
    ey = hy * k
  }
  if (!(ex > 0 && ey > 0)) return null
  return { ...v, w: (2 * ex) / W, h: (2 * ey) / H }
}

/** Keys antigos antes de `a` (com um key exato em a − 1: a curva anterior não muda) + os novos. */
function merged(prev: Anim<number>, a: Us, fresh: Keyframe<number>[]): Anim<number> {
  let kept: Keyframe<number>[] = []
  if (a > 0) {
    const withEdge = prev.keys?.length ? insertKeyExact(prev, a - 1) : { ...prev, keys: [{ tUs: a - 1, value: prev.value, ease: 'linear' as const }] }
    kept = withEdge.keys!.filter((k) => k.tUs < a)
    if (kept.length) kept[kept.length - 1] = { ...kept[kept.length - 1], ease: 'linear' }
  }
  const keys = [...kept, ...fresh]
  return { value: keys[0].value, keys }
}

/** Resultado do rastreamento → região com keys (ver o topo do arquivo: R4, R4b, degraus e mescla). */
export function trackToKeys(fx: EffectItem, results: readonly TrackResult[], g: TrackGeometry, o: TrackKeysOpts = {}): TrackKeysResult {
  if (fx.attach) throw new EditError('invalid', TRACK_ATTACHED_MESSAGE)
  if (results.length === 0) return { region: fx.region, lost: [], samples: [] }
  const W = g.canvasW, H = g.canvasH
  const kx = W / g.analysisW, ky = H / g.analysisH
  const unit = Math.max(kx, ky) // 1 px da análise no quadro
  const scaleTol = o.scaleTol ?? 0, weakPad = o.weakPadFrac ?? 0.25
  const shape = fx.region.shape
  const a = results[0].tUs - fx.startUs
  const R0 = valuesAt(fx.region, a)
  const r0 = results[0]
  const n = results.length
  const conf = (i: number): boolean => i >= 0 && i < n && results[i].state !== 'lost'
  const placed = (r: TrackResult): RegionValues => ({ x: R0.x + (r.x - r0.x) / g.analysisW, y: R0.y + (r.y - r0.y) / g.analysisH, w: R0.w * r.scale, h: R0.h * r.scale, rotation: R0.rotation })
  const disp = (p: TrackResult, q: TrackResult): number => Math.hypot((p.x - q.x) * kx, (p.y - q.y) * ky)
  const halfMax = (v: RegionValues): number => Math.max(Math.abs(v.w) * W, Math.abs(v.h) * H) / 2
  const D: number[] = []
  const vals: RegionValues[] = []
  for (let i = 0; i < n; i++) {
    const r = results[i]
    const base = placed(r)
    let d: number
    if (conf(i)) {
      const neigh = Math.max(conf(i - 1) ? disp(r, results[i - 1]) : 0, conf(i + 1) ? disp(r, results[i + 1]) : 0)
      d = unit + neigh + scaleTol * halfMax(base) + (r.state === 'weak' ? weakPad * halfMax(base) : 0)
    } else d = unit + r.reach * Math.hypot(kx, ky) + scaleTol * halfMax(base)
    D.push(d)
    vals.push(fx.invert ? (conf(i) ? (inflate(base, shape, -d, W, H) ?? NO_HOLE) : NO_HOLE) : inflate(base, shape, d, W, H)!)
  }
  const open = (v: RegionValues): boolean => v.w > 0 && v.h > 0
  const kind = (i: number): string => (fx.invert ? (open(vals[i]) ? 'open' : 'closed') : conf(i) ? 'track' : 'grown')
  const samples: { t: Us; v: RegionValues }[] = []
  for (let i = 0; i < n; i++) {
    const t = results[i].tUs - fx.startUs
    if (i > 0 && kind(i) !== kind(i - 1)) {
      const tp = results[i - 1].tUs - fx.startUs
      if (t - tp >= 3) {
        if (fx.invert) samples.push(kind(i) === 'closed' ? { t: tp + 1, v: NO_HOLE } : { t: t - 1, v: NO_HOLE })
        else if (kind(i) === 'grown') samples.push({ t: tp + 1, v: vals[i] })
        else {
          // recuperação: a ampliada (centro segurado) alargada até conter a caixa nova vale até 1 µs antes dela
          const held = results[i - 1], cur = results[i]
          const need = D[i] + disp(cur, held) + Math.max(0, cur.scale - held.scale) * halfMax(R0)
          samples.push({ t: t - 1, v: inflate(placed(held), shape, Math.max(D[i - 1], need), W, H)! })
        }
      }
    }
    samples.push({ t, v: vals[i] })
  }
  const keysOf = (c: 'x' | 'y' | 'w' | 'h'): Keyframe<number>[] => samples.map((s) => ({ tUs: s.t, value: s.v[c], ease: 'linear' }))
  const r = fx.region
  const rotation = (r.rotation.keys ?? []).some((k) => k.tUs >= a) ? merged(r.rotation, a, [{ tUs: a, value: R0.rotation, ease: 'linear' }]) : r.rotation
  const region: EffectRegion = { shape, x: merged(r.x, a, keysOf('x')), y: merged(r.y, a, keysOf('y')), w: merged(r.w, a, keysOf('w')), h: merged(r.h, a, keysOf('h')), rotation }
  const lost: { tUs: Us }[] = []
  for (let i = 0; i < n; i++) if (!conf(i) && conf(i - 1)) lost.push({ tUs: results[i].tUs })
  return { region, lost, samples: results.map((x) => ({ tUs: x.tUs - fx.startUs, confidence: x.confidence, state: x.state })) }
}

// ---------------------------------------------------------------- textos

/** "mm:ss,d" (décimos de segundo, truncados). */
export function formatTrackTime(us: Us): string {
  const tenths = Math.floor(Math.max(0, us) / 100_000)
  const p2 = (v: number): string => String(v).padStart(2, '0')
  return `${p2(Math.floor(tenths / 600))}:${p2(Math.floor(tenths / 10) % 60)},${tenths % 10}`
}

/** Toast da perda (instante absoluto da timeline). */
export function lossMessage(l: { tUs: Us }, invert: boolean): string {
  return `Rastreamento perdido em ${formatTrackTime(l.tUs)} — ${invert ? 'o buraco foi fechado' : 'a região foi ampliada'}; revise`
}
