// "Seguir conteúdo" (F6): rastreamento do conteúdo sob um efeito de privacidade por correlação cruzada normalizada (NCC)
// e conversão do resultado em keys editáveis da região. Puro (sem DOM/Electron/Node).
//
// Quadros de análise (ruling R10): o render worker compõe o projeto com o mesmo resolveFrame + Compositor numa
// resolução reduzida (lado maior ≤ 480 px; até 960 se o molde ficaria pequeno demais) desenhando só as camadas ABAIXO
// do efeito (layersBelowEffect: ele e tudo acima ficam de fora) — o resultado já está nas coordenadas do quadro do
// efeito. Efeito ancorado (`attach`) é recusado (TRACK_ATTACHED_MESSAGE).
//
// Rastreador (rulings R4, R19, R20): molde = caixa da região no quadro inicial (cinza), sempre o ORIGINAL (sem
// atualização: nada de deriva; a escala é refeita por reamostragem dele). Picos de NCC numa janela de ±searchPx em volta
// da previsão (posição + movimento recente), de grosso a fino (pirâmide 2×2 só da região da busca; os melhores máximos
// do nível grosso refinados por subida 3×3; no nível 0 só dentro da janela), subpixel por parábola. Um quadro só é
// 'ok' (verde) e move a região se TODOS valem:
// - confiança ≥ okAbove (0,85; texto fino reamostrado a 480 px com deslocamento subpixel fica em ~0,9);
// - não ambíguo: o 2º pico (fora de meio molde do 1º) fica a mais de ambiguityMargin (0,1) do melhor — conteúdo
//   repetido/parecido na janela (linhas de tabela, cópia do valor) não decide nada;
// - dentro do portão de movimento: ≤ 2·gateMinPx + 2·|v| da previsão (|v| = movimento entre os dois últimos 'ok');
// - rígido: as células com textura do molde (~16 px) concordam com o casamento num ajuste translação + escala
//   (resíduo ≤ 0,75 px; ≥ 2 discordando = dois movimentos dentro da região, como uma região folgada sobre fundo
//   parado — nenhuma translação única cobre os dois).
// Senão o rastreamento confiante ACABA (ruling R21): desse quadro até o fim do trecho a posição fica segurada (a
// última 'ok' — nunca inventada), a cobertura (reach) cresce `growth`× por quadro até o quadro inteiro (normal) e o
// buraco do invertido é o nulo. Não há recuperação automática: um conteúdo idêntico (cópia, fantasma de arrasto) que
// aparece enquanto o alvo está escondido seria indistinguível dele. Para continuar, o usuário reposiciona a região num
// quadro posterior e roda "Seguir conteúdo" de novo dali (a mescla mantém os keys de antes). O 1º quadro da perda é
// 'weak' (âmbar) quando havia um pico plausível perto da previsão, senão 'lost'; o resto é 'lost'.
// Escala (R20) sempre estimada: passos de scaleStep (3 %) a partir da atual enquanto o NCC melhora ≥ 0,003
// (histerese: sem deriva); as sondas vizinhas que não se separam da escolhida são incerteza não resolvida, [scaleLo,
// scaleHi] — a região normal usa a maior e o buraco do invertido a menor, mais meio passo de folga.
//
// trackToKeys (rulings R4/R4b): um key por quadro analisado em x/y/w/h (rotação: constante do início, se tinha keys
// depois dele). Região de cada quadro = a região do usuário no início transportada pelo deslocamento (e escala) do
// conteúdo, com FOLGA D (px do quadro):
// - 'ok': 1 px da análise (erro do subpixel) + o maior movimento de borda até os vizinhos 'ok' (centro + mudança de
//   escala: a interpolação linear entre keys nunca fica atrás do conteúdo, R4b) + meio passo de escala (scaleTol);
// - 'weak'/'lost': a cobertura alcançada (reach·√2: o centro pode estar em qualquer ponto do quadrado ±reach) + 1 px.
// Normal: a região CRESCE pela folga (retângulo: meias-larguras + D; elipse: × (1 + D/menor semieixo), que contém a
// elipse somada a um disco de raio D). Invertido (a região é o buraco nítido): ENCOLHE pela folga e, perdido ou sem
// tamanho, vira o buraco nulo (NO_HOLE, a convenção de conservativeRegion) — nunca maior.
// Transições em degrau (keys a 1 µs — também quando os quadros estão a só 2 µs; nenhum instante inteiro fica entre o
// último seguro e o degrau): normal, ao perder a região ampliada vale logo
// depois do último quadro confiante (e não encolhe mais: R21). Invertido: o buraco fecha/abre em degrau
// (interpolar até NO_HOLE moveria o buraco para o canto, fora do conteúdo).
// Mescla: keys antigos ANTES do início ficam (com um key exato 1 µs antes do início: a curva anterior não muda); do
// início ao fim do efeito, só os novos (o rastreamento vai sempre até o fim; cancelar não aplica nada).
import { evalAnim, insertKeyExact } from './anim'
import { NO_HOLE, type RegionValues } from './contentPose'
import { EditError, findItem, TRACK_ATTACHED_MESSAGE } from './ops'
import type { Anim, EffectItem, EffectRegion, Item, Keyframe, Project, Us } from './project'
import type { Layer } from './resolve'
import { frameToUs, usToFrame } from './time'

export { TRACK_ATTACHED_MESSAGE }

/** Imagem em tons de cinza (0–255), linhas de cima para baixo. */
export interface GrayImage { width: number; height: number; data: Float32Array }
/** Caixa (centro e tamanho) em px da análise. */
export interface TrackBox { x: number; y: number; w: number; h: number }

export interface TrackOpts {
  /** Raio da janela de busca (px da análise, Chebyshev, em volta da previsão) com o rastreamento confiante. */
  searchPx: number
  /** Raio máximo da cobertura da perda; ausente = o lado maior do quadro (o quadro inteiro). */
  maxSearchPx?: number
  /** Crescimento da cobertura por quadro perdido. */
  growth: number
  /** Passo das sondas de escala (relativo à escala atual): s·(1 ± passo). A região leva meio passo de folga. */
  scaleStep: number
  /** Piso do 'weak' (âmbar, só no 1º quadro da perda: havia um pico plausível perto da previsão). */
  lostBelow: number
  /** Confiança mínima de um quadro 'ok' (verde). */
  okAbove: number
  /** Ambíguo: o 2º pico (fora da vizinhança do 1º) a menos disso do melhor → perda (R19). */
  ambiguityMargin: number
  /** Portão de movimento mínimo (px da análise): 'ok' até 2·gateMinPx + 2·|v| da previsão; o 1º quadro da perda é 'weak' só até gateMinPx. */
  gateMinPx: number
  /** Desvio-padrão mínimo do molde (níveis de cinza): abaixo disso a região é lisa demais para seguir. */
  minStd: number
}

export const DEFAULT_TRACK_OPTS: TrackOpts = { searchPx: 40, growth: 2, scaleStep: 0.03, lostBelow: 0.7, okAbove: 0.85, ambiguityMargin: 0.1, gateMinPx: 4, minStd: 3 }

export type TrackState = 'ok' | 'weak' | 'lost'

/**
 * Resultado de um quadro analisado: centro (px da análise; perdido = a última posição confiante, segurada), escala
 * estimada relativa ao molde e o intervalo das escalas empatadas [scaleLo, scaleHi], confiança (NCC, 0–1), estado e,
 * perdido, o raio da cobertura alcançada (o centro do conteúdo pode estar em qualquer ponto do quadrado ±reach).
 */
export interface TrackResult { tUs: Us; x: number; y: number; w: number; h: number; scale: number; scaleLo: number; scaleHi: number; confidence: number; state: TrackState; reach: number }

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

/**
 * Molde de uma escala: por nível da pirâmide (até o lado menor ficar < MIN_LEVEL_PX) e as células do nível 0 para o
 * teste de rigidez (células de ~CELL_PX; só as com textura contam).
 */
interface TplSet { scale: number; levels: Tpl[]; cells: { x: number; y: number; t: Tpl }[] }
const MIN_LEVEL_PX = 6
/** Lado mínimo do molde (px da análise). */
const MIN_TPL_PX = 8
/** Lado aproximado das células do teste de rigidez (px da análise). */
const CELL_PX = 16

function tplSet(patch: Plane, scale: number): TplSet {
  const base = scale === 1 ? patch : resize(patch, Math.max(MIN_LEVEL_PX, Math.round(patch.w * scale)), Math.max(MIN_LEVEL_PX, Math.round(patch.h * scale)))
  const levels: Tpl[] = [normalized(base)]
  let p = base
  while (Math.min(Math.floor(p.w / 2), Math.floor(p.h / 2)) >= MIN_LEVEL_PX && levels.length < 4) {
    p = half(p)
    levels.push(normalized(p))
  }
  // células de ~CELL_PX (3–6 colunas, 1–4 linhas): pequenas o bastante para caírem inteiras dentro do conteúdo
  const cols = Math.min(6, Math.max(3, Math.round(base.w / CELL_PX))), rows = Math.min(4, Math.max(1, Math.round(base.h / CELL_PX)))
  const cells: { x: number; y: number; t: Tpl }[] = []
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = Math.floor((i * base.w) / cols), y = Math.floor((j * base.h) / rows)
    const c = crop(base, x, y, Math.floor(((i + 1) * base.w) / cols) - x, Math.floor(((j + 1) * base.h) / rows) - y)
    if (c.w >= 4 && c.h >= 4 && std(c) >= RIGID_MIN_STD) cells.push({ x, y, t: normalized(c) })
  }
  return { scale, levels, cells }
}

// ---------------------------------------------------------------- rastreador

/** Estado do rastreador (imutável entre quadros: cada passo devolve um novo). */
export interface Tracker {
  readonly opts: TrackOpts
  readonly box: TrackBox
  /** Centro do molde (escala 1) no quadro inicial, px da análise; centro relatado = centro na imagem − (c0 − box). */
  readonly c0x: number
  readonly c0y: number
  /** Trecho original (escala 1) e o molde na escala atual. */
  readonly patch: Plane
  readonly set: TplSet
  /** Centro atual (perdido: o último confiante, segurado). */
  readonly pos: { x: number; y: number }
  readonly scale: number
  /** Movimento por quadro entre os dois últimos quadros 'ok' seguidos (px da análise); null = desconhecido. */
  readonly v: { x: number; y: number } | null
  /** Perdido (R21: até o fim do trecho) e o alcance da cobertura (raio, px da análise) do último quadro. */
  readonly lost: boolean
  readonly reach: number
}

/** Pico de NCC refinado no nível 0: canto (u, v) inteiro e centro na imagem (px da análise). */
interface Peak { u: number; v: number; ix: number; iy: number; s: number }

/** Candidatos do nível grosso refinados (os melhores até 0,3 abaixo do melhor): o 1º e os que podem empatar com ele. */
const MAX_CANDS = 5
const COARSE_SPREAD = 0.3
/** Passos da subida 3×3 em cada nível do refinamento. */
const HILL_STEPS = 4

/**
 * Picos de NCC do molde com o CENTRO na janela de raio r (Chebyshev) em volta de (icx, icy) — px da imagem da análise.
 * Pirâmide só da região da busca (custo proporcional à janela); busca exaustiva no nível grosso (a janela cabe em ~12
 * px nele), os MAX_CANDS melhores máximos locais refinados por subida 3×3 por nível até o nível 0 (só dentro da janela).
 * Saída ordenada pelo NCC, sem repetidos: um pico a menos de meio molde (nos dois eixos) de um melhor é o mesmo pico.
 * `L0`: o nível 0 do recorte (para o subpixel e as sondas de escala).
 */
function findPeaks(set: TplSet, img: GrayImage, icx: number, icy: number, r: number): { peaks: Peak[]; L0: Level | null } {
  const t0 = set.levels[0]
  if (t0.w > img.width || t0.h > img.height) return { peaks: [], L0: null }
  let top = 0
  while (top < set.levels.length - 1 && r / 2 ** top > 12) top++
  const k = 2 ** top
  const cu0 = icx - t0.w / 2, cv0 = icy - t0.h / 2
  const uMin = Math.max(0, Math.ceil(cu0 - r)), uMax = Math.min(img.width - t0.w, Math.floor(cu0 + r))
  const vMin = Math.max(0, Math.ceil(cv0 - r)), vMax = Math.min(img.height - t0.h, Math.floor(cv0 + r))
  if (uMin > uMax || vMin > vMax) return { peaks: [], L0: null }
  // recorte: janela + molde + margem do refinamento, do subpixel e das sondas de escala (moldes um pouco maiores)
  const m = 3 * k + 10
  const rx0 = Math.max(0, Math.floor((uMin - m) / k) * k), ry0 = Math.max(0, Math.floor((vMin - m) / k) * k)
  const rx1 = Math.min(img.width, uMax + t0.w + m + k), ry1 = Math.min(img.height, vMax + t0.h + m + k)
  const pyr = pyramid(crop({ w: img.width, h: img.height, d: img.data }, rx0, ry0, rx1 - rx0, ry1 - ry0), top, rx0, ry0)
  const T = set.levels[top], L = pyr[top]
  const gu0 = Math.max(L.ox, Math.floor(uMin / k)), gu1 = Math.min(L.ox + L.w - T.w, Math.ceil(uMax / k))
  const gv0 = Math.max(L.oy, Math.floor(vMin / k)), gv1 = Math.min(L.oy + L.h - T.h, Math.ceil(vMax / k))
  const gw = gu1 - gu0 + 1, gh = gv1 - gv0 + 1
  const coarse: { u: number; v: number; s: number }[] = []
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
        if (peak) coarse.push({ u: i + gu0, v: j + gv0, s })
      }
    }
  }
  coarse.sort((a, b) => b.s - a.s)
  const cands = coarse.filter((c, i) => i < MAX_CANDS && c.s >= (coarse[0]?.s ?? 0) - COARSE_SPREAD)
  const refined: Peak[] = []
  for (const c of cands) {
    let u = c.u, v = c.v, s = c.s
    for (let l = top - 1; l >= 0; l--) {
      const Tl = set.levels[l], Ll = pyr[l]
      const lo = l === 0 ? { u: uMin, v: vMin } : { u: Ll.ox, v: Ll.oy }
      const hi = l === 0 ? { u: uMax, v: vMax } : { u: Ll.ox + Ll.w - Tl.w, v: Ll.oy + Ll.h - Tl.h }
      if (lo.u > hi.u || lo.v > hi.v) { s = -Infinity; break }
      const seen = new Map<number, number>()
      const score = (uu: number, vv: number): number => {
        if (uu < lo.u || uu > hi.u || vv < lo.v || vv > hi.v) return -Infinity
        const key = vv * 65536 + uu
        let sc = seen.get(key)
        if (sc === undefined) seen.set(key, (sc = ncc(Ll, Tl, uu, vv)))
        return sc
      }
      let cu = Math.min(hi.u, Math.max(lo.u, 2 * u)), cv = Math.min(hi.v, Math.max(lo.v, 2 * v))
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
    if (s > -Infinity) refined.push({ u, v, ix: u + t0.w / 2, iy: v + t0.h / 2, s })
  }
  refined.sort((a, b) => b.s - a.s)
  const peaks: Peak[] = []
  for (const p of refined) if (!peaks.some((q) => Math.abs(q.u - p.u) < t0.w / 2 && Math.abs(q.v - p.v) < t0.h / 2)) peaks.push(p)
  return { peaks, L0: pyr[0] }
}

/** Pico com subpixel e escala estimada; [lo, hi] = escalas que a sonda não separa da estimada (incerteza não resolvida). */
interface Found { ix: number; iy: number; score: number; scale: number; lo: number; hi: number; set: TplSet }

/** Passos da subida em escala (cada um de scaleStep) por quadro, e o ganho de NCC mínimo para dar um passo. */
const SCALE_STEPS = 4
const SCALE_GAIN = 0.003

/**
 * Subpixel e escala do pico (R20): a escala sobe/desce em passos de scaleStep a partir da atual enquanto o NCC melhora
 * pelo menos SCALE_GAIN (até SCALE_STEPS; sem o ganho, fica — sem deriva: o molde reamostrado é um pouco mais suave e
 * uma estimativa contínua acumularia esse viés); o molde é refeito na escala escolhida e a posição achada de novo (±2
 * px, subpixel). As sondas vizinhas que ficam a menos de SCALE_GAIN da escolhida são incerteza não resolvida: [lo, hi]
 * (a região normal usa hi e o buraco do invertido usa lo, mais meio passo de folga em trackToKeys).
 */
function refinePeak(tr: Tracker, L0: Level, p: Peak): Found {
  const step = tr.opts.scaleStep
  const at = (u: number, v: number, t: Tpl): number | null => (u >= L0.ox && v >= L0.oy && u <= L0.ox + L0.w - t.w && v <= L0.oy + L0.h - t.h ? ncc(L0, t, u, v) : null)
  /** Melhor casamento do molde t centrado no centro do pico: subida 3×3 (até ±2 px). */
  const near = (t: Tpl): { u: number; v: number; s: number } => {
    const u0 = Math.round(p.ix - t.w / 2), v0 = Math.round(p.iy - t.h / 2)
    let bu = u0, bv = v0, bs = at(u0, v0, t) ?? -Infinity
    for (let step = 0; step < 2; step++) {
      let nu = bu, nv = bv, ns = bs
      for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) {
        if (!du && !dv) continue
        const sc = at(bu + du, bv + dv, t)
        if (sc !== null && sc > ns) { ns = sc; nu = bu + du; nv = bv + dv }
      }
      if (nu === bu && nv === bv) break
      bu = nu; bv = nv; bs = ns
    }
    return { u: bu, v: bv, s: bs }
  }
  const clampS = (x: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, x))
  const memo = new Map<number, number>()
  const evalS = (sc: number): number => {
    const key = Math.round(sc * 1e5)
    let r = memo.get(key)
    if (r === undefined) memo.set(key, (r = sc === tr.scale ? Math.max(p.s, near(tr.set.levels[0]).s) : near(tplLevel0(tr.patch, sc)).s))
    return r
  }
  let sc = tr.scale
  for (let i = 0; i < SCALE_STEPS; i++) {
    const c = evalS(sc), up = evalS(clampS(sc * (1 + step))), dn = evalS(clampS(sc * (1 - step)))
    if (up >= c + SCALE_GAIN && up >= dn) sc = clampS(sc * (1 + step))
    else if (dn >= c + SCALE_GAIN) sc = clampS(sc * (1 - step))
    else break
  }
  const best = evalS(sc)
  const tied = [clampS(sc * (1 - step)), sc, clampS(sc * (1 + step))].filter((x) => evalS(x) >= best - SCALE_GAIN)
  const set = sc === tr.scale ? tr.set : tplSet(tr.patch, sc)
  const t = set.levels[0]
  const b = near(t)
  const ix = b.u + subpix(at(b.u - 1, b.v, t), b.s, at(b.u + 1, b.v, t)) + t.w / 2
  const iy = b.v + subpix(at(b.u, b.v - 1, t), b.s, at(b.u, b.v + 1, t)) + t.h / 2
  return { ix, iy, score: b.s, scale: set.scale, lo: Math.min(...tied), hi: Math.max(...tied), set }
}

/** Vértice da parábola por três NCC vizinhos (−0,5…0,5); 0 sem os vizinhos ou sem máximo. */
function subpix(l: number | null, c: number, r: number | null): number {
  if (l === null || r === null) return 0
  const den = l - 2 * c + r
  return den < 0 ? Math.max(-0.5, Math.min(0.5, (l - r) / (2 * den))) : 0
}

/** Só o nível 0 do molde na escala s (sondas); memorizado por trecho original e escala (a escala muda pouco). */
const probeCache = new WeakMap<Plane, Map<number, Tpl>>()
function tplLevel0(patch: Plane, s: number): Tpl {
  let m = probeCache.get(patch)
  if (!m) probeCache.set(patch, (m = new Map()))
  const key = Math.round(s * 1e6)
  let t = m.get(key)
  if (!t) {
    if (m.size > 64) m.clear()
    m.set(key, (t = normalized(s === 1 ? patch : resize(patch, Math.max(MIN_LEVEL_PX, Math.round(patch.w * s)), Math.max(MIN_LEVEL_PX, Math.round(patch.h * s))))))
  }
  return t
}

/**
 * Resíduo (px) de uma célula com textura no ajuste translação + escala acima do qual ela discorda; não rígido = pelo
 * menos 2 células discordam (1 se houver ≤ 3) — uma célula sozinha pode errar o subpixel numa textura quase 1-D
 * (abertura).
 */
const RIGID_TOL_PX = 0.75
/** Textura mínima (desvio-padrão, níveis de cinza) para uma célula contar no teste de rigidez. */
const RIGID_MIN_STD = 6

/**
 * Rigidez (R19): cada célula com textura do molde é procurada (subida 3×3, até ±2 px) em volta do lugar que o
 * casamento dá a ela (subpixel). Os desvios d_i são ajustados por mínimos quadrados a d = a + k·r_i (translação a, variação de
 * escala k, r_i = centro da célula em relação ao centro do molde). Células que discordam (RIGID_TOL_PX) → não rígido:
 * dois movimentos dentro da região (folgada sobre fundo parado, conteúdo que muda por dentro) — nenhuma
 * translação/escala única cobre os dois, e o quadro é tratado como perda. Só decide; posição e escala ficam as de
 * refinePeak.
 */
function rigid(L0: Level, f: Found): boolean {
  const t = f.set.levels[0]
  const u0 = f.ix - t.w / 2, v0 = f.iy - t.h / 2
  const pts: { rx: number; ry: number; ox: number; oy: number }[] = []
  for (const c of f.set.cells) {
    const cu = Math.round(u0 + c.x), cv = Math.round(v0 + c.y)
    const fu = u0 + c.x - cu, fv = v0 + c.y - cv // posição esperada (subpixel) relativa ao inteiro
    const sc = (du: number, dv: number): number | null => {
      const u = cu + du, v = cv + dv
      return u >= L0.ox && v >= L0.oy && u <= L0.ox + L0.w - c.t.w && v <= L0.oy + L0.h - c.t.h ? ncc(L0, c.t, u, v) : null
    }
    // subida 3×3 a partir do lugar esperado (até ±2 px)
    let bu = 0, bv = 0, bs = sc(0, 0) ?? -Infinity
    for (let step = 0; step < 2; step++) {
      let nu = bu, nv = bv, ns = bs
      for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) {
        if (!du && !dv) continue
        const x = sc(bu + du, bv + dv)
        if (x !== null && x > ns) { ns = x; nu = bu + du; nv = bv + dv }
      }
      if (nu === bu && nv === bv) break
      bu = nu; bv = nv; bs = ns
    }
    if (bs === -Infinity) continue
    const ox = bu + subpix(sc(bu - 1, bv), bs, sc(bu + 1, bv)) - fu, oy = bv + subpix(sc(bu, bv - 1), bs, sc(bu, bv + 1)) - fv
    pts.push({ rx: c.x + c.t.w / 2 - t.w / 2, ry: c.y + c.t.h / 2 - t.h / 2, ox, oy })
  }
  if (pts.length === 0) return true
  const n = pts.length
  let mrx = 0, mry = 0, mox = 0, moy = 0
  for (const q of pts) { mrx += q.rx / n; mry += q.ry / n; mox += q.ox / n; moy += q.oy / n }
  let num = 0, den = 0
  for (const q of pts) {
    num += (q.rx - mrx) * (q.ox - mox) + (q.ry - mry) * (q.oy - moy)
    den += (q.rx - mrx) ** 2 + (q.ry - mry) ** 2
  }
  const k = den > 1e-9 ? num / den : 0
  const ax = mox - k * mrx, ay = moy - k * mry
  const off = pts.filter((q) => Math.hypot(q.ox - ax - k * q.rx, q.oy - ay - k * q.ry) > RIGID_TOL_PX).length
  return off < (n <= 3 ? 1 : 2)
}

const MIN_SCALE = 0.25, MAX_SCALE = 4

/** Começa o rastreamento no 1º quadro com o molde na caixa `box` (px da análise). EditError: região inválida. */
export function startTracker(first: GrayImage, box: TrackBox, tUs: Us, opts: Partial<TrackOpts> = {}): { tracker: Tracker; result: TrackResult } {
  const o: TrackOpts = { ...DEFAULT_TRACK_OPTS, ...opts }
  const x0 = Math.max(0, Math.round(box.x - box.w / 2)), y0 = Math.max(0, Math.round(box.y - box.h / 2))
  const x1 = Math.min(first.width, Math.round(box.x + box.w / 2)), y1 = Math.min(first.height, Math.round(box.y + box.h / 2))
  if (x1 - x0 < MIN_TPL_PX || y1 - y0 < MIN_TPL_PX) throw new EditError('invalid', 'A região é pequena demais (ou está fora do quadro) para seguir o conteúdo: aumente-a sobre o que deve ser escondido.')
  const patch = crop({ w: first.width, h: first.height, d: first.data }, x0, y0, x1 - x0, y1 - y0)
  if (std(patch) < o.minStd) throw new EditError('invalid', 'A região está sobre uma área lisa, sem detalhe para seguir: posicione-a sobre o conteúdo a esconder.')
  const tracker: Tracker = {
    opts: o, box, c0x: x0 + patch.w / 2, c0y: y0 + patch.h / 2, patch, set: tplSet(patch, 1),
    pos: { x: box.x, y: box.y }, scale: 1, v: null, lost: false, reach: 0
  }
  return { tracker, result: { tUs, x: box.x, y: box.y, w: box.w, h: box.h, scale: 1, scaleLo: 1, scaleHi: 1, confidence: 1, state: 'ok', reach: 0 } }
}

/**
 * Um quadro (rulings R19/R20/R21; ver o topo do arquivo): 'ok' só com confiança alta, sem ambiguidade, dentro do portão
 * de movimento e rígido. O primeiro quadro que não passa encerra o rastreamento confiante: dali até o fim do trecho a
 * posição fica segurada e a cobertura cresce (normal) / buraco nulo (invertido), sem recuperação automática.
 */
export function trackNext(tr: Tracker, img: GrayImage, tUs: Us): { tracker: Tracker; result: TrackResult } {
  const o = tr.opts
  const maxR = o.maxSearchPx ?? Math.max(img.width, img.height)
  const offX = tr.c0x - tr.box.x, offY = tr.c0y - tr.box.y
  const vx = tr.v?.x ?? 0, vy = tr.v?.y ?? 0, vlen = Math.hypot(vx, vy)
  const res = (x: number, y: number, scale: number, lo: number, hi: number, state: TrackState, reach: number, confidence: number): TrackResult => ({ tUs, x, y, w: tr.box.w * scale, h: tr.box.h * scale, scale, scaleLo: lo, scaleHi: hi, confidence, state, reach })
  const lose = (reach: number, conf: number, state: TrackState): { tracker: Tracker; result: TrackResult } => ({
    tracker: { ...tr, lost: true, reach },
    result: res(tr.pos.x, tr.pos.y, tr.scale, tr.scale, tr.scale, state, reach, conf)
  })

  // R21: perdido é até o fim do trecho — sem busca, sem recuperação; só a cobertura continua crescendo em volta da
  // última posição 'ok' (o conteúdo escondido pode estar andando)
  if (tr.lost) return lose(Math.min(maxR, tr.reach * o.growth), 0, 'lost')

  const px = tr.pos.x + vx, py = tr.pos.y + vy
  const { peaks, L0 } = findPeaks(tr.set, img, px + offX, py + offY, o.searchPx)
  const best = peaks[0]
  // a janela buscada é centrada na previsão: a cobertura da perda parte de lá (centro segurado + |v| + janela)
  const reach0 = Math.min(maxR, o.searchPx + Math.max(Math.abs(vx), Math.abs(vy)))
  if (!best || !L0) return lose(reach0, 0, 'lost')
  const f = refinePeak(tr, L0, best)
  const conf = Math.max(0, Math.min(1, f.score))
  const ambiguous = peaks.length > 1 && peaks[1].s >= best.s - o.ambiguityMargin
  const d = Math.hypot(f.ix - offX - px, f.iy - offY - py)
  const gate = tr.v ? 2 * o.gateMinPx + 2 * vlen : Infinity
  if (!ambiguous && conf >= o.okAbove && d <= gate && rigid(L0, f)) {
    const x = f.ix - offX, y = f.iy - offY
    // movimento recente: entre dois quadros 'ok' seguidos (sem perda no meio: R21)
    const v = { x: x - tr.pos.x, y: y - tr.pos.y }
    return { tracker: { ...tr, set: f.set, pos: { x, y }, scale: f.scale, v }, result: res(x, y, f.scale, f.lo, f.hi, 'ok', 0, f.score) }
  }
  // o 1º quadro da perda: âmbar se havia um pico plausível perto da previsão (abaixo do 'ok'), senão vermelho
  return lose(reach0, conf, !ambiguous && d <= o.gateMinPx && conf >= o.lostBelow ? 'weak' : 'lost')
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

/**
 * Projeto dos quadros de análise: o efeito (mesmo desativado, ou numa faixa oculta) entra no resolve para o corte. Faixa
 * oculta: só o efeito volta a aparecer — os outros itens dela continuam fora (não são desenhados de verdade).
 */
export function trackingProject(p: Project, fxId: string): Project {
  const f = findItem(p, fxId)
  if (!f || (f.item.enabled !== false && !f.track.hidden)) return p
  const fx = (({ enabled: _e, ...rest }) => rest)(f.item) as Item
  return {
    ...p,
    tracks: p.tracks.map((t, i) => {
      if (i !== f.trackIndex) return t
      return t.hidden ? { ...t, hidden: false, items: [fx] } : { ...t, items: t.items.map((it) => (it.id === fxId ? fx : it)) }
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
  /** Incerteza relativa da escala que vira folga (R20); padrão: meio passo das sondas (DEFAULT_TRACK_OPTS.scaleStep / 2). */
  scaleTol?: number
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

/**
 * Keys antigos antes de `a` (com um key exato em a − 1: a curva anterior não muda) + os novos. `edge`: valor do key de
 * a − 1 quando a fronteira precisa segurar o estado anterior (degrau conservador, ver conservativeEdge).
 */
function merged(prev: Anim<number>, a: Us, fresh: Keyframe<number>[], edge?: number): Anim<number> {
  let kept: Keyframe<number>[] = []
  if (a > 0) {
    const withEdge = prev.keys?.length ? insertKeyExact(prev, a - 1) : { ...prev, keys: [{ tUs: a - 1, value: prev.value, ease: 'linear' as const }] }
    kept = withEdge.keys!.filter((k) => k.tUs < a)
    if (kept.length) kept[kept.length - 1] = { ...kept[kept.length - 1], ease: 'linear', ...(edge !== undefined && kept[kept.length - 1].tUs === a - 1 ? { value: edge } : {}) }
  }
  const keys = [...kept, ...fresh]
  return { value: keys[0].value, keys }
}

/**
 * Fronteira de uma nova passada em `a` (o fluxo da R21: perdeu, o usuário reposiciona em `a` e roda de novo): a edição
 * em `a` faria o trecho [último key antes de a, a) interpolar do estado anterior até a caixa nova — o buraco nulo do
 * invertido "sairia do canto" crescendo fora do conteúdo. O estado do último key antes de `a` vale então até a − 1
 * (degrau conservador, como os da perda): invertido fechado → buraco nulo em a − 1; normal → a região de lá, se ela
 * contém a interpolada (ampliada). Senão (ou sem keys antes de a), a curva antiga fica como estava. null = nada a mudar.
 */
function conservativeEdge(fx: EffectItem, a: Us, W: number, H: number): RegionValues | null {
  if (a <= 0) return null
  const r = fx.region
  let kPrev = -1
  for (const an of [r.x, r.y, r.w, r.h]) for (const k of an.keys ?? []) if (k.tUs < a - 1 && k.tUs > kPrev) kPrev = k.tUs
  if (kPrev < 0) return null
  const prev = valuesAt(r, kPrev), edge = valuesAt(r, a - 1)
  if (fx.invert) return Math.abs(prev.w) > 0 && Math.abs(prev.h) > 0 ? null : NO_HOLE
  // retângulo/elipse de mesma rotação e forma: contém se, no referencial dela, a outra cabe nas meias-larguras
  const th = (prev.rotation * Math.PI) / 180
  const dx = (edge.x - prev.x) * W, dy = (edge.y - prev.y) * H
  const lx = Math.abs(Math.cos(th) * dx + Math.sin(th) * dy), ly = Math.abs(-Math.sin(th) * dx + Math.cos(th) * dy)
  const k = r.shape === 'ellipse' ? Math.SQRT2 : 1
  const fits = edge.rotation === prev.rotation && lx * k + (Math.abs(edge.w) * W) / 2 <= (Math.abs(prev.w) * W) / 2 && ly * k + (Math.abs(edge.h) * H) / 2 <= (Math.abs(prev.h) * H) / 2
  return fits ? prev : null
}

/** Resultado do rastreamento → região com keys (ver o topo do arquivo: R4, R4b, degraus e mescla). */
export function trackToKeys(fx: EffectItem, input: readonly TrackResult[], g: TrackGeometry, o: TrackKeysOpts = {}): TrackKeysResult {
  if (fx.attach) throw new EditError('invalid', TRACK_ATTACHED_MESSAGE)
  if (input.length === 0) return { region: fx.region, lost: [], samples: [] }
  // R21: a partir do primeiro quadro que não é 'ok', tudo é perda até o fim, mesmo se a entrada disser outra coisa —
  // posição e escala do primeiro quadro perdido (a última 'ok', segurada) e cobertura que nunca diminui
  let firstBad = input.findIndex((r) => r.state !== 'ok')
  if (firstBad < 0) firstBad = input.length
  const results: TrackResult[] = input.slice(0, firstBad + 1)
  for (let i = firstBad + 1; i < input.length; i++) {
    const held = results[firstBad], prev = results[i - 1]
    results.push({ ...held, tUs: input[i].tUs, confidence: input[i].confidence, state: 'lost', reach: Math.max(input[i].reach, prev.reach) })
  }
  const W = g.canvasW, H = g.canvasH
  const kx = W / g.analysisW, ky = H / g.analysisH
  const unit = Math.max(kx, ky) // 1 px da análise no quadro
  const scaleTol = o.scaleTol ?? DEFAULT_TRACK_OPTS.scaleStep / 2
  const shape = fx.region.shape
  const a = results[0].tUs - fx.startUs
  const R0 = valuesAt(fx.region, a)
  const r0 = results[0]
  const n = results.length
  const conf = (i: number): boolean => i >= 0 && i < n && i < firstBad
  // escala do tamanho: a maior das empatadas (normal, cobre mais) / a menor (invertido, buraco menor) — R20
  const sz = (r: TrackResult): number => (fx.invert ? (r.scaleLo ?? r.scale) : (r.scaleHi ?? r.scale))
  const placed = (r: TrackResult): RegionValues => ({ x: R0.x + (r.x - r0.x) / g.analysisW, y: R0.y + (r.y - r0.y) / g.analysisH, w: R0.w * sz(r), h: R0.h * sz(r), rotation: R0.rotation })
  const halfMax = (v: RegionValues): number => Math.max(Math.abs(v.w) * W, Math.abs(v.h) * H) / 2
  // movimento da borda entre dois quadros: o do centro + o da mudança de escala
  const disp = (p: TrackResult, q: TrackResult): number => Math.hypot((p.x - q.x) * kx, (p.y - q.y) * ky) + Math.abs(sz(p) - sz(q)) * halfMax(R0)
  const D: number[] = []
  const vals: RegionValues[] = []
  for (let i = 0; i < n; i++) {
    const r = results[i]
    const base = placed(r)
    let d: number
    if (conf(i)) {
      const neigh = Math.max(conf(i - 1) ? disp(r, results[i - 1]) : 0, conf(i + 1) ? disp(r, results[i + 1]) : 0)
      d = unit + neigh + scaleTol * halfMax(base)
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
      // degrau conservador sempre que houver um instante inteiro entre os dois quadros (tp + 1 ≤ t − 1)
      if (t - tp >= 2) {
        if (fx.invert) samples.push(kind(i) === 'closed' ? { t: tp + 1, v: NO_HOLE } : { t: t - 1, v: NO_HOLE })
        else if (kind(i) === 'grown') samples.push({ t: tp + 1, v: vals[i] })
        // (perda → 'ok' não acontece: R21, perdido até o fim)
      }
    }
    samples.push({ t, v: vals[i] })
  }
  const keysOf = (c: 'x' | 'y' | 'w' | 'h'): Keyframe<number>[] => samples.map((s) => ({ tUs: s.t, value: s.v[c], ease: 'linear' }))
  const r = fx.region
  const rotation = (r.rotation.keys ?? []).some((k) => k.tUs >= a) ? merged(r.rotation, a, [{ tUs: a, value: R0.rotation, ease: 'linear' }]) : r.rotation
  const edge = conservativeEdge(fx, a, W, H)
  const region: EffectRegion = { shape, x: merged(r.x, a, keysOf('x'), edge?.x), y: merged(r.y, a, keysOf('y'), edge?.y), w: merged(r.w, a, keysOf('w'), edge?.w), h: merged(r.h, a, keysOf('h'), edge?.h), rotation }
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

/** Toast da perda (instante absoluto da timeline; R21: vale até o fim do trecho rastreado). */
export function lossMessage(l: { tUs: Us }, invert: boolean): string {
  return `Rastreamento perdido em ${formatTrackTime(l.tUs)} — ${invert ? 'o buraco foi fechado' : 'a região foi ampliada'} até o fim; reposicione e use “Seguir conteúdo” de novo a partir daí`
}
