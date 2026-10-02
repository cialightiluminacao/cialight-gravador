import type { Anim, Ease, Keyframe, Us } from './project'

type Bez = [number, number, number, number]
const bx = (b: Bez, t: number): number => { const c = 3 * b[0], e = 3 * (b[2] - b[0]) - c; return (((1 - c - e) * t + e) * t + c) * t }
const by = (b: Bez, t: number): number => { const c = 3 * b[1], e = 3 * (b[3] - b[1]) - c; return (((1 - c - e) * t + e) * t + c) * t }

/** Parâmetro t da curva com x(t) = x: Newton-Raphson (8 iterações) com bisseção de reserva. */
function bezierT(b: Bez, x: number): number {
  const cx = 3 * b[0], ex = 3 * (b[2] - b[0]) - cx, ax = 1 - cx - ex
  const dx = (t: number): number => (3 * ax * t + 2 * ex) * t + cx
  let t = x
  for (let i = 0; i < 8; i++) {
    const err = bx(b, t) - x
    if (Math.abs(err) < 1e-7) return t
    const d = dx(t)
    if (Math.abs(d) < 1e-6) break
    t -= err / d
  }
  let lo = 0, hi = 1
  t = x
  for (let i = 0; i < 40; i++) {
    const v = bx(b, t)
    if (Math.abs(v - x) < 1e-7) break
    if (x > v) lo = t
    else hi = t
    t = (hi - lo) / 2 + lo
  }
  return t
}

/** Bezier cúbico estilo CSS cubic-bezier. */
const cubicBezier = (b: Bez, x: number): number => by(b, bezierT(b, x))

/** p∈[0,1] → [0,1]; 'hold' fica em 0 até p<1. */
export function easeValue(ease: Ease, p: number): number {
  if (p <= 0) return 0
  if (p >= 1) return 1
  if (typeof ease === 'object') return cubicBezier(ease.bezier, p)
  switch (ease) {
    case 'hold': return 0
    case 'in': return p * p * p
    case 'out': return 1 - Math.pow(1 - p, 3)
    case 'inOut': return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2
    default: return p
  }
}

export function hasKeys(a: Anim<number>): boolean {
  return !!a.keys && a.keys.length > 0
}

/** Sem keys → value; antes do 1º → 1º; depois do último → último; entre → ease do key anterior. */
export function evalAnim(a: Anim<number>, tUs: Us): number {
  const k = a.keys
  if (!k || k.length === 0) return a.value
  if (tUs <= k[0].tUs) return k[0].value
  const last = k[k.length - 1]
  if (tUs >= last.tUs) return last.value
  let i = 0
  while (i < k.length - 2 && tUs >= k[i + 1].tUs) i++
  const k0 = k[i], k1 = k[i + 1]
  const p = (tUs - k0.tUs) / (k1.tUs - k0.tUs)
  return k0.value + (k1.value - k0.value) * easeValue(k0.ease, p)
}

/** Substitui o key a ±1 µs (se existir) e mantém a ordem. */
export function setKey(a: Anim<number>, tUs: Us, value: number, ease: Ease = 'linear'): Anim<number> {
  const rest = (a.keys ?? []).filter((k) => Math.abs(k.tUs - tUs) > 1)
  const keys = [...rest, { tUs, value, ease }].sort((p, q) => p.tUs - q.tUs)
  return { ...a, keys }
}

/** Remove o key a ±1 µs; se ficar vazio, vira constante com o valor removido. */
export function removeKey(a: Anim<number>, tUs: Us): Anim<number> {
  if (!a.keys) return a
  const removed = a.keys.find((k) => Math.abs(k.tUs - tUs) <= 1)
  if (!removed) return a
  const keys = a.keys.filter((k) => k !== removed)
  return keys.length === 0 ? { value: removed.value } : { ...a, keys }
}

/** Sem keys altera o valor base; com keys grava key em tUs (preservando o ease existente). */
export function setValue(a: Anim<number>, tUs: Us, value: number): Anim<number> {
  if (!hasKeys(a)) return { ...a, value }
  const existing = a.keys!.find((k) => Math.abs(k.tUs - tUs) <= 1)
  return setKey(a, tUs, value, existing?.ease ?? 'linear')
}

export function shiftKeys<T>(a: Anim<T>, deltaUs: Us): Anim<T> {
  if (!a.keys) return a
  return { ...a, keys: a.keys.map((k): Keyframe<T> => ({ ...k, tUs: k.tUs + deltaUs })) }
}


// ---------------------------------------------------------------- corte exato de curvas

/** Ponto de controle de uma curva de Bézier (x, y). */
type Pt = [number, number]
const lerpPt = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
/** De Casteljau: as duas metades da curva [p0..p3] cortada no parâmetro t. */
function splitBez(p: Pt[], t: number): [Pt[], Pt[]] {
  const a = lerpPt(p[0], p[1], t), b = lerpPt(p[1], p[2], t), c = lerpPt(p[2], p[3], t)
  const d = lerpPt(a, b, t), e = lerpPt(b, c, t), f = lerpPt(d, e, t)
  return [[p[0], a, d, f], [f, e, c, p[3]]]
}
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/** Pedaço [u0,u1] (parâmetro) do bezier renormalizado; ok = os controles x ficam em [0,1] (o pedaço é exato). */
function bezierPiece(b: Bez, u0: number, u1: number): { bezier: Bez; ok: boolean } | 'flat' {
  let seg: Pt[] = [[0, 0], [b[0], b[1]], [b[2], b[3]], [1, 1]]
  if (u0 > 0) seg = splitBez(seg, u0)[1]
  if (u1 < 1) seg = splitBez(seg, (u1 - u0) / (1 - u0))[0]
  const [x0, y0] = seg[0], [x3, y3] = seg[3]
  if (Math.abs(y3 - y0) < 1e-12) {
    // pontas com o mesmo y: constante se os controles também estão lá; senão não há renormalização (não exato)
    return Math.abs(seg[1][1] - y0) < 1e-12 && Math.abs(seg[2][1] - y0) < 1e-12 ? 'flat' : { bezier: b, ok: false }
  }
  if (!(x3 - x0 > 1e-12)) return { bezier: b, ok: false }
  const nx = (x: number): number => (x - x0) / (x3 - x0)
  const ny = (y: number): number => (y - y0) / (y3 - y0)
  const X1 = nx(seg[1][0]), X2 = nx(seg[2][0])
  const ok = X1 >= -1e-9 && X1 <= 1 + 1e-9 && X2 >= -1e-9 && X2 <= 1 + 1e-9
  return { bezier: [clamp01(X1), ny(seg[1][1]), clamp01(X2), ny(seg[2][1])], ok }
}

/**
 * Parâmetros internos (u) onde cortar [u0,u1] para cada pedaço ser exato como bezier de x em [0,1]. Com x1 > x2 o
 * x(u) quase para no meio e um pedaço que o cruza teria controles fora de [0,1] (aproximação ruim): corta na
 * inflexão de x(u) e, se preciso, ao meio, recursivamente. Pedaço com pontas no mesmo y também é cortado.
 */
function bezierBreaksU(b: Bez, u0: number, u1: number, depth = 0): number[] {
  const r = bezierPiece(b, u0, u1)
  if (r === 'flat' || r.ok || depth >= 24 || u1 - u0 < 1e-9) return []
  const cx = 3 * b[0], ex = 3 * (b[2] - b[0]) - cx, ax = 1 - cx - ex
  let um = ax !== 0 ? -ex / (3 * ax) : NaN // x''(u) = 0
  if (!(um > u0 + 1e-9 && um < u1 - 1e-9)) um = (u0 + u1) / 2
  return [...bezierBreaksU(b, u0, um, depth + 1), um, ...bezierBreaksU(b, um, u1, depth + 1)]
}

/**
 * Ease do pedaço [p0,p1] (0 ≤ p0 < p1 ≤ 1) de um trecho com `e`, renormalizado para [0,1] nos dois eixos: o trecho
 * cortado ali, com os valores das pontas, reproduz a curva original. Exato para linear, hold, in, out e para cada
 * metade de inOut (polinômios cúbicos viram bezier com x em terços). Bezier: exato quando os controles do pedaço
 * ficam em [0,1] — senão (x1 > x2 cruzando o meio, ou pontas com o mesmo y) é aproximado; insertKeyExact evita esses
 * pedaços cortando antes (bezierBreaksU). Um pedaço de inOut que cruza o meio também é aproximado (idem).
 */
export function subEase(e: Ease, p0: number, p1: number): Ease {
  if (e === 'linear' || e === 'hold' || (p0 <= 0 && p1 >= 1)) return e
  if (typeof e === 'object') {
    const b = e.bezier
    const r = bezierPiece(b, p0 <= 0 ? 0 : bezierT(b, p0), p1 >= 1 ? 1 : bezierT(b, p1))
    // pedaço plano: valores iguais nas pontas e no meio, qualquer curva serve
    if (r === 'flat') return 'linear'
    return r.ok ? { bezier: r.bezier } : r.bezier === b ? e : { bezier: r.bezier }
  }
  // polinômio cúbico g no pedaço: f(q) = (g(p0 + d·q) − g(p0)) / (g(p1) − g(p0)) = c1·q + c2·q² + (1 − c1 − c2)·q³,
  // que é o bezier [1/3, c1/3, 2/3, (c2 + 2·c1)/3] (x em terços ⇒ x(u) = u); c1 e c2 saem de f(1/3) e f(2/3)
  const g0 = easeValue(e, p0), g1 = easeValue(e, p1)
  if (Math.abs(g1 - g0) < 1e-12) return e
  const f = (q: number): number => (easeValue(e, p0 + (p1 - p0) * q) - g0) / (g1 - g0)
  const A1 = 27 * f(1 / 3) - 1, A2 = 27 * f(2 / 3) - 8
  const c1 = (2 * A1 - A2) / 6, c2 = (A1 - 8 * c1) / 2
  return { bezier: [1 / 3, c1 / 3, 2 / 3, (c2 + 2 * c1) / 3] }
}

/** Insere o key na posição pelo tempo (sem tirar vizinhos a ±1 µs, ao contrário de setKey). */
function insertAt<T>(keys: Keyframe<T>[], key: Keyframe<T>): Keyframe<T>[] {
  const i = keys.findIndex((k) => k.tUs > key.tUs)
  return i < 0 ? [...keys, key] : [...keys.slice(0, i), key, ...keys.slice(i)]
}

/**
 * Key novo em tUs sem mudar a curva: o valor é o avaliado ali e o trecho que o contém é repartido em pedaços exatos
 * (subEase). inOut é cortado no meio antes (cada metade é uma cúbica só); bezier ganha keys extras onde um pedaço não
 * seria exato (bezierBreaksU: x1 > x2, pontas com o mesmo y). Já existe key exatamente em tUs ou não há keys → igual.
 * Antes do 1º / depois do último: key com o valor da ponta (trecho constante).
 */
export function insertKeyExact(a: Anim<number>, tUs: Us): Anim<number> {
  const k = a.keys
  if (!k || k.length === 0 || k.some((x) => x.tUs === tUs)) return a
  const value = evalAnim(a, tUs)
  if (tUs < k[0].tUs || tUs > k[k.length - 1].tUs) return { ...a, keys: insertAt(k, { tUs, value, ease: 'linear' }) }
  const i = k.findIndex((x) => x.tUs > tUs) - 1
  const k0 = k[i], k1 = k[i + 1]
  const span = k1.tUs - k0.tUs
  if (k0.ease === 'inOut') {
    const mid = k0.tUs + Math.round(span / 2)
    if (mid > k0.tUs && mid < k1.tUs && mid !== tUs) return insertKeyExact(insertKeyExact(a, mid), tUs)
  }
  const p = (tUs - k0.tUs) / span
  // instantes (µs inteiros) que repartem o trecho: tUs e, no bezier, os cortes extras dos dois pedaços
  const cuts = new Set<Us>([tUs])
  if (typeof k0.ease === 'object') {
    const b = k0.ease.bezier, up = bezierT(b, p)
    for (const u of [...bezierBreaksU(b, 0, up), ...bezierBreaksU(b, up, 1)]) {
      const t = k0.tUs + Math.round(bx(b, u) * span)
      if (t > k0.tUs && t < k1.tUs) cuts.add(t)
    }
  }
  const times = [k0.tUs, ...[...cuts].sort((x, y) => x - y), k1.tUs]
  const pieces: Keyframe<number>[] = []
  for (let j = 0; j < times.length - 1; j++) {
    const ease = subEase(k0.ease, (times[j] - k0.tUs) / span, (times[j + 1] - k0.tUs) / span)
    pieces.push(j === 0 ? { ...k0, ease } : { tUs: times[j], value: times[j] === tUs ? value : evalAnim(a, times[j]), ease })
  }
  return { ...a, keys: [...k.slice(0, i), ...pieces, ...k.slice(i + 1)] }
}

/**
 * Mantém keys em [from,to] e reancora em 0. Havendo keys fora, a borda ganha um key exato (insertKeyExact): valor
 * contínuo e forma da curva preservada — dividir um item não muda a animação.
 */
export function sliceKeys(a: Anim<number>, fromUs: Us, toUs: Us): Anim<number> {
  const k = a.keys
  if (!k || k.length === 0) return a
  let b = a
  if (k.some((x) => x.tUs < fromUs)) b = insertKeyExact(b, fromUs)
  if (k.some((x) => x.tUs > toUs)) b = insertKeyExact(b, toUs)
  const out = b.keys!.filter((x) => x.tUs >= fromUs && x.tUs <= toUs).map((x) => ({ ...x, tUs: x.tUs - fromUs }))
  if (out.length === 0) return { value: evalAnim(a, fromUs) }
  return { ...a, keys: out }
}

// ---------------------------------------------------------------- ease por key, copiar/colar

/** Troca o ease do key a ±1 µs de tUs (o do trecho que começa nele); sem key → igual. */
export function setEase(a: Anim<number>, tUs: Us, ease: Ease): Anim<number> {
  const key = a.keys?.find((k) => Math.abs(k.tUs - tUs) <= 1)
  if (!key) return a
  return { ...a, keys: a.keys!.map((k) => (k === key ? { ...k, ease } : k)) }
}

/** Ease do key a ±1 µs de tUs; senão o do trecho que contém tUs; null fora dos keys (ou sem keys). */
export function easeAt(a: Anim<number>, tUs: Us): Ease | null {
  const k = a.keys ?? []
  const at = k.find((x) => Math.abs(x.tUs - tUs) <= 1)
  if (at) return at.ease
  const i = k.findIndex((x) => x.tUs > tUs)
  return i > 0 ? k[i - 1].ease : null
}

/** Keys em [fromUs,toUs] com o tempo relativo a fromUs (área de transferência). */
export function copyKeys(a: Anim<number>, fromUs: Us, toUs: Us): Keyframe<number>[] {
  return (a.keys ?? []).filter((k) => k.tUs >= fromUs && k.tUs <= toUs).map((k) => ({ ...k, tUs: k.tUs - fromUs }))
}

/**
 * Cola keys (tempos relativos) a partir de atUs, presos a [0, maxUs]: os tempos relativos são mantidos e o que cair
 * fora é cortado com um key de borda exato (valor e forma da curva colada naquele ponto, sem salto). Os keys
 * existentes dentro do trecho colado (±1 µs) saem; os de fora ficam.
 */
export function pasteKeys(a: Anim<number>, keys: readonly Keyframe<number>[], atUs: Us, maxUs: Us): Anim<number> {
  if (keys.length === 0) return a
  const shifted = keys.map((k) => ({ ...k, tUs: Math.round(atUs + k.tUs) })).sort((x, y) => x.tUs - y.tUs)
  let pasted: Anim<number> = { value: shifted[0].value, keys: shifted }
  if (shifted.some((k) => k.tUs < 0)) pasted = insertKeyExact(pasted, 0)
  if (shifted.some((k) => k.tUs > maxUs)) pasted = insertKeyExact(pasted, maxUs)
  const inside = pasted.keys!.filter((k) => k.tUs >= 0 && k.tUs <= maxUs)
  if (inside.length === 0) return a
  const lo = inside[0].tUs, hi = inside[inside.length - 1].tUs
  const kept = (a.keys ?? []).filter((k) => k.tUs < lo - 1 || k.tUs > hi + 1)
  return { ...a, keys: [...kept, ...inside].sort((x, y) => x.tUs - y.tUs) }
}

/**
 * Instantes (µs, ordenados, sem repetição) para seguir a curva com segmentos lineares: os keys e, nos trechos não
 * lineares, pontos internos a cada ~maxStepUs (no mínimo 8 e no máximo 64 por trecho); 'hold' ganha o ponto 1 µs
 * antes do key seguinte (degrau). Sem keys → [].
 */
export function curveSampleTimesUs(a: Anim<number>, maxStepUs: Us): Us[] {
  const k = a.keys ?? []
  const out: Us[] = []
  for (let i = 0; i < k.length; i++) {
    out.push(k[i].tUs)
    const n = k[i + 1]
    if (!n) break
    const span = n.tUs - k[i].tUs
    const e = k[i].ease
    if (e === 'linear' || span < 2) continue
    if (e === 'hold') {
      out.push(n.tUs - 1)
      continue
    }
    const steps = Math.min(span, 64, Math.max(8, Math.ceil(span / maxStepUs)))
    for (let j = 1; j < steps; j++) out.push(k[i].tUs + Math.round((span * j) / steps))
  }
  return out.filter((t, i) => i === 0 || t > out[i - 1])
}
