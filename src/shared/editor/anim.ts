import type { Anim, Ease, Keyframe, Us } from './project'

/** Bezier cúbico estilo CSS cubic-bezier: Newton-Raphson (8 iterações) com bisseção de reserva. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const sx = (t: number): number => ((ax * t + bx) * t + cx) * t
  const sy = (t: number): number => ((ay * t + by) * t + cy) * t
  const dx = (t: number): number => (3 * ax * t + 2 * bx) * t + cx
  let t = x
  for (let i = 0; i < 8; i++) {
    const err = sx(t) - x
    if (Math.abs(err) < 1e-7) return sy(t)
    const d = dx(t)
    if (Math.abs(d) < 1e-6) break
    t -= err / d
  }
  let lo = 0, hi = 1
  t = x
  for (let i = 0; i < 40; i++) {
    const v = sx(t)
    if (Math.abs(v - x) < 1e-7) break
    if (x > v) lo = t
    else hi = t
    t = (hi - lo) / 2 + lo
  }
  return sy(t)
}

/** p∈[0,1] → [0,1]; 'hold' fica em 0 até p<1. */
export function easeValue(ease: Ease, p: number): number {
  if (p <= 0) return 0
  if (p >= 1) return 1
  if (typeof ease === 'object') return cubicBezier(ease.bezier[0], ease.bezier[1], ease.bezier[2], ease.bezier[3], p)
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

/** Mantém keys em [from,to], reancora em 0 e insere keys de borda avaliados se houver keys fora. */
export function sliceKeys(a: Anim<number>, fromUs: Us, toUs: Us): Anim<number> {
  const k = a.keys
  if (!k || k.length === 0) return a
  const inside = k.filter((x) => x.tUs >= fromUs && x.tUs <= toUs)
  const out: Keyframe<number>[] = inside.map((x) => ({ ...x, tUs: x.tUs - fromUs }))
  const before = k.filter((x) => x.tUs < fromUs)
  if (before.length > 0 && !inside.some((x) => x.tUs === fromUs)) {
    out.unshift({ tUs: 0, value: evalAnim(a, fromUs), ease: before[before.length - 1].ease })
  }
  if (k.some((x) => x.tUs > toUs) && !inside.some((x) => x.tUs === toUs)) {
    out.push({ tUs: toUs - fromUs, value: evalAnim(a, toUs), ease: 'linear' })
  }
  if (out.length === 0) return { value: evalAnim(a, fromUs) }
  return { ...a, keys: out }
}
